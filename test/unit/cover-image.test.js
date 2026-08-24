import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { COVER_RULES, validateCoverImage } from '../../src/cover-image.js';
import { ValidationError } from '../../src/errors.js';

const execFileAsync = promisify(execFile);

function hasMediaTool(command) {
  const result = spawnSync(command, ['-version'], {
    stdio: ['ignore', 'ignore', 'ignore']
  });
  return !result.error && result.status === 0;
}

const ffmpegAvailable = hasMediaTool('ffmpeg');

async function createImage(filePath, width, height, type) {
  const encoder = type === 'jpeg'
    ? ['-q:v', '3']
    : type === 'webp'
      ? ['-c:v', 'libwebp', '-quality', '90']
      : ['-compression_level', '2'];
  await execFileAsync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=0x1f2937:s=${width}x${height}`,
    '-frames:v', '1',
    ...encoder,
    '-update', '1',
    '-y', filePath
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
}

async function assertDecodable(filePath) {
  await execFileAsync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
    '-i', filePath,
    '-frames:v', '1', '-f', 'null', '-'
  ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
}

function minimalPng(width, height) {
  const buffer = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  buffer.writeUInt32BE(0, 33);
  buffer.write('IEND', 37, 'ascii');
  return buffer;
}

async function expectValidation(file, code) {
  await assert.rejects(
    () => validateCoverImage(file, { ffmpegPath: 'ffmpeg' }),
    (error) => error instanceof ValidationError && error.code === code
  );
}

test('真实 JPEG、PNG 与 WebP 封面会解码并统一规范化为 WebP', {
  skip: ffmpegAvailable ? false : '系统没有 ffmpeg',
  timeout: 90_000
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cover-valid-'));
  try {
    for (const [originalname, mimetype, type] of [
      ['cover.jpeg', 'image/jpeg', 'jpeg'],
      ['cover.png', 'image/png', 'png'],
      ['cover.webp', 'image/webp', 'webp']
    ]) {
      const filePath = path.join(directory, originalname);
      await createImage(filePath, 1280, 720, type);
      const result = await validateCoverImage(
        { path: filePath, originalname, mimetype },
        { ffmpegPath: 'ffmpeg' }
      );

      assert.equal(result.mediaType, 'image/webp');
      assert.equal(result.extension, '.webp');
      assert.equal(result.width, 1280);
      assert.equal(result.height, 720);
      assert.equal(result.byteSize, (await stat(result.normalizedPath)).size);
      assert.ok(result.normalizedPath.endsWith('.normalized-image.webp'));
      await assertDecodable(result.normalizedPath);
      await rm(result.normalizedPath, { force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('封面扩展名、声明 MIME 与真实签名必须一致', {
  skip: ffmpegAvailable ? false : '系统没有 ffmpeg'
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cover-type-'));
  try {
    const filePath = path.join(directory, 'cover.png');
    await createImage(filePath, 1280, 720, 'png');
    await expectValidation({
      path: filePath,
      originalname: 'cover.webp',
      mimetype: 'image/png'
    }, 'INVALID_COVER_TYPE');
    await expectValidation({
      path: filePath,
      originalname: 'cover.jpg',
      mimetype: 'image/jpeg'
    }, 'INVALID_COVER_STRUCTURE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('封面必须是限定尺寸内的严格 16:9', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cover-dimensions-'));
  try {
    for (const [name, width, height] of [
      ['portrait', 720, 1280],
      ['too-small', 640, 360],
      ['wrong-ratio', 1280, 721],
      ['too-large', 4000, 2250]
    ]) {
      const filePath = path.join(directory, `${name}.png`);
      await writeFile(filePath, minimalPng(width, height));
      await expectValidation({
        path: filePath,
        originalname: `${name}.png`,
        mimetype: 'image/png'
      }, 'INVALID_COVER_DIMENSIONS');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('只有合法封面头部但没有像素数据的伪图片会被拒绝且不遗留规范化文件', {
  skip: ffmpegAvailable ? false : '系统没有 ffmpeg',
  timeout: 20_000
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cover-fake-'));
  try {
    const filePath = path.join(directory, 'fake.png');
    await writeFile(filePath, minimalPng(1280, 720));
    await expectValidation({
      path: filePath,
      originalname: 'fake.png',
      mimetype: 'image/png'
    }, 'INVALID_COVER_PIXELS');
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.normalized-image.webp')),
      []
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('截断的真实封面以及超限文件会在解码前被拒绝', {
  skip: ffmpegAvailable ? false : '系统没有 ffmpeg'
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cover-truncated-'));
  try {
    const filePath = path.join(directory, 'truncated.png');
    await createImage(filePath, 1280, 720, 'png');
    const bytes = await readFile(filePath);
    await writeFile(filePath, bytes.subarray(0, bytes.length - 10));
    await expectValidation({
      path: filePath,
      originalname: 'truncated.png',
      mimetype: 'image/png'
    }, 'INVALID_COVER_STRUCTURE');

    const largePath = path.join(directory, 'large.png');
    await writeFile(largePath, Buffer.alloc(COVER_RULES.maxBytes + 1));
    await expectValidation({
      path: largePath,
      originalname: 'large.png',
      mimetype: 'image/png'
    }, 'INVALID_COVER_SIZE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
