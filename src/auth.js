import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from 'node:crypto';

const PASSWORD_VERSION = '1';
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function scrypt(password, salt, keyLength, options) {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function sha256(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('安全令牌必须是非空字符串');
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeHexEqual(leftHex, rightHex) {
  if (!/^[a-f0-9]{64}$/i.test(leftHex) || !/^[a-f0-9]{64}$/i.test(rightHex)) return false;
  return timingSafeEqual(Buffer.from(leftHex, 'hex'), Buffer.from(rightHex, 'hex'));
}

function decodeCanonicalBase64Url(value, expectedLength) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedLength || decoded.toString('base64url') !== value) return null;
  return decoded;
}

export function normalizeUsername(value) {
  if (typeof value !== 'string') return '';
  return value.trim().normalize('NFKC').toLowerCase();
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('密码必须是非空字符串');
  }
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const derivedKey = await scrypt(password, salt, PASSWORD_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY
  });
  return [
    'scrypt',
    PASSWORD_VERSION,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString('base64url'),
    derivedKey.toString('base64url')
  ].join('$');
}

export async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  const parts = encodedHash.split('$');
  if (parts.length !== 7) return false;

  const [algorithm, version, costText, blockSizeText, parallelizationText, saltText, keyText] = parts;
  if (
    algorithm !== 'scrypt'
    || version !== PASSWORD_VERSION
    || costText !== String(SCRYPT_COST)
    || blockSizeText !== String(SCRYPT_BLOCK_SIZE)
    || parallelizationText !== String(SCRYPT_PARALLELIZATION)
  ) return false;

  try {
    const salt = decodeCanonicalBase64Url(saltText, PASSWORD_SALT_BYTES);
    const expectedKey = decodeCanonicalBase64Url(keyText, PASSWORD_KEY_LENGTH);
    if (!salt || !expectedKey) return false;
    const actualKey = await scrypt(password, salt, expectedKey.length, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: SCRYPT_MAX_MEMORY
    });
    return timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  }
}

export function generateSessionToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token) {
  return sha256(token);
}

export function generateCsrfToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashCsrfToken(token) {
  return sha256(token);
}

export function verifyCsrfToken(token, expectedHash) {
  if (typeof token !== 'string' || typeof expectedHash !== 'string') return false;
  try {
    return safeHexEqual(hashCsrfToken(token), expectedHash);
  } catch {
    return false;
  }
}
