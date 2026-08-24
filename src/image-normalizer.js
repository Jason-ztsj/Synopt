import crypto from 'node:crypto';
import path from 'node:path';
import { open, stat, unlink } from 'node:fs/promises';

import { ValidationError } from './errors.js';
import { runBoundedProcess } from './media-validator.js';

const NORMALIZE_TIMEOUT_MS = 30_000;
const NORMALIZE_STDOUT_LIMIT = 64 * 1024;
const NORMALIZE_STDERR_LIMIT = 128 * 1024;

const IMAGE_TYPES = Object.freeze({
  '.jpg': Object.freeze({ mediaType: 'image/jpeg' }),
  '.jpeg': Object.freeze({ mediaType: 'image/jpeg' }),
  '.png': Object.freeze({ mediaType: 'image/png' }),
  '.webp': Object.freeze({ mediaType: 'image/webp' })
});

function jpegDimensions(buffer) {
  if (
    buffer.length < 4
    || buffer[0] !== 0xff
    || buffer[1] !== 0xd8
    || buffer[buffer.length - 2] !== 0xff
    || buffer[buffer.length - 1] !== 0xd9
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
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += length;
  }
  return null;
}

function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    buffer.length < 36
    || !buffer.subarray(0, 8).equals(signature)
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
    buffer.length < 30
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
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
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  return null;
}

async function readWholeFile(filePath, size) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function dimensionsFor(buffer, mediaType) {
  if (mediaType === 'image/jpeg') return jpegDimensions(buffer);
  if (mediaType === 'image/png') return pngDimensions(buffer);
  if (mediaType === 'image/webp') return webpDimensions(buffer);
  return null;
}

async function removeTemporaryFile(filePath) {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function decodingFailure(label, code) {
  return new ValidationError(
    `${label}无法完整解码，文件可能损坏或格式伪造`,
    code
  );
}

export async function validateAndNormalizeImage(file, {
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  label,
  codePrefix,
  minBytes = 24,
  maxBytes,
  validateDimensions
}) {
  if (!file?.path) {
    throw new ValidationError(`${label}文件无效`, `INVALID_${codePrefix}`);
  }

  const extension = path.extname(file.originalname || '').toLowerCase();
  const expected = IMAGE_TYPES[extension];
  if (!expected || expected.mediaType !== String(file.mimetype || '').toLowerCase()) {
    throw new ValidationError(
      `${label}只接受扩展名、文件类型一致的 JPEG、PNG 或 WebP 图片`,
      `INVALID_${codePrefix}_TYPE`
    );
  }

  const inputInfo = await stat(file.path);
  if (!inputInfo.isFile() || inputInfo.size < minBytes || inputInfo.size > maxBytes) {
    throw new ValidationError(
      `${label}文件大小必须为 ${minBytes} 字节至 ${Math.floor(maxBytes / 1024 / 1024)} MiB`,
      `INVALID_${codePrefix}_SIZE`
    );
  }

  const inputBytes = await readWholeFile(file.path, inputInfo.size);
  const inputDimensions = dimensionsFor(inputBytes, expected.mediaType);
  if (!inputDimensions?.width || !inputDimensions?.height) {
    throw new ValidationError(
      `无法读取${label}图片结构或尺寸，文件可能损坏或格式伪造`,
      `INVALID_${codePrefix}_STRUCTURE`
    );
  }
  validateDimensions(inputDimensions);

  const normalizedPath = path.join(
    path.dirname(file.path),
    `${crypto.randomUUID()}.normalized-image.webp`
  );
  let keepNormalizedFile = false;
  try {
    const result = await runBoundedProcess(ffmpegPath, [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'repeat+level+warning',
      '-xerror',
      '-max_alloc', '268435456',
      '-protocol_whitelist', 'file',
      '-threads', '1',
      '-filter_threads', '1',
      '-err_detect', 'crccheck+bitstream+buffer+explode',
      '-i', file.path,
      '-map', '0:v:0',
      '-frames:v', '1',
      '-an', '-sn', '-dn',
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      '-c:v', 'libwebp',
      '-quality', '85',
      '-compression_level', '4',
      '-preset', 'picture',
      '-f', 'webp',
      '-y', normalizedPath
    ], {
      timeoutMs: NORMALIZE_TIMEOUT_MS,
      maxStdoutBytes: NORMALIZE_STDOUT_LIMIT,
      maxStderrBytes: NORMALIZE_STDERR_LIMIT
    });

    if (
      result.timedOut
      || result.signal
      || result.stdoutOverflow
      || result.stderrOverflow
      || result.code !== 0
    ) {
      throw decodingFailure(label, `INVALID_${codePrefix}_PIXELS`);
    }

    const outputInfo = await stat(normalizedPath);
    if (!outputInfo.isFile() || outputInfo.size < minBytes || outputInfo.size > maxBytes) {
      throw new ValidationError(
        `${label}规范化后的文件大小超出允许范围`,
        `INVALID_${codePrefix}_NORMALIZED_SIZE`
      );
    }
    const outputBytes = await readWholeFile(normalizedPath, outputInfo.size);
    const outputDimensions = webpDimensions(outputBytes);
    if (!outputDimensions?.width || !outputDimensions?.height) {
      throw new ValidationError(
        `${label}规范化输出无效`,
        `INVALID_${codePrefix}_NORMALIZED_STRUCTURE`
      );
    }
    validateDimensions(outputDimensions);

    keepNormalizedFile = true;
    return {
      mediaType: 'image/webp',
      extension: '.webp',
      width: outputDimensions.width,
      height: outputDimensions.height,
      byteSize: outputInfo.size,
      normalizedPath
    };
  } finally {
    if (!keepNormalizedFile) await removeTemporaryFile(normalizedPath);
  }
}
