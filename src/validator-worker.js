import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readdir, rename, stat, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import {
  MediaRejectedError,
  MediaValidationSystemError,
  runBoundedProcess,
  validateMediaFile
} from './media-validator.js';

function storagePath(root, storageName) {
  if (typeof storageName !== 'string' || path.basename(storageName) !== storageName) {
    throw new MediaValidationSystemError('数据库中的媒体文件名无效', 'INVALID_STORAGE_RECORD');
  }
  return path.join(root, storageName);
}

async function removeIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function removeOldUntrackedFiles(directory, {
  trackedNames = new Set(),
  cutoffMs,
  suffix
} = {}) {
  if (!directory) return 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || trackedNames.has(entry.name) || (suffix && !entry.name.endsWith(suffix))) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs >= cutoffMs) continue;
      await unlink(filePath);
      removed += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

export async function cleanupOrphanedUploads(database, config, nowDate = new Date()) {
  const trackedNames = new Set(database.listVideoStorageNames?.() ?? []);
  // A grace period avoids racing the application's rename-then-database-insert
  // window. Public media is deliberately never removed by this maintenance.
  const pendingGraceMs = Math.max(10 * 60_000, config.mediaValidationPollMs * 20);
  const pendingRemoved = await removeOldUntrackedFiles(config.pendingStoragePath, {
    trackedNames,
    cutoffMs: nowDate.getTime() - pendingGraceMs
  });
  const temporaryRemoved = await removeOldUntrackedFiles(config.temporaryStoragePath, {
    cutoffMs: nowDate.getTime() - 60 * 60_000,
    suffix: '.upload'
  });
  const coverRemoved = await removeOldUntrackedFiles(config.coverStoragePath, {
    trackedNames: new Set(database.listCoverStorageNames?.() ?? []),
    cutoffMs: nowDate.getTime() - 60 * 60_000
  });
  return pendingRemoved + temporaryRemoved + coverRemoved;
}

export async function generateFirstFrameCover(filePath, config) {
  const storageName = `${crypto.randomUUID()}.jpg`;
  const outputPath = storagePath(config.coverStoragePath, storageName);
  const result = await runBoundedProcess(config.ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', filePath,
    '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
    '-q:v', '2', outputPath
  ], { timeoutMs: 60_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024 });
  if (result.timedOut || result.signal || result.code !== 0) {
    await removeIfPresent(outputPath);
    throw new MediaValidationSystemError('无法从视频第一帧生成封面', 'COVER_GENERATION_FAILED', {
      exitCode: result.code,
      signal: result.signal
    });
  }
  const outputStat = await stat(outputPath);
  if (!outputStat.isFile() || outputStat.size < 24) {
    await removeIfPresent(outputPath);
    throw new MediaValidationSystemError('生成的封面文件无效', 'COVER_GENERATION_INVALID');
  }
  return { storageName, mediaType: 'image/jpeg', source: 'generated' };
}

export async function backfillMissingCovers(database, config, {
  generateCover = generateFirstFrameCover
} = {}) {
  if (typeof database.listVideosMissingCover !== 'function' || typeof database.setVideoCover !== 'function') return 0;
  let completed = 0;
  for (const video of database.listVideosMissingCover()) {
    try {
      const filePath = storagePath(config.videoStoragePath, video.storageName);
      const cover = await generateCover(filePath, config);
      if (database.setVideoCover(video.id, cover) === 1) completed += 1;
    } catch (error) {
      console.warn(`旧视频封面补全失败：${video.id} (${error.code || error.message})`);
    }
  }
  return completed;
}

function existingCandidate(pendingPath, finalPath) {
  if (fs.existsSync(pendingPath)) return pendingPath;
  if (fs.existsSync(finalPath)) return finalPath;
  throw new MediaValidationSystemError('待验证媒体文件不存在', 'PENDING_MEDIA_MISSING');
}

