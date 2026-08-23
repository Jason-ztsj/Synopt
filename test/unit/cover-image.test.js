import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateCoverImage } from '../../src/cover-image.js';

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

test('封面校验只接受严格 16:9、指定尺寸与真实图片签名', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cover-test-'));
  try {
    const goodPath = path.join(directory, 'good.upload');
    await writeFile(goodPath, minimalPng(1280, 720));
    assert.deepEqual(await validateCoverImage({
      path: goodPath,
      originalname: 'cover.png',
      mimetype: 'image/png'
    }), {
      mediaType: 'image/png',
      extension: '.png',
      width: 1280,
      height: 720,
      byteSize: 45
    });

    const portraitPath = path.join(directory, 'portrait.upload');
    await writeFile(portraitPath, minimalPng(720, 1280));
    await assert.rejects(() => validateCoverImage({
      path: portraitPath,
      originalname: 'portrait.png',
      mimetype: 'image/png'
    }), /16:9/);

    await assert.rejects(() => validateCoverImage({
      path: goodPath,
      originalname: 'cover.jpg',
      mimetype: 'image/jpeg'
    }), /结构|尺寸/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
