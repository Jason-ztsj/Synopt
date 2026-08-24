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
  suffix,
  suffixes
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
  const acceptedSuffixes = Array.isArray(suffixes) ? suffixes : (suffix ? [suffix] : []);
  for (const entry of entries) {
    if (
      !entry.isFile()
      || trackedNames.has(entry.name)
      || (acceptedSuffixes.length > 0 && !acceptedSuffixes.some((candidate) => entry.name.endsWith(candidate)))
    ) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs >= cutoffMs) continue;
      await unlink(filePath);
      removed += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error(`孤立文件清理失败：${filePath} (${error.code || error.message})`);
      }
    }
  }
  return removed;
}

export async function cleanupOrphanedUploads(database, config, nowDate = new Date()) {
  const queuedTargets = database.listFileDeletionTargets?.() ?? [];
  const queuedNames = (kind) => queuedTargets
    .filter((task) => task.kind === kind)
    .map((task) => task.storageName);
  const trackedNames = new Set([
    ...(database.listVideoStorageNames?.() ?? []),
    ...queuedNames('video')
  ]);
  // A grace period avoids racing the application's rename-then-database-insert
  // window. Public media is deliberately never removed by this maintenance.
  const pendingGraceMs = Math.max(10 * 60_000, config.mediaValidationPollMs * 20);
  const pendingRemoved = await removeOldUntrackedFiles(config.pendingStoragePath, {
    trackedNames,
    cutoffMs: nowDate.getTime() - pendingGraceMs
  });
  const temporaryRemoved = await removeOldUntrackedFiles(config.temporaryStoragePath, {
    cutoffMs: nowDate.getTime() - 60 * 60_000,
    suffixes: ['.upload', '.avatar-upload', '.normalized-image.webp']
  });
  const coverRemoved = await removeOldUntrackedFiles(config.coverStoragePath, {
    trackedNames: new Set([
      ...(database.listCoverStorageNames?.() ?? []),
      ...queuedNames('cover')
    ]),
    cutoffMs: nowDate.getTime() - 60 * 60_000
  });
  const avatarRemoved = await removeOldUntrackedFiles(config.avatarStoragePath, {
    trackedNames: new Set([
      ...(database.listAvatarStorageNames?.() ?? []),
      ...queuedNames('avatar')
    ]),
    cutoffMs: nowDate.getTime() - 60 * 60_000
  });
  return pendingRemoved + temporaryRemoved + coverRemoved + avatarRemoved;
}

function fileDeletionPaths(task, config) {
  if (task.kind === 'video') {
    // Pending must be removed before public to close the validator rename race.
    return [
      storagePath(config.pendingStoragePath, task.storageName),
      storagePath(config.videoStoragePath, task.storageName)
    ];
  }
  if (task.kind === 'cover') return [storagePath(config.coverStoragePath, task.storageName)];
  if (task.kind === 'avatar') return [storagePath(config.avatarStoragePath, task.storageName)];
  throw new MediaValidationSystemError('文件删除队列类型无效', 'INVALID_FILE_DELETION_KIND');
}

