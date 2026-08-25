import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createUploadSessionManager } from '../../src/upload-sessions.js';

let nowMs = 1_000_000;

async function withManager(t, { chunkSize = 4, maxUploadBytes = 1024 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'synopt-chunks-'));
  const manager = createUploadSessionManager({
    temporaryStoragePath: dir,
    maxUploadBytes,
    chunkSize,
    now: () => nowMs
  });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return { dir, manager };
}

test('分片会话：创建、按声明大小收片、流式组装并消费为 multer 近似文件', async (t) => {
  const { manager } = await withManager(t, { chunkSize: 4, maxUploadBytes: 1024 });
  const bytes = Buffer.from('0123456789'); // 10 bytes, chunkSize 4 -> [4,4,2]
  const created = manager.create({ userId: 'u1', totalBytes: bytes.length, fileName: 'demo.mp4', mimeType: 'video/mp4', container: 'mp4' });
  assert.equal(created.error, undefined);
  assert.equal(created.totalBytes, bytes.length);
  assert.equal(created.chunkSize, 4);
  assert.equal(created.expectedCount, 3);

  for (let i = 0; i < created.expectedCount; i += 1) {
    const chunk = bytes.subarray(i * 4, Math.min((i + 1) * 4, bytes.length));
    const written = manager.writeChunk({ sessionId: created.sessionId, userId: 'u1', index: i, buffer: chunk });
    assert.equal(written.error, undefined);
  }

  const assembled = await manager.assemble({ sessionId: created.sessionId, userId: 'u1' });
  assert.equal(assembled.error, undefined);
  assert.equal(assembled.totalBytes, bytes.length);
  assert.equal((await readFile(assembled.assembledPath)).toString(), bytes.toString());

  const consumed = manager.consume({ sessionId: created.sessionId, userId: 'u1' });
  assert.equal(consumed.error, undefined);
  assert.deepEqual(
    { size: consumed.size, originalname: consumed.originalname, mimetype: consumed.mimetype },
    { size: bytes.length, originalname: 'demo.mp4', mimetype: 'video/mp4' }
  );

  // 同一会话只能消费一次
  assert.equal(manager.consume({ sessionId: created.sessionId, userId: 'u1' }).error, 'SESSION_INVALID');
});

test('分片会话：拒绝超上限、越界序号、非法分片与非本人会话', async (t) => {
  const { manager } = await withManager(t, { chunkSize: 4, maxUploadBytes: 16 });

  assert.equal(manager.create({ userId: 'u1', totalBytes: 17 }).error, 'MEDIA_TOO_LARGE');
  assert.equal(manager.create({ userId: 'u1', totalBytes: 0 }).error, 'MEDIA_TOO_LARGE');

  const created = manager.create({ userId: 'u1', totalBytes: 4, fileName: 'a.mp4' });
  assert.equal(created.error, undefined);

  assert.equal(manager.writeChunk({ sessionId: created.sessionId, userId: 'u1', index: -1, buffer: Buffer.from('xx') }).error, 'INDEX_INVALID');
  assert.equal(manager.writeChunk({ sessionId: created.sessionId, userId: 'u1', index: 2, buffer: Buffer.from('x') }).error, 'INDEX_INVALID');
  assert.equal(manager.writeChunk({ sessionId: created.sessionId, userId: 'u1', index: 0, buffer: Buffer.from('') }).error, 'CHUNK_EMPTY');
  assert.equal(manager.writeChunk({ sessionId: created.sessionId, userId: 'u1', index: 0, buffer: Buffer.from('toolarge') }).error, 'CHUNK_TOO_LARGE');
  assert.equal(manager.writeChunk({ sessionId: created.sessionId, userId: 'other', index: 0, buffer: Buffer.from('x') }).error, 'SESSION_INVALID');
  assert.equal(manager.writeChunk({ sessionId: 'missing', userId: 'u1', index: 0, buffer: Buffer.from('x') }).error, 'SESSION_INVALID');
});

