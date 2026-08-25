import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../../src/config.js';

test('配置默认值、相对路径与 MiB 字节换算正确', () => {
  const cwd = '/tmp/synopt-config-test';
  const config = loadConfig({}, cwd);
  assert.equal(config.port, 3000);
  assert.equal(config.databasePath, path.join(cwd, 'data/synopt.sqlite'));
  assert.equal(config.videoStoragePath, path.join(cwd, 'data/videos'));
  assert.equal(config.avatarStoragePath, path.join(cwd, 'data/avatars'));
  assert.equal(config.temporaryStoragePath, path.join(cwd, 'data/videos/.tmp'));
  assert.equal(config.pendingStoragePath, path.join(cwd, 'data/videos/.pending'));
  assert.equal(config.maxUploadBytes, 1024 * 1024 * 1024);
  assert.equal(config.discussionCooldownSeconds, 30);
  assert.equal(config.sessionTtlHours, 168);
  assert.equal(config.sessionTtlMs, 168 * 60 * 60 * 1000);
  assert.equal(config.sessionCookieSecure, false);
  assert.equal(config.authCooldownSeconds, 2);
  assert.equal(config.cmsReauthMinutes, 30);
  assert.equal(config.cmsReauthMs, 30 * 60 * 1000);
  assert.equal(config.cmsPrivateMediaGrantMinutes, 15);
  assert.equal(config.cmsPrivateMediaGrantMs, 15 * 60 * 1000);
  assert.equal(config.reportCooldownSeconds, 30);
  assert.equal(config.appealWindowDays, 30);
  assert.equal(config.appealWindowMs, 30 * 24 * 60 * 60 * 1000);
  assert.equal(config.clientIpMode, 'direct');
  assert.equal(config.maxVideoDurationSeconds, 7200);
  assert.equal(config.maxVideoPixels, 8847360);
  assert.equal(config.mediaDecodeErrorRate, 0.001);
  assert.equal(config.mediaValidationThreads, 2);
  assert.equal(config.imageNormalizationConcurrency, 2);
  assert.equal(config.imageNormalizationCooldownSeconds, 10);
});

test('配置接受 Cloudflare 模式和绝对路径', () => {
  const config = loadConfig({
    PORT: '8080',
    DATABASE_PATH: '/var/lib/synopt/db.sqlite',
    VIDEO_STORAGE_PATH: '/srv/synopt/videos',
    MAX_UPLOAD_MB: '1.5',
    DISCUSSION_COOLDOWN_SECONDS: '45',
    SESSION_TTL_HOURS: '24',
    SESSION_COOKIE_SECURE: 'TRUE',
    AUTH_COOLDOWN_SECONDS: '5',
    CMS_REAUTH_MINUTES: '45',
    CMS_PRIVATE_MEDIA_GRANT_MINUTES: '12',
    REPORT_COOLDOWN_SECONDS: '75',
    APPEAL_WINDOW_DAYS: '60',
    CLIENT_IP_MODE: 'cloudflare',
    IMAGE_NORMALIZATION_CONCURRENCY: '4',
    IMAGE_NORMALIZATION_COOLDOWN_SECONDS: '45'
  });
  assert.equal(config.port, 8080);
  assert.equal(config.maxUploadBytes, Math.floor(1.5 * 1024 * 1024));
  assert.equal(config.sessionTtlHours, 24);
  assert.equal(config.sessionTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(config.sessionCookieSecure, true);
  assert.equal(config.authCooldownSeconds, 5);
  assert.equal(config.cmsReauthMinutes, 45);
  assert.equal(config.cmsReauthMs, 45 * 60 * 1000);
  assert.equal(config.cmsPrivateMediaGrantMinutes, 12);
  assert.equal(config.cmsPrivateMediaGrantMs, 12 * 60 * 1000);
  assert.equal(config.reportCooldownSeconds, 75);
  assert.equal(config.appealWindowDays, 60);
  assert.equal(config.appealWindowMs, 60 * 24 * 60 * 60 * 1000);
  assert.equal(config.clientIpMode, 'cloudflare');
  assert.equal(config.imageNormalizationConcurrency, 4);
  assert.equal(config.imageNormalizationCooldownSeconds, 45);
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
    { CMS_REAUTH_MINUTES: '0' },
    { CMS_REAUTH_MINUTES: '1441' },
    { CMS_REAUTH_MINUTES: '1.5' },
    { CMS_PRIVATE_MEDIA_GRANT_MINUTES: '0' },
    { CMS_PRIVATE_MEDIA_GRANT_MINUTES: '1441' },
    { CMS_PRIVATE_MEDIA_GRANT_MINUTES: '1.5' },
    { REPORT_COOLDOWN_SECONDS: '0' },
    { REPORT_COOLDOWN_SECONDS: '86401' },
    { REPORT_COOLDOWN_SECONDS: '1.5' },
    { APPEAL_WINDOW_DAYS: '0' },
    { APPEAL_WINDOW_DAYS: '3651' },
    { APPEAL_WINDOW_DAYS: '1.5' },
    { CLIENT_IP_MODE: 'forwarded' },
    { MAX_VIDEO_DURATION_SECONDS: '0' },
    { MAX_VIDEO_WIDTH: '20000' },
    { MAX_VIDEO_PIXELS: 'not-a-number' },
    { MEDIA_DECODE_ERROR_RATE: '0' },
    { MEDIA_DECODE_ERROR_RATE: '1.1' },
    { MEDIA_VALIDATION_THREADS: '9' },
    { IMAGE_NORMALIZATION_CONCURRENCY: '0' },
    { IMAGE_NORMALIZATION_CONCURRENCY: '9' },
    { IMAGE_NORMALIZATION_CONCURRENCY: '1.5' },
    { IMAGE_NORMALIZATION_COOLDOWN_SECONDS: '0' },
    { IMAGE_NORMALIZATION_COOLDOWN_SECONDS: '3601' },
    { IMAGE_NORMALIZATION_COOLDOWN_SECONDS: '1.5' },
    { FFPROBE_PATH: ' ' }
  ];
  for (const overrides of invalid) {
    assert.throws(() => loadConfig(overrides), /配置/);
  }
});
