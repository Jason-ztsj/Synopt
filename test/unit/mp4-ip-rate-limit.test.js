import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ValidationError } from '../../src/errors.js';
import { getClientIp, normalizeIp } from '../../src/ip.js';
import { isMp4Header, validateMp4File, validateMp4Metadata } from '../../src/mp4.js';
import { DiscussionRateLimiter } from '../../src/rate-limit.js';

function standardHeader() {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(24, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write('isom', 8, 'ascii');
  buffer.writeUInt32BE(0x200, 12);
  buffer.write('isom', 16, 'ascii');
  buffer.write('mp42', 20, 'ascii');
  return buffer;
}

test('MP4 ftyp 检查接受标准和扩展尺寸 box，拒绝短文件、错误标识与非法尺寸', () => {
  assert.equal(isMp4Header(standardHeader()), true);

  const extended = Buffer.alloc(24);
  extended.writeUInt32BE(1, 0);
  extended.write('ftyp', 4, 'ascii');
  extended.writeBigUInt64BE(24n, 8);
  extended.write('isom', 16, 'ascii');
  extended.writeUInt32BE(0x200, 20);
  assert.equal(isMp4Header(extended), true);

  assert.equal(isMp4Header(Buffer.alloc(11)), false);
  assert.equal(isMp4Header(new Uint8Array(standardHeader())), false);
  const wrongMarker = standardHeader();
  wrongMarker.write('free', 4, 'ascii');
  assert.equal(isMp4Header(wrongMarker), false);
  const impossibleSize = standardHeader();
  impossibleSize.writeUInt32BE(8, 0);
  assert.equal(isMp4Header(impossibleSize), false);
  const beyondFile = standardHeader();
  beyondFile.writeUInt32BE(64, 0);
  assert.equal(isMp4Header(beyondFile), false);
  const truncatedExtended = Buffer.alloc(20);
  truncatedExtended.writeUInt32BE(1, 0);
  truncatedExtended.write('ftyp', 4, 'ascii');
  truncatedExtended.writeBigUInt64BE(24n, 8);
  assert.equal(isMp4Header(truncatedExtended), false);
});

test('MP4 元数据严格要求 .mp4 扩展名和 video/mp4 MIME', () => {
  assert.doesNotThrow(() => validateMp4Metadata('作品.MP4', 'VIDEO/MP4'));
  assert.throws(() => validateMp4Metadata('作品.mov', 'video/mp4'), (error) => (
    error instanceof ValidationError && error.code === 'INVALID_MP4_EXTENSION'
  ));
  assert.throws(() => validateMp4Metadata('作品.mp4', 'application/octet-stream'), (error) => (
    error instanceof ValidationError && error.code === 'INVALID_MP4_MIME'
  ));
});

test('MP4 文件校验读取磁盘文件头并在成功或失败后释放句柄', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synopt-mp4-test-'));
  const validPath = path.join(directory, 'valid.upload');
  const invalidPath = path.join(directory, 'invalid.upload');
  try {
    await writeFile(validPath, standardHeader());
    await writeFile(invalidPath, Buffer.from('not an mp4'));
    await assert.doesNotReject(() => validateMp4File(validPath));
    await assert.rejects(() => validateMp4File(invalidPath), (error) => (
      error instanceof ValidationError && error.code === 'INVALID_MP4_HEADER'
    ));
    // On Windows and on strict filesystems these removals also prove handles closed.
    await rm(validPath);
    await rm(invalidPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('direct 模式只使用连接地址并规范化 IPv4-mapped IPv6', () => {
  const request = {
    socket: { remoteAddress: '::ffff:192.0.2.7' },
    headers: {
      'cf-connecting-ip': '198.51.100.9',
      'x-forwarded-for': '203.0.113.10'
    }
  };
  assert.equal(getClientIp(request, 'direct'), '192.0.2.7');
  assert.equal(normalizeIp(' 2001:db8::1 '), '2001:db8::1');
  assert.equal(normalizeIp('not-an-ip'), null);
});

test('cloudflare 模式只接受合法的单值 CF-Connecting-IP，否则安全回退', () => {
  const request = (header) => ({
    socket: { remoteAddress: '::ffff:192.0.2.7' },
    headers: { 'cf-connecting-ip': header }
  });
  assert.equal(getClientIp(request('198.51.100.9'), 'cloudflare'), '198.51.100.9');
  assert.equal(getClientIp(request('2001:db8::9'), 'cloudflare'), '2001:db8::9');
  assert.equal(getClientIp(request('198.51.100.9, 203.0.113.2'), 'cloudflare'), '192.0.2.7');
  assert.equal(getClientIp(request(['198.51.100.9']), 'cloudflare'), '192.0.2.7');
  assert.equal(getClientIp(request('伪造地址'), 'cloudflare'), '192.0.2.7');
  assert.equal(getClientIp({ socket: {}, headers: {} }, 'cloudflare'), 'unknown');
});

test('讨论冷却在 30 秒前拒绝并向上取整秒数，恰好 30 秒时放行', () => {
  let current = 1_000;
  const limiter = new DiscussionRateLimiter({ cooldownSeconds: 30, now: () => current });

  assert.deepEqual(limiter.check('client-a'), { allowed: true, retryAfterSeconds: 0 });
  // check 本身不能消耗配额；只有成功写入后 consume 才开始窗口。
  assert.deepEqual(limiter.check('client-a'), { allowed: true, retryAfterSeconds: 0 });
  limiter.consume('client-a');
  assert.deepEqual(limiter.check('client-a'), { allowed: false, retryAfterSeconds: 30 });
  assert.deepEqual(limiter.check('client-b'), { allowed: true, retryAfterSeconds: 0 });

  current = 30_999;
  assert.deepEqual(limiter.check('client-a'), { allowed: false, retryAfterSeconds: 1 });
  current = 31_000;
  assert.deepEqual(limiter.check('client-a'), { allowed: true, retryAfterSeconds: 0 });
});