test('分片会话：同一用户最多 8 个未装配会话', async (t) => {
  const { manager } = await withManager(t, { chunkSize: 4 });
  for (let i = 0; i < 8; i += 1) {
    const r = manager.create({ userId: 'u-many', totalBytes: 4, fileName: `f-${i}.mp4` });
    assert.equal(r.error, undefined, `第 ${i + 1} 个会话应成功`);
  }
  const overflow = manager.create({ userId: 'u-many', totalBytes: 4, fileName: 'overflow.mp4' });
  assert.equal(overflow.error, 'TOO_MANY_SESSIONS');
});

test('分片会话：缺失/大小不符/未完成对应错误，重复组装被拒', async (t) => {
  const { manager } = await withManager(t, { chunkSize: 4 });
  const bytes = Buffer.from('0123456789');

  const missing = manager.create({ userId: 'u1', totalBytes: bytes.length, fileName: 'a.mp4' });
  manager.writeChunk({ sessionId: missing.sessionId, userId: 'u1', index: 0, buffer: bytes.subarray(0, 4) });
  manager.writeChunk({ sessionId: missing.sessionId, userId: 'u1', index: 2, buffer: bytes.subarray(8, 10) });
  assert.equal((await manager.assemble({ sessionId: missing.sessionId, userId: 'u1' })).error, 'CHUNK_MISSING');

  const wrongSize = manager.create({ userId: 'u1', totalBytes: bytes.length, fileName: 'b.mp4' });
  manager.writeChunk({ sessionId: wrongSize.sessionId, userId: 'u1', index: 0, buffer: bytes.subarray(0, 3) });
  manager.writeChunk({ sessionId: wrongSize.sessionId, userId: 'u1', index: 1, buffer: bytes.subarray(3, 7) });
  manager.writeChunk({ sessionId: wrongSize.sessionId, userId: 'u1', index: 2, buffer: bytes.subarray(7, 10) });
  assert.equal((await manager.assemble({ sessionId: wrongSize.sessionId, userId: 'u1' })).error, 'CHUNK_SIZE_MISMATCH');

  const incomplete = manager.create({ userId: 'u1', totalBytes: 8, fileName: 'c.mp4' });
  manager.writeChunk({ sessionId: incomplete.sessionId, userId: 'u1', index: 0, buffer: bytes.subarray(0, 4) });
  assert.equal(manager.consume({ sessionId: incomplete.sessionId, userId: 'u1' }).error, 'SESSION_NOT_ASSEMBLED');

  const done = manager.create({ userId: 'u1', totalBytes: 4, fileName: 'd.mp4' });
  manager.writeChunk({ sessionId: done.sessionId, userId: 'u1', index: 0, buffer: bytes.subarray(0, 4) });
  assert.equal((await manager.assemble({ sessionId: done.sessionId, userId: 'u1' })).error, undefined);
  assert.equal((await manager.assemble({ sessionId: done.sessionId, userId: 'u1' })).error, 'SESSION_ALREADY_ASSEMBLED');
});

test('分片会话：过期会话与装配后的临时文件会被清理', async (t) => {
  const { manager } = await withManager(t, { chunkSize: 4 });
  nowMs = 1_000_000;

  manager.create({ userId: 'u1', totalBytes: 4, fileName: 'open.mp4' });
  const assembled = manager.create({ userId: 'u1', totalBytes: 4, fileName: 'done.mp4' });
  manager.writeChunk({ sessionId: assembled.sessionId, userId: 'u1', index: 0, buffer: Buffer.from('abcd') });
  const asm = await manager.assemble({ sessionId: assembled.sessionId, userId: 'u1' });
  assert.equal(asm.error, undefined);
  assert.equal(existsSync(asm.assembledPath), true);

  nowMs = 1_000_000 + 31 * 60 * 1000; // 超过 30 分钟
  assert.equal(manager.prune(), 0);
  assert.equal(existsSync(asm.assembledPath), false);
});
