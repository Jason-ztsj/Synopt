import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { CURRENT_SCHEMA_VERSION, openDatabase } from '../../src/database.js';

function video(id, createdAt) {
  return {
    id,
    title: `标题 ${id}`,
    creator: '测试创作者',
    description: '',
    licenseCode: 'CC-BY-4.0',
    storageName: `${id}.mp4`,
    originalFilename: `${id}.mp4`,
    mediaType: 'video/mp4',
    byteSize: 24,
    container: 'mp4',
    videoCodec: 'unknown',
    audioCodec: null,
    playbackStrategy: 'native',
    validationStatus: 'ready',
    sha256: null,
    durationSeconds: null,
    width: null,
    height: null,
    frameRate: null,
    validationWarningCount: 0,
    validationSummary: {},
    validationStartedAt: null,
    validatedAt: null,
    sourceContainer: null,
    sourceVideoCodec: null,
    sourceAudioCodec: null,
    ingestOperation: 'unknown',
    userId: null,
    accountUsername: null,
    accountDisplayName: null,
    createdAt
  };
}

test('SQLite 持久化映射正确，视频倒序、讨论正序且查询索引实际存在', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gongying-db-test-'));
  const databasePath = path.join(directory, 'nested', 'test.sqlite');
  let database;
  try {
    database = openDatabase(databasePath);
    database.insertVideo(video('video-a', '2026-08-19T09:00:00.000Z'));
    database.insertVideo(video('video-b', '2026-08-19T10:00:00.000Z'));
    database.insertVideo(video('video-c', '2026-08-19T10:00:00.000Z'));

    assert.equal(database.health(), true);
    assert.equal(database.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(database.listVideos().map((entry) => entry.id), ['video-c', 'video-b', 'video-a']);
    assert.deepEqual(database.getVideo('video-b'), video('video-b', '2026-08-19T10:00:00.000Z'));
    assert.equal(database.getVideo('missing'), null);

    const second = database.insertDiscussion({
      videoId: 'video-b',
      nickname: '青色海燕222',
      bodyMarkdown: '第二条（先插入但时间较晚）',
      createdAt: '2026-08-19T11:00:01.000Z'
    });
    const first = database.insertDiscussion({
      videoId: 'video-b',
      nickname: '月白灯塔111',
      bodyMarkdown: '第一条（后插入但时间较早）',
      createdAt: '2026-08-19T11:00:00.000Z'
    });
    assert.ok(second.id < first.id);
    assert.deepEqual(
      database.listDiscussions('video-b').map((entry) => entry.bodyMarkdown),
      ['第一条（后插入但时间较早）', '第二条（先插入但时间较晚）']
    );

    const videoIndexes = database.raw.prepare("PRAGMA index_list('videos')").all().map((row) => row.name);
    const discussionIndexes = database.raw.prepare("PRAGMA index_list('discussions')").all().map((row) => row.name);
    assert.ok(videoIndexes.includes('idx_videos_created_at_id'));
    assert.ok(discussionIndexes.includes('idx_discussions_video_created_at_id'));

    const videoIndexColumns = database.raw.prepare("PRAGMA index_info('idx_videos_created_at_id')").all().map((row) => row.name);
    const discussionIndexColumns = database.raw.prepare("PRAGMA index_info('idx_discussions_video_created_at_id')").all().map((row) => row.name);
    assert.deepEqual(videoIndexColumns, ['created_at', 'id']);
    assert.deepEqual(discussionIndexColumns, ['video_id', 'created_at', 'id']);

    const discussionColumns = database.raw.prepare("PRAGMA table_info('discussions')").all().map((row) => row.name);
    assert.equal(discussionColumns.some((name) => /(?:^|_)ip(?:_|$)/i.test(name)), false);
    assert.ok(discussionColumns.includes('user_id'));
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('账号查找大小写不敏感，内容关联账号且会话可过期、轮换 CSRF 和撤销', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-account-db-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'test.sqlite'));
    const user = database.createUser({
      id: 'user-1',
      username: 'alice_dev',
      displayName: '爱丽丝',
      passwordHash: 'scrypt-test-value',
      createdAt: '2026-08-20T00:00:00.000Z'
    });
    assert.deepEqual(database.findUserByUsername('ALICE_DEV'), user);
    assert.deepEqual(database.getUserById('user-1'), user);
    assert.throws(() => database.createUser({ ...user, id: 'user-2', username: 'Alice_Dev' }), /UNIQUE/i);

    database.insertVideo({
      ...video('account-video', '2026-08-20T01:00:00.000Z'),
      userId: user.id
    });
    const storedVideo = database.getVideo('account-video');
    assert.equal(storedVideo.userId, user.id);
    assert.equal(storedVideo.accountUsername, 'alice_dev');
    assert.equal(storedVideo.accountDisplayName, '爱丽丝');

    const discussion = database.insertDiscussion({
      videoId: storedVideo.id,
      nickname: user.displayName,
      bodyMarkdown: '账号讨论',
      userId: user.id,
      createdAt: '2026-08-20T02:00:00.000Z'
    });
    assert.equal(discussion.userId, user.id);
    assert.equal(discussion.accountUsername, 'alice_dev');
    assert.equal(discussion.accountDisplayName, '爱丽丝');

    const tokenHash = 'a'.repeat(64);
    const originalCsrfHash = 'b'.repeat(64);
    const rotatedCsrfHash = 'c'.repeat(64);
    const session = database.createSession({
      tokenHash,
      userId: user.id,
      csrfTokenHash: originalCsrfHash,
      createdAt: '2026-08-20T03:00:00.000Z',
      expiresAt: '2026-08-27T03:00:00.000Z'
    });
    assert.equal(session.tokenHash, tokenHash);
    assert.equal(session.user.passwordHash, undefined);
    assert.equal(session.user.displayName, user.displayName);
    assert.equal(database.findSessionByTokenHash(tokenHash, '2026-08-21T00:00:00.000Z').csrfTokenHash, originalCsrfHash);
    assert.equal(database.findSessionByTokenHash(tokenHash, '2026-08-27T03:00:00.000Z'), null);
    assert.equal(database.updateSessionCsrfToken(tokenHash, rotatedCsrfHash), 1);
    assert.equal(database.findSessionByTokenHash(tokenHash, '2026-08-21T00:00:00.000Z').csrfTokenHash, rotatedCsrfHash);
    assert.throws(() => database.createSession({
      tokenHash: 'raw-session-token'.padEnd(43, 'x'),
      userId: user.id,
      csrfTokenHash: originalCsrfHash,
      createdAt: '2026-08-20T03:00:00.000Z',
      expiresAt: '2026-08-27T03:00:00.000Z'
    }), /SHA-256/);
    assert.throws(() => database.updateSessionCsrfToken(tokenHash, 'raw-csrf-token'.padEnd(43, 'x')), /SHA-256/);
    assert.equal(database.findSessionByTokenHash('not-a-hash'), null);
    assert.equal(database.revokeSession(tokenHash), 1);
    assert.equal(database.revokeSession(tokenHash), 0);

    database.createSession({
      tokenHash: 'd'.repeat(64),
      userId: user.id,
      csrfTokenHash: 'e'.repeat(64),
      createdAt: '2026-08-20T03:00:00.000Z',
      expiresAt: '2026-08-20T04:00:00.000Z'
    });
    database.createSession({
      tokenHash: 'f'.repeat(64),
      userId: user.id,
      csrfTokenHash: '1'.repeat(64),
      createdAt: '2026-08-20T03:00:00.000Z',
      expiresAt: '2026-08-30T04:00:00.000Z'
    });
    assert.equal(database.cleanupExpiredSessions('2026-08-21T00:00:00.000Z'), 1);
    assert.ok(database.findSessionByTokenHash('f'.repeat(64), '2026-08-21T00:00:00.000Z'));

    const unicodeUser = database.createUser({
      id: 'user-unicode',
      username: 'unicode_user',
      displayName: '🚀'.repeat(40),
      passwordHash: 'scrypt-test-value',
      createdAt: '2026-08-20T05:00:00.000Z'
    });
    assert.equal(Array.from(unicodeUser.displayName).length, 40);
    assert.throws(() => database.createUser({
      ...unicodeUser,
      id: 'user-unicode-too-long',
      username: 'unicode_user_2',
      displayName: '🚀'.repeat(41)
    }), /CHECK/i);

    database.raw.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    assert.equal(database.findSessionByTokenHash('f'.repeat(64), '2026-08-21T00:00:00.000Z'), null);
    assert.equal(database.getVideo(storedVideo.id).userId, null);
    assert.equal(database.listDiscussions(storedVideo.id)[0].userId, null);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('schema v0 无账号数据库迁移到 v2，并保留视频、讨论和外键行为', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-migration-test-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  let database;
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        creator TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        license_code TEXT NOT NULL,
        storage_name TEXT NOT NULL UNIQUE,
        original_filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE discussions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL,
        body_markdown TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO videos VALUES (
        'legacy-video', '旧视频', '旧署名', '', 'CC-BY-4.0', 'legacy.mp4', 'legacy.mp4', 'video/mp4', 24,
        '2026-08-19T00:00:00.000Z'
      );
      INSERT INTO discussions (video_id, nickname, body_markdown, created_at) VALUES (
        'legacy-video', '月白灯塔111', '旧讨论', '2026-08-19T01:00:00.000Z'
      );
    `);
    legacy.close();

    database = openDatabase(databasePath);
    assert.equal(database.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.equal(CURRENT_SCHEMA_VERSION, 2);
    assert.equal(database.raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
    const migratedVideo = database.getVideo('legacy-video');
    assert.equal(migratedVideo.title, '旧视频');
    assert.equal(migratedVideo.userId, null);
    assert.equal(migratedVideo.container, 'mp4');
    assert.equal(migratedVideo.videoCodec, 'unknown');
    assert.equal(migratedVideo.audioCodec, null);
    assert.equal(migratedVideo.validationStatus, 'ready');
    assert.deepEqual(migratedVideo.validationSummary, { legacyUnverified: true });
    assert.deepEqual(database.listVideos().map((entry) => entry.id), ['legacy-video']);
    const migratedDiscussion = database.listDiscussions('legacy-video')[0];
    assert.equal(migratedDiscussion.bodyMarkdown, '旧讨论');
    assert.equal(migratedDiscussion.nickname, '月白灯塔111');
    assert.equal(migratedDiscussion.userId, null);
    assert.ok(database.raw.prepare("PRAGMA table_info('users')").all().length > 0);
    assert.ok(database.raw.prepare("PRAGMA table_info('sessions')").all().length > 0);

    database.raw.prepare('DELETE FROM videos WHERE id = ?').run('legacy-video');
    assert.deepEqual(database.listDiscussions('legacy-video'), []);
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('schema v1 带账号数据迁移到 v2，完整保留账号、会话、视频和讨论关联', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-v1-migration-test-'));
  const databasePath = path.join(directory, 'v1.sqlite');
  let database;
  try {
    const longOriginalFilename = `${'x'.repeat(252)}.mp4`;
    assert.equal(longOriginalFilename.length, 256);
    const v1 = new DatabaseSync(databasePath);
    v1.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(username) BETWEEN 3 AND 32),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
        password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 512),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token_hash TEXT NOT NULL CHECK (length(csrf_token_hash) = 64),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        creator TEXT NOT NULL CHECK (length(creator) BETWEEN 1 AND 80),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
        license_code TEXT NOT NULL CHECK (license_code IN ('CC0-1.0', 'CC-BY-4.0', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-ND-4.0')),
        storage_name TEXT NOT NULL UNIQUE,
        original_filename TEXT NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type = 'video/mp4'),
        byte_size INTEGER NOT NULL CHECK (byte_size > 0),
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE discussions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL,
        body_markdown TEXT NOT NULL CHECK (length(body_markdown) BETWEEN 1 AND 5000),
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO users VALUES (
        'v1-user', 'v1_author', '旧版作者', 'scrypt-v1-value', '2026-08-20T00:00:00.000Z'
      );
      INSERT INTO sessions VALUES (
        '${'a'.repeat(64)}', 'v1-user', '${'b'.repeat(64)}',
        '2026-08-20T00:30:00.000Z', '2026-09-20T00:30:00.000Z'
      );
      INSERT INTO videos VALUES (
        'v1-video', '账号视频', '旧版署名', '保留描述', 'CC-BY-NC-4.0',
        'v1-video.mp4', '${longOriginalFilename}', 'video/mp4', 2048, 'v1-user',
        '2026-08-20T01:00:00.000Z'
      );
      INSERT INTO discussions (video_id, nickname, body_markdown, user_id, created_at) VALUES (
        'v1-video', '旧版作者', '保留讨论', 'v1-user', '2026-08-20T02:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    v1.close();

    database = openDatabase(databasePath);
    assert.equal(database.getSchemaVersion(), 2);
    assert.equal(database.raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);

    const user = database.getUserById('v1-user');
    assert.equal(user.username, 'v1_author');
    assert.equal(user.displayName, '旧版作者');
    const session = database.findSessionByTokenHash('a'.repeat(64), '2026-08-21T00:00:00.000Z');
    assert.equal(session.userId, user.id);
    assert.equal(session.csrfTokenHash, 'b'.repeat(64));

    const migratedVideo = database.getVideo('v1-video');
    assert.equal(migratedVideo.title, '账号视频');
    assert.equal(migratedVideo.description, '保留描述');
    assert.equal(migratedVideo.licenseCode, 'CC-BY-NC-4.0');
    assert.equal(migratedVideo.originalFilename, longOriginalFilename);
    assert.equal(migratedVideo.userId, user.id);
    assert.equal(migratedVideo.accountUsername, user.username);
    assert.equal(migratedVideo.validationStatus, 'ready');
    assert.deepEqual(migratedVideo.validationSummary, { legacyUnverified: true });

    const migratedDiscussion = database.listDiscussions('v1-video')[0];
    assert.equal(migratedDiscussion.bodyMarkdown, '保留讨论');
    assert.equal(migratedDiscussion.userId, user.id);
    assert.equal(migratedDiscussion.accountDisplayName, user.displayName);
    assert.ok(database.raw.prepare("PRAGMA index_list('videos')").all()
      .some((entry) => entry.name === 'idx_videos_validation_status_created_at'));

    database.raw.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    assert.equal(database.getVideo('v1-video').userId, null);
    assert.equal(database.listDiscussions('v1-video')[0].userId, null);
    assert.equal(database.findSessionByTokenHash('a'.repeat(64), '2026-08-21T00:00:00.000Z'), null);
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('验证状态机按时间领取 pending，并正确完成、警告、拒绝、失败和重试', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-validation-state-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'test.sqlite'));
    const pending = (id, createdAt, overrides = {}) => ({
      ...video(id, createdAt),
      validationStatus: 'pending',
      sourceContainer: 'matroska',
      sourceVideoCodec: 'vp9',
      sourceAudioCodec: 'opus',
      ingestOperation: 'remux',
      ...overrides
    });
    database.insertVideo(pending('finish-ready', '2026-08-22T01:00:00.000Z'));
    database.insertVideo(pending('finish-warning', '2026-08-22T02:00:00.000Z', {
      storageName: 'finish-warning.webm',
      originalFilename: 'finish-warning.webm',
      mediaType: 'video/webm',
      container: 'webm'
    }));
    database.insertVideo(pending('finish-rejected', '2026-08-22T03:00:00.000Z'));
    database.insertVideo(pending('finish-failed', '2026-08-22T04:00:00.000Z'));
    database.insertVideo(pending('finish-stale', '2026-08-22T05:00:00.000Z'));

    assert.deepEqual(database.listVideos(), []);
    const readyResult = {
      mediaType: 'video/mp4',
      container: 'mp4',
      videoCodec: 'avc',
      audioCodec: 'aac',
      playbackStrategy: 'native',
      sha256: '1'.repeat(64),
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      frameRate: 30,
      warningCount: 0,
      summary: { decodedFrames: 375 }
    };
    assert.equal(database.completeVideoValidation(
      'finish-ready',
      readyResult,
      '2026-08-22T01:10:00.000Z'
    ), 0);

    const readyClaim = database.claimNextVideoForValidation('2026-08-22T06:00:00.000Z');
    assert.equal(readyClaim.id, 'finish-ready');
    assert.equal(readyClaim.validationStatus, 'validating');
    assert.equal(readyClaim.validationStartedAt, '2026-08-22T06:00:00.000Z');
    assert.equal(database.completeVideoValidation(
      readyClaim.id,
      readyResult,
      '2026-08-22T06:01:00.000Z'
    ), 1);
    const ready = database.getVideo(readyClaim.id);
    assert.equal(ready.validationStatus, 'ready');
    assert.equal(ready.videoCodec, 'avc');
    assert.equal(ready.audioCodec, 'aac');
    assert.equal(ready.sha256, '1'.repeat(64));
    assert.deepEqual(ready.validationSummary, { decodedFrames: 375 });

    const warningClaim = database.claimNextVideoForValidation('2026-08-22T06:02:00.000Z');
    assert.equal(warningClaim.id, 'finish-warning');
    assert.equal(database.completeVideoValidation(warningClaim.id, {
      mediaType: 'video/webm',
      container: 'webm',
      videoCodec: 'vp9',
      audioCodec: 'opus',
      playbackStrategy: 'native',
      sha256: '2'.repeat(64),
      durationSeconds: 8,
      width: 1280,
      height: 720,
      frameRate: 24,
      warningCount: 2,
      summary: { warnings: ['recoverable-frame-error'] }
    }, '2026-08-22T06:03:00.000Z'), 1);
    const warning = database.getVideo(warningClaim.id);
    assert.equal(warning.validationStatus, 'ready_with_warnings');
    assert.equal(warning.validationWarningCount, 2);

    const rejectedClaim = database.claimNextVideoForValidation('2026-08-22T06:04:00.000Z');
    assert.equal(rejectedClaim.id, 'finish-rejected');
    assert.equal(database.rejectVideoValidation(
      rejectedClaim.id,
      { code: 'UNSUPPORTED_CODEC' },
      '2026-08-22T06:05:00.000Z'
    ), 1);
    assert.equal(database.getVideo(rejectedClaim.id).validationStatus, 'rejected');
    assert.equal(database.rejectVideoValidation(
      rejectedClaim.id,
      { code: 'SECOND_REJECTION' },
      '2026-08-22T06:06:00.000Z'
    ), 0);

    const failedClaim = database.claimNextVideoForValidation('2026-08-22T06:06:00.000Z');
    assert.equal(failedClaim.id, 'finish-failed');
    assert.equal(database.failVideoValidation(
      failedClaim.id,
      { code: 'VALIDATOR_TIMEOUT', retryable: true },
      '2026-08-22T06:07:00.000Z'
    ), 1);
    assert.equal(database.getVideo(failedClaim.id).validationStatus, 'validation_failed');
    assert.equal(database.retryFailedValidations(), 1);
    assert.equal(database.getVideo(failedClaim.id).validationStatus, 'pending');

    const retriedClaim = database.claimNextVideoForValidation('2026-08-22T06:08:00.000Z');
    assert.equal(retriedClaim.id, 'finish-failed');
    assert.equal(database.failVideoValidation(
      retriedClaim.id,
      { code: 'VALIDATOR_TIMEOUT', retryable: false },
      '2026-08-22T06:09:00.000Z'
    ), 1);

    const staleClaim = database.claimNextVideoForValidation('2026-08-22T06:10:00.000Z');
    assert.equal(staleClaim.id, 'finish-stale');
    assert.equal(database.resetStaleValidations('2026-08-22T06:11:00.000Z'), 1);
    assert.equal(database.getVideo(staleClaim.id).validationStatus, 'pending');
    assert.equal(database.getVideo(staleClaim.id).validationStartedAt, null);
    assert.equal(database.claimNextVideoForValidation('2026-08-22T06:12:00.000Z').id, 'finish-stale');

    assert.deepEqual(
      database.listVideos().map((entry) => entry.id),
      ['finish-warning', 'finish-ready']
    );
    assert.deepEqual(
      database.listVideoStorageNames().sort(),
      [
        'finish-failed.mp4',
        'finish-ready.mp4',
        'finish-rejected.mp4',
        'finish-stale.mp4',
        'finish-warning.webm'
      ]
    );
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
