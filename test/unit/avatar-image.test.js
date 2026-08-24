import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { AVATAR_RULES, validateAvatarImage } from '../../src/avatar-image.js';
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
    '-f', 'lavfi', '-i', `color=c=0x3b82f6:s=${width}x${height}`,
    '-frames:v', '1',
    ...encoder,
    '-update', '1',
    '-y', filePath
  ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
}

async function assertDecodable(filePath) {
  await execFileAsync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
    '-i', filePath,
    '-frames:v', '1', '-f', 'null', '-'
  ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function withPngTextChunk(buffer, keyword, value) {
  const iendTypeOffset = buffer.lastIndexOf(Buffer.from('IEND'));
  assert.ok(iendTypeOffset >= 4, 'fixture PNG must contain IEND');
  const iendOffset = iendTypeOffset - 4;
  const data = Buffer.from(`${keyword}\0${value}`, 'latin1');
  const typeAndData = Buffer.concat([Buffer.from('tEXt'), data]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData), chunk.length - 4);
  return Buffer.concat([buffer.subarray(0, iendOffset), chunk, buffer.subarray(iendOffset)]);
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

function minimalWebp(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

async function expectValidation(file, code) {
  await assert.rejects(
    () => validateAvatarImage(file, { ffmpegPath: 'ffmpeg' }),
    (error) => error instanceof ValidationError && error.code === code && error.status === 400
  );
}

test('真实 JPEG、PNG 与 WebP 头像会解码并统一规范化为可再次解码的 WebP', {
  skip: ffmpegAvailable ? false : '系统没有 ffmpeg',
  timeout: 60_000
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-avatar-valid-'));
  try {
    const cases = [
      ['avatar.jpeg', 'image/jpeg', 128, 'jpeg'],
      ['avatar.png', 'image/png', 256, 'png'],
      ['avatar.webp', 'image/webp', 512, 'webp']
    ];

    for (const [originalname, mimetype, dimension, type] of cases) {
      const filePath = path.join(directory, originalname);
      await createImage(filePath, dimension, dimension, type);
      const result = await validateAvatarImage(
        { path: filePath, originalname, mimetype },
        { ffmpegPath: 'ffmpeg' }
      );

      assert.equal(result.mediaType, 'image/webp');
      assert.equal(result.extension, '.webp');
      assert.equal(result.width, dimension);
      assert.equal(result.height, dimension);
      assert.equal(result.byteSize, (await stat(result.normalizedPath)).size);
      assert.equal(path.dirname(result.normalizedPath), directory);
      assert.notEqual(result.normalizedPath, filePath);
      await assertDecodable(result.normalizedPath);
      await access(filePath);
      await rm(result.normalizedPath, { force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('规范化会移除输入 PNG 文本元数据', {
  skip: ffmpegAvailable ? false : '系统没有 ffmpeg',
  timeout: 30_000
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-avatar-metadata-'));
  const filePath = path.join(directory, 'metadata.png');
  const secret = 'private-avatar-metadata-9f2d';
  try {
    await createImage(filePath, 256, 256, 'png');
    await writeFile(filePath, withPngTextChunk(await readFile(filePath), 'Comment', secret));
    assert.ok((await readFile(filePath)).includes(Buffer.from(secret)));

    const result = await validateAvatarImage({
      path: filePath,
      originalname: 'metadata.png',
      mimetype: 'image/png'
    }, { ffmpegPath: 'ffmpeg' });
    const normalizedBytes = await readFile(result.normalizedPath);
    assert.equal(normalizedBytes.includes(Buffer.from(secret)), false);
    await assertDecodable(result.normalizedPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('扩展名、声明 MIME 和真实结构必须一致', {
  skip: ffmpegAvailable ? false : '系统没有 ffmpeg'
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-avatar-type-'));
  try {
    const filePath = path.join(directory, 'avatar.png');
    await createImage(filePath, 256, 256, 'png');

    await expectValidation({
      path: filePath,
      originalname: 'avatar.webp',
      mimetype: 'image/png'
    }, 'INVALID_AVATAR_TYPE');

    await expectValidation({
      path: filePath,
      originalname: 'avatar.jpg',
      mimetype: 'image/jpeg'
    }, 'INVALID_AVATAR_STRUCTURE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('只有合法文件头但没有像素的伪图片会被真实解码拒绝且不遗留输出', {
  skip: ffmpegAvailable ? false : '系统没有 ffmpeg',
  timeout: 20_000
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-avatar-fake-'));
  try {
    const filePath = path.join(directory, 'fake.webp');
    await writeFile(filePath, minimalWebp(256, 256));
    await expectValidation({
      path: filePath,
      originalname: 'fake.webp',
      mimetype: 'image/webp'
    }, 'INVALID_AVATAR_PIXELS');
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.normalized-image.webp')),
      []
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('截断图片会被结构完整性检查拒绝', {
  skip: ffmpegAvailable ? false : '系统没有 ffmpeg'
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-avatar-truncated-'));
  try {
    const filePath = path.join(directory, 'avatar.png');
    await createImage(filePath, 256, 256, 'png');
    const bytes = await readFile(filePath);
    await writeFile(filePath, bytes.subarray(0, bytes.length - 10));
    await expectValidation({
      path: filePath,
      originalname: 'avatar.png',
      mimetype: 'image/png'
    }, 'INVALID_AVATAR_STRUCTURE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('头像必须为 128 至 1024 像素的严格正方形', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-avatar-dimensions-'));
  try {
    for (const [name, width, height] of [
      ['not-square', 256, 255],
      ['too-small', 127, 127],
      ['too-large', 1025, 1025]
    ]) {
      const filePath = path.join(directory, `${name}.png`);
      await writeFile(filePath, minimalPng(width, height));
      await expectValidation({
        path: filePath,
        originalname: `${name}.png`,
        mimetype: 'image/png'
      }, 'INVALID_AVATAR_DIMENSIONS');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('头像文件大小限定为 24 字节至 2 MiB', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-avatar-size-'));
  try {
    const tooSmallPath = path.join(directory, 'small.png');
    await writeFile(tooSmallPath, Buffer.alloc(AVATAR_RULES.minBytes - 1));
    await expectValidation({
      path: tooSmallPath,
      originalname: 'avatar.png',
      mimetype: 'image/png'
    }, 'INVALID_AVATAR_SIZE');

    const tooLargePath = path.join(directory, 'large.png');
    await writeFile(tooLargePath, Buffer.alloc(AVATAR_RULES.maxBytes + 1));
    await expectValidation({
      path: tooLargePath,
      originalname: 'avatar.png',
      mimetype: 'image/png'
    }, 'INVALID_AVATAR_SIZE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
