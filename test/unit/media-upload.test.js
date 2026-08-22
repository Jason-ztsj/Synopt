import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ValidationError } from '../../src/errors.js';
import {
  isWebmHeader,
  normalizeSourceFilename,
  validateCanonicalUploadHeader,
  validateCanonicalUploadMetadata
} from '../../src/media-upload.js';

function webmHeader() {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01]),
    Buffer.from('webm', 'ascii')
  ]);
}

test('规范上传元数据只允许匹配的 MP4 与 WebM', () => {
  assert.deepEqual(validateCanonicalUploadMetadata('作品.MP4', 'VIDEO/MP4'), {
    container: 'mp4', mediaType: 'video/mp4'
  });
  assert.deepEqual(validateCanonicalUploadMetadata('作品.webm', 'video/webm'), {
    container: 'webm', mediaType: 'video/webm'
  });
  assert.throws(() => validateCanonicalUploadMetadata('作品.mov', 'video/quicktime'), ValidationError);
  assert.throws(() => validateCanonicalUploadMetadata('作品.webm', 'video/mp4'), ValidationError);
});

test('WebM 快速检查要求 EBML 魔数与 webm DocType', () => {
  assert.equal(isWebmHeader(webmHeader()), true);
  assert.equal(isWebmHeader(Buffer.from('webm but no ebml header')), false);
});

test('磁盘快速检查拒绝伪 WebM，并始终释放句柄', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-media-header-'));
  try {
    const valid = path.join(directory, 'valid.upload');
    const invalid = path.join(directory, 'invalid.upload');
    await writeFile(valid, webmHeader());
    await writeFile(invalid, Buffer.from('not webm'));
    await assert.doesNotReject(validateCanonicalUploadHeader(valid, 'webm'));
    await assert.rejects(validateCanonicalUploadHeader(invalid, 'webm'), ValidationError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('源文件名去掉客户端路径并拒绝控制字符', () => {
  assert.equal(normalizeSourceFilename('C:\\fakepath\\作品.mov', 'fallback.mp4'), '作品.mov');
  assert.equal(normalizeSourceFilename('', 'fallback.mp4'), 'fallback.mp4');
  assert.throws(() => normalizeSourceFilename('bad\0name.mp4'), ValidationError);
});
