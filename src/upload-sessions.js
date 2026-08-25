import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';

// 分片上传会话管理器。零依赖、单进程内存注册表 + 磁盘分片，符合本项目 KISS 与自托管原则。
// 会话只是把大文件的字节送到服务端的暂存方式：所有分片收齐后按顺序流式拼成一个 `.upload`
// 临时文件（与直接上传落盘一致），随后由 `/videos` 路由接管，进入既有验证器管线。

const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024; // 16 MiB，远低于隧道 100 MB 上限
const DEFAULT_PRUNE_AFTER_MS = 30 * 60 * 1000; // 30 分钟
const MAX_SESSIONS_PER_USER = 8;

export function createUploadSessionManager({
  temporaryStoragePath,
  maxUploadBytes,
  chunkSize = DEFAULT_CHUNK_SIZE,
  pruneAfterMs = DEFAULT_PRUNE_AFTER_MS,
  now = () => Date.now()
} = {}) {
  const sessions = new Map();
  const chunkRoot = path.join(temporaryStoragePath, 'chunks');

  const chunkDir = (session) => path.join(chunkRoot, session.id);
  const expectedCount = (totalBytes) => Math.ceil(totalBytes / chunkSize);
  const chunkSizeAt = (index, totalBytes) => Math.min(chunkSize, totalBytes - index * chunkSize);

  function pruneExpired() {
    const nowMs = now();
    for (const [id, session] of sessions) {
      if (nowMs - session.createdAt > pruneAfterMs) {
        try { fs.rmSync(chunkDir(session), { recursive: true, force: true }); } catch { /* ignore */ }
        if (session.status === 'assembled' && session.assembledPath) {
          try { fs.unlinkSync(session.assembledPath); } catch { /* ignore */ }
        }
        sessions.delete(id);
      }
    }
  }

  function create(input) {
    const totalBytes = Number(input?.totalBytes);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > maxUploadBytes) {
      return { error: 'MEDIA_TOO_LARGE' };
    }
    pruneExpired();
    const active = [...sessions.values()].filter(
      (session) => session.userId === input.userId && session.status === 'open'
    ).length;
    if (active >= MAX_SESSIONS_PER_USER) {
      return { error: 'TOO_MANY_SESSIONS' };
    }
    const id = randomUUID();
    const session = {
      id,
      userId: input.userId,
      totalBytes,
      chunkSize,
      fileName: input.fileName ?? 'video',
      mimeType: input.mimeType ?? null,
      container: input.container ?? null,
      videoCodec: input.videoCodec ?? null,
      audioCodec: input.audioCodec ?? null,
      operation: input.operation ?? 'unknown',
      sourceFilename: input.sourceFilename ?? null,
      createdAt: now(),
      status: 'open',
      assembledPath: null
    };
    try {
      fs.mkdirSync(chunkDir(session), { recursive: true });
    } catch {
      return { error: 'STORAGE_UNAVAILABLE' };
    }
    sessions.set(id, session);
    return { sessionId: id, chunkSize, totalBytes, expectedCount: expectedCount(totalBytes) };
  }

  function writeChunk(input) {
    const session = sessions.get(String(input.sessionId ?? ''));
    if (!session || session.userId !== input.userId || session.status !== 'open') {
      return { error: 'SESSION_INVALID' };
    }
    const index = Number(input.index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= expectedCount(session.totalBytes)) {
      return { error: 'INDEX_INVALID' };
    }
    if (!Buffer.isBuffer(input.buffer) || input.buffer.length < 1) {
      return { error: 'CHUNK_EMPTY' };
    }
    if (input.buffer.length > chunkSizeAt(index, session.totalBytes)) {
      return { error: 'CHUNK_TOO_LARGE' };
    }
    try {
      fs.writeFileSync(path.join(chunkDir(session), String(index)), input.buffer);
    } catch {
      return { error: 'STORAGE_UNAVAILABLE' };
    }
    return { ok: true };
  }

  async function assemble(input) {
    const session = sessions.get(String(input.sessionId ?? ''));
    if (!session || session.userId !== input.userId) {
      return { error: 'SESSION_INVALID' };
    }
    if (session.status !== 'open') {
      return { error: 'SESSION_ALREADY_ASSEMBLED' };
    }
    const count = expectedCount(session.totalBytes);
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      const chunkPath = path.join(chunkDir(session), String(index));
      let stat;
      try {
        stat = fs.statSync(chunkPath);
      } catch {
        return { error: 'CHUNK_MISSING' };
      }
      if (stat.size !== chunkSizeAt(index, session.totalBytes)) {
        return { error: 'CHUNK_SIZE_MISMATCH' };
      }
      total += stat.size;
    }
    if (total !== session.totalBytes) {
      return { error: 'SIZE_MISMATCH' };
    }
    const assembledPath = path.join(temporaryStoragePath, `${randomUUID()}.upload`);
    try {
      await concatInOrder(chunkDir(session), count, assembledPath);
    } catch {
      try { fs.unlinkSync(assembledPath); } catch { /* ignore */ }
      return { error: 'ASSEMBLY_FAILED' };
    }
    session.status = 'assembled';
    session.assembledPath = assembledPath;
    session.assembledAt = now();
    try { fs.rmSync(chunkDir(session), { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: true, assembledPath, totalBytes: session.totalBytes };
  }

  // 消费一个已装配会话：返回供 /videos 使用的文件信息（近似 multer 文件），并从注册表移除，
  // 防止同一次会话被重复使用。装配出的临时文件由 /videos 管线负责 rename/清理。
  function consume(input) {
    const session = sessions.get(String(input.sessionId ?? ''));
    if (!session || session.userId !== input.userId) {
      return { error: 'SESSION_INVALID' };
    }
    if (session.status !== 'assembled' || !session.assembledPath) {
      return { error: 'SESSION_NOT_ASSEMBLED' };
    }
    sessions.delete(session.id);
    return {
      path: session.assembledPath,
      size: session.totalBytes,
      originalname: session.fileName,
      mimetype: session.mimeType,
      container: session.container,
      videoCodec: session.videoCodec,
      audioCodec: session.audioCodec,
      operation: session.operation,
      sourceFilename: session.sourceFilename
    };
  }

  function get(input) {
    const session = sessions.get(String(input.sessionId ?? ''));
    if (!session || session.userId !== input.userId) return null;
    return { status: session.status, totalBytes: session.totalBytes, chunkSize: session.chunkSize };
  }

  function prune() {
    pruneExpired();
    return sessions.size;
  }

  function count() {
    return sessions.size;
  }

  return { create, writeChunk, assemble, consume, get, prune, count };
}

async function concatInOrder(chunkDir, count, outPath) {
  const out = createWriteStream(outPath);
  try {
    for (let index = 0; index < count; index += 1) {
      await pipeline(createReadStream(path.join(chunkDir, String(index))), out, { end: false });
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    try { out.destroy(); } catch { /* ignore */ }
    throw error;
  }
}