export async function processNextValidation(database, config, {
  validate = validateMediaFile,
  generateCover = generateFirstFrameCover,
  now = () => new Date()
} = {}) {
  const startedAt = now().toISOString();
  const video = database.claimNextVideoForValidation(startedAt);
  if (!video) return false;

  const pendingPath = storagePath(config.pendingStoragePath, video.storageName);
  const finalPath = storagePath(config.videoStoragePath, video.storageName);
  let candidatePath;
  try {
    candidatePath = existingCandidate(pendingPath, finalPath);
    const result = await validate(candidatePath, video.mediaType, config);
    let generatedCover = null;
    if (!video.coverStorageName && typeof database.setVideoCover === 'function') {
      generatedCover = await generateCover(candidatePath, config);
    }
    if (candidatePath === pendingPath) await rename(pendingPath, finalPath);
    if (generatedCover) database.setVideoCover(video.id, generatedCover);
    const changed = database.completeVideoValidation(video.id, result, now().toISOString());
    if (changed !== 1) {
      throw new MediaValidationSystemError('验证完成时数据库状态已改变', 'VALIDATION_STATE_CONFLICT');
    }
    console.log(`媒体验证通过：${video.id} (${result.videoCodec}/${result.audioCodec ?? 'silent'}, ${result.warningCount} warnings)`);
  } catch (error) {
    const finishedAt = now().toISOString();
    if (error instanceof MediaRejectedError) {
      await removeIfPresent(candidatePath ?? pendingPath);
      if (candidatePath === finalPath) await removeIfPresent(finalPath);
      if (video.coverStorageName && config.coverStoragePath) {
        await removeIfPresent(storagePath(config.coverStoragePath, video.coverStorageName));
      }
      database.rejectVideoValidation(video.id, error.summary, finishedAt);
      console.warn(`媒体验证拒绝：${video.id} (${error.code})`);
      return true;
    }
    const systemError = error instanceof MediaValidationSystemError
      ? error
      : new MediaValidationSystemError('媒体验证发生内部错误', 'VALIDATION_INTERNAL_ERROR', {
        cause: error?.message || String(error)
      });
    database.failVideoValidation(video.id, systemError.summary, finishedAt);
    console.error(`媒体验证暂时失败：${video.id} (${systemError.code})`);
  }
  return true;
}

export async function runValidatorWorker({
  config = loadConfig(),
  database = openDatabase(config.databasePath),
  once = false,
  now = () => new Date()
} = {}) {
  fs.mkdirSync(config.videoStoragePath, { recursive: true });
  fs.mkdirSync(config.pendingStoragePath, { recursive: true });
  if (config.coverStoragePath) fs.mkdirSync(config.coverStoragePath, { recursive: true });
  const startupTime = now();
  const orphanCount = await cleanupOrphanedUploads(database, config, startupTime);
  if (orphanCount > 0) console.warn(`已清理 ${orphanCount} 个中断上传留下的隔离文件`);
  const cutoff = new Date(startupTime.getTime() - config.mediaValidationStaleMs).toISOString();
  const recovered = database.resetStaleValidations(cutoff) + database.retryFailedValidations();
  if (recovered > 0) console.log(`已恢复 ${recovered} 个未完成的媒体验证任务`);
  const coversBackfilled = await backfillMissingCovers(database, config);
  if (coversBackfilled > 0) console.log(`已为 ${coversBackfilled} 个既有视频补全第一帧封面`);
  const staleSweepIntervalMs = Math.min(60_000, Math.max(1_000, config.mediaValidationPollMs * 10));
  let nextStaleSweepAt = startupTime.getTime() + staleSweepIntervalMs;

  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      const loopTime = now();
      if (loopTime.getTime() >= nextStaleSweepAt) {
        const staleCutoff = new Date(loopTime.getTime() - config.mediaValidationStaleMs).toISOString();
        const staleCount = database.resetStaleValidations(staleCutoff);
        if (staleCount > 0) console.warn(`已重新排队 ${staleCount} 个超时的媒体验证任务`);
        const removed = await cleanupOrphanedUploads(database, config, loopTime);
        if (removed > 0) console.warn(`已清理 ${removed} 个中断上传留下的隔离文件`);
        nextStaleSweepAt = loopTime.getTime() + staleSweepIntervalMs;
      }
      const processed = await processNextValidation(database, config, { now });
      if (once && !processed) break;
      if (!processed) {
        await new Promise((resolve) => setTimeout(resolve, config.mediaValidationPollMs));
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    database.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runValidatorWorker({ once: process.argv.includes('--once') }).catch((error) => {
    console.error(`同见媒体验证器启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