async function assertPathsAbsent(paths) {
  for (const filePath of paths) {
    try {
      await stat(filePath);
      throw new MediaValidationSystemError('待删除文件仍然存在', 'FILE_DELETION_INCOMPLETE');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export async function processPendingFileDeletions(database, config, {
  limit = 50,
  now = () => new Date()
} = {}) {
  if (
    typeof database.listPendingFileDeletions !== 'function'
    || typeof database.completeFileDeletion !== 'function'
    || typeof database.failFileDeletion !== 'function'
  ) return { completed: 0, failed: 0, deferred: 0 };

  const nowDate = now();
  const nowIso = nowDate.toISOString();
  // Retry eligibility is persisted and filtered before LIMIT in the database.
  // This prevents a page of deferred failures from starving newer due tasks.
  const tasks = database.listPendingFileDeletions({ limit, eligibleAt: nowIso });
  const result = { completed: 0, failed: 0, deferred: 0 };
  for (const task of tasks) {
    try {
      const paths = fileDeletionPaths(task, config);
      for (const filePath of paths) await removeIfPresent(filePath);
      // Verify every candidate after the ordered unlink sequence before the
      // durable task is acknowledged.
      await assertPathsAbsent(paths);
      if (database.completeFileDeletion(task.id) === 1) result.completed += 1;
    } catch (error) {
      database.failFileDeletion(task.id, error, nowIso);
      result.failed += 1;
    }
  }
  return result;
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
  let claimStartedAt = video.validationStartedAt;
  let claimLost = false;
  let claimLeaseError = null;
  let heartbeatTimer = null;
  let candidatePath;
  let generatedCover = null;
  let generatedCoverRecorded = false;

  const canRenewClaim = typeof database.renewVideoValidationLease === 'function'
    && typeof claimStartedAt === 'string' && claimStartedAt.length > 0;
  const renewClaim = () => {
    if (!canRenewClaim) return true;
    if (claimLost) return false;
    const renewedAt = now().toISOString();
    try {
      if (database.renewVideoValidationLease(video.id, claimStartedAt, renewedAt) !== 1) {
        claimLost = true;
        return false;
      }
      claimStartedAt = renewedAt;
      return true;
    } catch (error) {
      claimLost = true;
      claimLeaseError = error;
      return false;
    }
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };
  if (canRenewClaim) {
    const heartbeatMs = Math.min(
      60_000,
      Math.max(1_000, Math.floor((config.mediaValidationStaleMs ?? 180_000) / 3))
    );
    heartbeatTimer = setInterval(renewClaim, heartbeatMs);
    heartbeatTimer.unref?.();
  }
  try {
    candidatePath = existingCandidate(pendingPath, finalPath);
    const result = await validate(candidatePath, video.mediaType, config);
    if (!video.coverStorageName && typeof database.setVideoCover === 'function') {
      generatedCover = await generateCover(candidatePath, config);
    }
    if (!renewClaim()) {
      throw new MediaValidationSystemError(
        '验证任务租约已经失效',
        'VALIDATION_CLAIM_LOST',
        { cause: claimLeaseError?.message }
      );
    }
    if (candidatePath === pendingPath) await rename(pendingPath, finalPath);
    if (generatedCover) {
      const coverChanged = database.setVideoCover(video.id, generatedCover, claimStartedAt);
      if (coverChanged !== 1) {
        await removeIfPresent(storagePath(config.coverStoragePath, generatedCover.storageName));
        generatedCover = null;
        throw new MediaValidationSystemError(
          '验证完成时稿件已被删除或状态已改变',
          'VALIDATION_STATE_CONFLICT'
        );
      }
      generatedCoverRecorded = true;
    }
    stopHeartbeat();
    const changed = database.completeVideoValidation(
      video.id,
      result,
      now().toISOString(),
      claimStartedAt
    );
    if (changed !== 1) {
      throw new MediaValidationSystemError('验证完成时数据库状态已改变', 'VALIDATION_STATE_CONFLICT');
    }
    console.log(`媒体验证通过：${video.id} (${result.videoCodec}/${result.audioCodec ?? 'silent'}, ${result.warningCount} warnings)`);
  } catch (error) {
    stopHeartbeat();
    if (generatedCover && !generatedCoverRecorded && config.coverStoragePath) {
      try {
        await removeIfPresent(storagePath(config.coverStoragePath, generatedCover.storageName));
      } catch (cleanupError) {
        console.error(`未入库封面清理失败：${video.id} (${cleanupError.code || cleanupError.message})`);
      }
    }
    const finishedAt = now().toISOString();
    if (!renewClaim()) {
      console.warn(`媒体验证结果已放弃：${video.id}（任务租约已由其他 worker 接管）`);
      return true;
    }
    if (error instanceof MediaRejectedError) {
      const changed = database.rejectVideoValidation(
        video.id,
        error.summary,
        finishedAt,
        claimStartedAt
      );
      if (changed !== 1) {
        console.warn(`媒体验证拒绝结果未写入：${video.id}（稿件状态已改变）`);
        return true;
      }
      const cleanupPaths = new Set([candidatePath ?? pendingPath]);
      if (candidatePath === finalPath) cleanupPaths.add(finalPath);
      if (video.coverStorageName && config.coverStoragePath) {
        cleanupPaths.add(storagePath(config.coverStoragePath, video.coverStorageName));
      }
      for (const cleanupPath of cleanupPaths) {
        try {
          await removeIfPresent(cleanupPath);
        } catch (cleanupError) {
          // rejectVideoValidation durably queued every referenced asset before
          // this best-effort cleanup, so an unlink failure must not stop the
          // worker or leave the media in validating forever.
          console.error(`拒绝媒体即时清理失败：${video.id} (${cleanupError.code || cleanupError.message})`);
        }
      }
      console.warn(`媒体验证拒绝：${video.id} (${error.code})`);
      return true;
    }
    const systemError = error instanceof MediaValidationSystemError
      ? error
      : new MediaValidationSystemError('媒体验证发生内部错误', 'VALIDATION_INTERNAL_ERROR', {
        cause: error?.message || String(error)
      });
    const changed = database.failVideoValidation(
      video.id,
      systemError.summary,
      finishedAt,
      claimStartedAt
    );
    if (changed === 1) console.error(`媒体验证暂时失败：${video.id} (${systemError.code})`);
    else console.warn(`媒体验证失败结果未写入：${video.id}（稿件状态已改变）`);
  }
  stopHeartbeat();
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
  if (config.avatarStoragePath) fs.mkdirSync(config.avatarStoragePath, { recursive: true });
  const startupTime = now();
  const startupDeletions = await processPendingFileDeletions(database, config, { now: () => startupTime });
  if (startupDeletions.completed > 0) {
    console.warn(`已完成 ${startupDeletions.completed} 个持久文件删除任务`);
  }
  if (startupDeletions.failed > 0) {
    console.error(`${startupDeletions.failed} 个文件删除任务失败，将按退避策略重试`);
  }
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
        const deletions = await processPendingFileDeletions(database, config, { now: () => loopTime });
        if (deletions.completed > 0) console.warn(`已完成 ${deletions.completed} 个持久文件删除任务`);
        if (deletions.failed > 0) console.error(`${deletions.failed} 个文件删除任务失败，将按退避策略重试`);
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
