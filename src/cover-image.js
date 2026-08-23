import path from 'node:path';
import { open, stat } from 'node:fs/promises';

import { ValidationError } from './errors.js';

export const COVER_RULES = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  minWidth: 1280,
  minHeight: 720,
  maxWidth: 3840,
  maxHeight: 2160,
  aspectWidth: 16,
  aspectHeight: 9
});

const TYPES = Object.freeze({
  '.jpg': { mediaType: 'image/jpeg', extension: '.jpg' },
  '.jpeg': { mediaType: 'image/jpeg', extension: '.jpg' },
  '.png': { mediaType: 'image/png', extension: '.png' },
  '.webp': { mediaType: 'image/webp', extension: '.webp' }
});

function jpegDimensions(buffer) {
  if (
    buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8
    || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9
  ) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    buffer.length < 36 || !buffer.subarray(0, 8).equals(signature)
    || buffer.toString('ascii', 12, 16) !== 'IHDR'
    || buffer.readUInt32BE(buffer.length - 12) !== 0
    || buffer.toString('ascii', buffer.length - 8, buffer.length - 4) !== 'IEND'
  ) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function webpDimensions(buffer) {
  if (
    buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WEBP'
    || buffer.readUInt32LE(4) + 8 !== buffer.length
  ) return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 };
  }
  if (chunk === 'VP8L' && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

export async function validateCoverImage(file) {
  if (!file?.path) throw new ValidationError('封面文件无效', 'INVALID_COVER');
  const extension = path.extname(file.originalname || '').toLowerCase();
  const expected = TYPES[extension];
  if (!expected || expected.mediaType !== String(file.mimetype || '').toLowerCase()) {
    throw new ValidationError('封面只接受 JPEG、PNG 或 WebP 图片', 'INVALID_COVER_TYPE');
  }
  const info = await stat(file.path);
  if (!info.isFile() || info.size < 24 || info.size > COVER_RULES.maxBytes) {
    throw new ValidationError('封面文件必须小于 5 MiB', 'INVALID_COVER_SIZE');
  }
  const handle = await open(file.path, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const dimensions = expected.mediaType === 'image/jpeg'
    ? jpegDimensions(buffer)
    : expected.mediaType === 'image/png'
      ? pngDimensions(buffer)
      : webpDimensions(buffer);
  if (!dimensions?.width || !dimensions?.height) {
    throw new ValidationError('无法读取封面图片结构或尺寸', 'INVALID_COVER_STRUCTURE');
  }
  const { width, height } = dimensions;
  if (
    width < COVER_RULES.minWidth || height < COVER_RULES.minHeight
    || width > COVER_RULES.maxWidth || height > COVER_RULES.maxHeight
    || width * COVER_RULES.aspectHeight !== height * COVER_RULES.aspectWidth
  ) {
    throw new ValidationError('封面必须是严格 16:9，尺寸为 1280×720 至 3840×2160', 'INVALID_COVER_DIMENSIONS');
  }
  return { ...expected, width, height, byteSize: info.size };
}
