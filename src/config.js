import path from 'node:path';

const DEFAULTS = Object.freeze({
  PORT: '3000',
  DATABASE_PATH: './data/gongying.sqlite',
  VIDEO_STORAGE_PATH: './data/videos',
  MAX_UPLOAD_MB: '90',
  DISCUSSION_COOLDOWN_SECONDS: '30',
  SESSION_TTL_HOURS: '168',
  SESSION_COOKIE_SECURE: 'false',
  AUTH_COOLDOWN_SECONDS: '2',
  CLIENT_IP_MODE: 'direct',
  MAX_VIDEO_DURATION_SECONDS: '7200',
  MAX_VIDEO_WIDTH: '4096',
  MAX_VIDEO_HEIGHT: '4096',
  MAX_VIDEO_PIXELS: '8847360',
  MAX_VIDEO_FPS: '120',
  MEDIA_DECODE_ERROR_RATE: '0.001',
  MEDIA_VALIDATION_POLL_MS: '1000',
  MEDIA_VALIDATION_STALE_MINUTES: '30',
  MEDIA_VALIDATION_THREADS: '2',
  FFPROBE_PATH: 'ffprobe',
  FFMPEG_PATH: 'ffmpeg'
});

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`配置 ${name} 不能为空`);
  }
  if (value.includes('\0')) throw new Error(`配置 ${name} 包含非法字符`);
  return value.trim();
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^[0-9]+$/.test(String(value))) {
    throw new Error(`配置 ${name} 必须是正整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`配置 ${name} 超出允许范围`);
  }
  return parsed;
}

function positiveNumber(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = String(value);
  if (raw.trim() === '' || !Number.isFinite(Number(raw))) {
    throw new Error(`配置 ${name} 必须是正数`);
  }
  const parsed = Number(raw);
  if (parsed <= 0 || parsed > maximum) throw new Error(`配置 ${name} 超出允许范围`);
  return parsed;
}

function booleanValue(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`配置 ${name} 必须是 true 或 false`);
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const read = (key) => env[key] ?? DEFAULTS[key];
  const port = positiveInteger(read('PORT'), 'PORT', 65535);
  const databasePath = path.resolve(cwd, requiredText(read('DATABASE_PATH'), 'DATABASE_PATH'));
  const videoStoragePath = path.resolve(cwd, requiredText(read('VIDEO_STORAGE_PATH'), 'VIDEO_STORAGE_PATH'));
  const maxUploadMb = positiveNumber(read('MAX_UPLOAD_MB'), 'MAX_UPLOAD_MB');
  const cooldownSeconds = positiveInteger(read('DISCUSSION_COOLDOWN_SECONDS'), 'DISCUSSION_COOLDOWN_SECONDS');
  const sessionTtlHours = positiveInteger(read('SESSION_TTL_HOURS'), 'SESSION_TTL_HOURS', 8760);
  const sessionCookieSecure = booleanValue(read('SESSION_COOKIE_SECURE'), 'SESSION_COOKIE_SECURE');
  const authCooldownSeconds = positiveInteger(read('AUTH_COOLDOWN_SECONDS'), 'AUTH_COOLDOWN_SECONDS', 3600);
  const clientIpMode = requiredText(read('CLIENT_IP_MODE'), 'CLIENT_IP_MODE');
  const maxVideoDurationSeconds = positiveInteger(read('MAX_VIDEO_DURATION_SECONDS'), 'MAX_VIDEO_DURATION_SECONDS', 24 * 60 * 60);
  const maxVideoWidth = positiveInteger(read('MAX_VIDEO_WIDTH'), 'MAX_VIDEO_WIDTH', 16384);
  const maxVideoHeight = positiveInteger(read('MAX_VIDEO_HEIGHT'), 'MAX_VIDEO_HEIGHT', 16384);
  const maxVideoPixels = positiveInteger(read('MAX_VIDEO_PIXELS'), 'MAX_VIDEO_PIXELS', 268_435_456);
  const maxVideoFps = positiveNumber(read('MAX_VIDEO_FPS'), 'MAX_VIDEO_FPS', 1000);
  const mediaDecodeErrorRate = positiveNumber(read('MEDIA_DECODE_ERROR_RATE'), 'MEDIA_DECODE_ERROR_RATE', 1);
  const mediaValidationPollMs = positiveInteger(read('MEDIA_VALIDATION_POLL_MS'), 'MEDIA_VALIDATION_POLL_MS', 60_000);
  const mediaValidationStaleMinutes = positiveInteger(read('MEDIA_VALIDATION_STALE_MINUTES'), 'MEDIA_VALIDATION_STALE_MINUTES', 24 * 60);
  const mediaValidationThreads = positiveInteger(read('MEDIA_VALIDATION_THREADS'), 'MEDIA_VALIDATION_THREADS', 8);
  const ffprobePath = requiredText(read('FFPROBE_PATH'), 'FFPROBE_PATH');
  const ffmpegPath = requiredText(read('FFMPEG_PATH'), 'FFMPEG_PATH');

  if (!['direct', 'cloudflare'].includes(clientIpMode)) {
    throw new Error('配置 CLIENT_IP_MODE 只能是 direct 或 cloudflare');
  }

  const maxUploadBytes = Math.floor(maxUploadMb * 1024 * 1024);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) {
    throw new Error('配置 MAX_UPLOAD_MB 无法换算为安全的字节数');
  }

  return Object.freeze({
    port,
    databasePath,
    videoStoragePath,
    temporaryStoragePath: path.join(videoStoragePath, '.tmp'),
    pendingStoragePath: path.join(videoStoragePath, '.pending'),
    maxUploadMb,
    maxUploadBytes,
    discussionCooldownSeconds: cooldownSeconds,
    sessionTtlHours,
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    sessionCookieSecure,
    authCooldownSeconds,
    clientIpMode,
    maxVideoDurationSeconds,
    maxVideoWidth,
    maxVideoHeight,
    maxVideoPixels,
    maxVideoFps,
    mediaDecodeErrorRate,
    mediaValidationPollMs,
    mediaValidationStaleMs: mediaValidationStaleMinutes * 60 * 1000,
    mediaValidationThreads,
    ffprobePath,
    ffmpegPath
  });
}

export { DEFAULTS };
