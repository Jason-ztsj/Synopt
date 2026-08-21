import path from 'node:path';

const DEFAULTS = Object.freeze({
  PORT: '3000',
  DATABASE_PATH: './data/gongying.sqlite',
  VIDEO_STORAGE_PATH: './data/videos',
  MAX_UPLOAD_MB: '90',
  DISCUSSION_COOLDOWN_SECONDS: '30',
  CLIENT_IP_MODE: 'direct'
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

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const read = (key) => env[key] ?? DEFAULTS[key];
  const port = positiveInteger(read('PORT'), 'PORT', 65535);
  const databasePath = path.resolve(cwd, requiredText(read('DATABASE_PATH'), 'DATABASE_PATH'));
  const videoStoragePath = path.resolve(cwd, requiredText(read('VIDEO_STORAGE_PATH'), 'VIDEO_STORAGE_PATH'));
  const maxUploadMb = positiveNumber(read('MAX_UPLOAD_MB'), 'MAX_UPLOAD_MB');
  const cooldownSeconds = positiveInteger(read('DISCUSSION_COOLDOWN_SECONDS'), 'DISCUSSION_COOLDOWN_SECONDS');
  const clientIpMode = requiredText(read('CLIENT_IP_MODE'), 'CLIENT_IP_MODE');

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
    maxUploadMb,
    maxUploadBytes,
    discussionCooldownSeconds: cooldownSeconds,
    clientIpMode
  });
}

export { DEFAULTS };
