import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../../src/config.js';

test('配置默认值、相对路径与 MiB 字节换算正确', () => {
  const cwd = '/tmp/gongying-config-test';
  const config = loadConfig({}, cwd);
  assert.equal(config.port, 3000);
  assert.equal(config.databasePath, path.join(cwd, 'data/gongying.sqlite'));
  assert.equal(config.videoStoragePath, path.join(cwd, 'data/videos'));
  assert.equal(config.temporaryStoragePath, path.join(cwd, 'data/videos/.tmp'));
  assert.equal(config.pendingStoragePath, path.join(cwd, 'data/videos/.pending'));
  assert.equal(config.maxUploadBytes, 90 * 1024 * 1024);
  assert.equal(config.discussionCooldownSeconds, 30);
  assert.equal(config.sessionTtlHours, 168);
  assert.equal(config.sessionTtlMs, 168 * 60 * 60 * 1000);
  assert.equal(config.sessionCookieSecure, false);
  assert.equal(config.authCooldownSeconds, 2);
  assert.equal(config.clientIpMode, 'direct');
  assert.equal(config.maxVideoDurationSeconds, 7200);
  assert.equal(config.maxVideoPixels, 8847360);
  assert.equal(config.mediaDecodeErrorRate, 0.001);
  assert.equal(config.mediaValidationThreads, 2);
});

test('配置接受 Cloudflare 模式和绝对路径', () => {
  const config = loadConfig({
    PORT: '8080',
    DATABASE_PATH: '/var/lib/gongying/db.sqlite',
    VIDEO_STORAGE_PATH: '/srv/gongying/videos',
    MAX_UPLOAD_MB: '1.5',
    DISCUSSION_COOLDOWN_SECONDS: '45',
    SESSION_TTL_HOURS: '24',
    SESSION_COOKIE_SECURE: 'TRUE',
    AUTH_COOLDOWN_SECONDS: '5',
    CLIENT_IP_MODE: 'cloudflare'
  });
  assert.equal(config.port, 8080);
  assert.equal(config.maxUploadBytes, Math.floor(1.5 * 1024 * 1024));
  assert.equal(config.sessionTtlHours, 24);
  assert.equal(config.sessionTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(config.sessionCookieSecure, true);
  assert.equal(config.authCooldownSeconds, 5);
  assert.equal(config.clientIpMode, 'cloudflare');
});

test('非法配置在启动解析阶段立即报错', () => {
  const invalid = [
    { PORT: '0' },
    { PORT: '65536' },
    { PORT: '3.14' },
    { DATABASE_PATH: ' ' },
    { VIDEO_STORAGE_PATH: '\0bad' },
    { MAX_UPLOAD_MB: '0' },
    { MAX_UPLOAD_MB: 'not-a-number' },
    { DISCUSSION_COOLDOWN_SECONDS: '-1' },
    { DISCUSSION_COOLDOWN_SECONDS: '1.5' },
    { SESSION_TTL_HOURS: '0' },
    { SESSION_TTL_HOURS: '8761' },
    { SESSION_COOKIE_SECURE: 'yes' },
    { AUTH_COOLDOWN_SECONDS: '0' },
    { AUTH_COOLDOWN_SECONDS: '1.5' },
    { CLIENT_IP_MODE: 'forwarded' },
    { MAX_VIDEO_DURATION_SECONDS: '0' },
    { MAX_VIDEO_WIDTH: '20000' },
    { MAX_VIDEO_PIXELS: 'not-a-number' },
    { MEDIA_DECODE_ERROR_RATE: '0' },
    { MEDIA_DECODE_ERROR_RATE: '1.1' },
    { MEDIA_VALIDATION_THREADS: '9' },
    { FFPROBE_PATH: ' ' }
  ];
  for (const overrides of invalid) {
    assert.throws(() => loadConfig(overrides), /配置/);
  }
});
