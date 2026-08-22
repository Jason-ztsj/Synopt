import path from 'node:path';
import { open } from 'node:fs/promises';

import { ValidationError } from './errors.js';
import { isMp4Header } from './mp4.js';

const CANONICAL_UPLOADS = Object.freeze({
  '.mp4': Object.freeze({ container: 'mp4', mediaType: 'video/mp4' }),
  '.webm': Object.freeze({ container: 'webm', mediaType: 'video/webm' })
});

export function isWebmHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  if (!buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false;
  return buffer.toString('ascii').toLowerCase().includes('webm');
}

export function validateCanonicalUploadMetadata(originalName, mediaType) {
  const extension = typeof originalName === 'string' ? path.extname(originalName).toLowerCase() : '';
  const expected = CANONICAL_UPLOADS[extension];
  if (!expected) {
    throw new ValidationError(
      '服务器只接收浏览器规范化后的 .mp4 或 .webm 文件；MOV/MKV 请启用 JavaScript 后上传。',
      'INVALID_MEDIA_EXTENSION'
    );
  }
  if (typeof mediaType !== 'string' || mediaType.toLowerCase() !== expected.mediaType) {
    throw new ValidationError(`文件类型必须是 ${expected.mediaType}`, 'INVALID_MEDIA_MIME');
  }
  return expected;
}

export async function validateCanonicalUploadHeader(filePath, container) {
  const handle = await open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    const readLength = Math.min(fileStat.size, 4096);
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    const valid = container === 'mp4'
      ? isMp4Header(header, fileStat.size)
      : container === 'webm' && isWebmHeader(header);
    if (!valid) {
      throw new ValidationError(
        container === 'mp4' ? '文件没有有效的 MP4 容器头' : '文件没有有效的 WebM EBML 头',
        'INVALID_MEDIA_HEADER'
      );
    }
  } finally {
    await handle.close();
  }
}

export function normalizeSourceFilename(value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : String(fallback || 'video');
  const name = raw.split(/[\\/]/).pop()?.trim() || 'video';
  if (name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ValidationError('源文件名过长或包含非法字符', 'INVALID_SOURCE_FILENAME');
  }
  return name;
}
