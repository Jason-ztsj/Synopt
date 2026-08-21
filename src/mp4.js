import path from 'node:path';
import { open } from 'node:fs/promises';
import { ValidationError } from './errors.js';

export function isMp4Header(buffer, fileSize = buffer?.length) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  if (!Number.isSafeInteger(fileSize) || fileSize < 16) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;

  const boxSize = buffer.readUInt32BE(0);
  if (boxSize === 1) {
    if (buffer.length < 24 || fileSize < 24) return false;
    const extendedSize = buffer.readBigUInt64BE(8);
    return extendedSize >= 24n && extendedSize <= BigInt(fileSize);
  }
  return boxSize >= 16 && boxSize <= fileSize;
}

export function validateMp4Metadata(originalName, mediaType) {
  if (typeof originalName !== 'string' || path.extname(originalName).toLowerCase() !== '.mp4') {
    throw new ValidationError('只支持扩展名为 .mp4 的视频文件', 'INVALID_MP4_EXTENSION');
  }
  if (typeof mediaType !== 'string' || mediaType.toLowerCase() !== 'video/mp4') {
    throw new ValidationError('文件类型必须是 video/mp4', 'INVALID_MP4_MIME');
  }
}

export async function validateMp4File(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!isMp4Header(buffer.subarray(0, bytesRead), fileStat.size)) {
      throw new ValidationError('文件没有有效的 MP4 ftyp 文件头', 'INVALID_MP4_HEADER');
    }
  } finally {
    await handle.close();
  }
}
