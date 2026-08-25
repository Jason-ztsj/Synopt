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
    compatibility: 'guaranteed',
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
    accountAvatarStorageName: null,
    accountAvatarMediaType: null,
    categoryId: null,
    categorySlug: null,
    categoryName: null,
    coverStorageName: null,
    coverMediaType: null,
    coverSource: null,
    visibility: 'public',
    moderationStatus: 'visible',
    moderationVersion: 0,
    tags: [],
    upvoteCount: 0,
    downvoteCount: 0,
    valueHighCount: 0,
    valueMediumCount: 0,
    valueLowCount: 0,
    recommendationPercent: 0,
    discussionCount: 0,
    discussionTopics: 0,
    discussionReplies: 0,
    discussionDeepReplies: 0,
    viewerVote: 0,
    viewerValueTier: 0,
    archivePublic: false,
    withdrawnAt: null,
    deletedAt: null,
    createdAt
  };
}

function removeV5SchemaFromDowngradeFixture(database, { rebuildDiscussions = false } = {}) {
  database.exec(`
    DROP TRIGGER IF EXISTS case_notes_no_update;
    DROP TRIGGER IF EXISTS case_notes_no_delete;
    DROP TRIGGER IF EXISTS moderation_actions_no_update;
    DROP TRIGGER IF EXISTS moderation_actions_no_delete;
    DROP TRIGGER IF EXISTS audit_events_no_update;
    DROP TRIGGER IF EXISTS audit_events_no_delete;
    DROP TRIGGER IF EXISTS tags_no_self_merge_insert;
    DROP TRIGGER IF EXISTS tags_no_self_merge_update;
    DROP TABLE IF EXISTS cms_media_access_grants;
    DROP TABLE IF EXISTS appeals;
    DROP TABLE IF EXISTS moderation_actions;
    DROP TABLE IF EXISTS case_notes;
    DROP TABLE IF EXISTS moderation_cases;
    DROP TABLE IF EXISTS audit_events;
    DROP INDEX IF EXISTS idx_tags_active_name;
    ALTER TABLE sessions DROP COLUMN cms_verified_at;
    ALTER TABLE videos DROP COLUMN moderation_version;
    ALTER TABLE tags DROP COLUMN updated_at;
    ALTER TABLE tags DROP COLUMN merged_into_id;
    ALTER TABLE tags DROP COLUMN is_active;
    ALTER TABLE users DROP COLUMN governance_version;
  `);
  if (!rebuildDiscussions) {
    database.exec(`
      ALTER TABLE discussions DROP COLUMN moderation_version;
      ALTER TABLE discussions DROP COLUMN moderation_status;
    `);
  }
}

test('SQLite 持久化映射正确，视频倒序、讨论正序且查询索引实际存在', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synopt-db-test-'));
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

test('schema v0 无账号数据库迁移到最新版，并保留视频、讨论和外键行为', async () => {
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
    assert.equal(CURRENT_SCHEMA_VERSION, 7);
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

test('schema v1 带账号数据迁移到最新版，完整保留账号、会话、视频和讨论关联', async () => {
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
    assert.equal(database.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
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
      '2026-08-22T06:01:00.000Z',
      readyClaim.validationStartedAt
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
    }, '2026-08-22T06:03:00.000Z', warningClaim.validationStartedAt), 1);
    const warning = database.getVideo(warningClaim.id);
    assert.equal(warning.validationStatus, 'ready_with_warnings');
    assert.equal(warning.validationWarningCount, 2);

    const rejectedClaim = database.claimNextVideoForValidation('2026-08-22T06:04:00.000Z');
    assert.equal(rejectedClaim.id, 'finish-rejected');
    assert.equal(database.rejectVideoValidation(
      rejectedClaim.id,
      { code: 'UNSUPPORTED_CODEC' },
      '2026-08-22T06:05:00.000Z',
      rejectedClaim.validationStartedAt
    ), 1);
    assert.equal(database.getVideo(rejectedClaim.id).validationStatus, 'rejected');
    assert.equal(database.rejectVideoValidation(
      rejectedClaim.id,
      { code: 'SECOND_REJECTION' },
      '2026-08-22T06:06:00.000Z',
      rejectedClaim.validationStartedAt
    ), 0);

    const failedClaim = database.claimNextVideoForValidation('2026-08-22T06:06:00.000Z');
    assert.equal(failedClaim.id, 'finish-failed');
    assert.equal(database.failVideoValidation(
      failedClaim.id,
      { code: 'VALIDATOR_TIMEOUT', retryable: true },
      '2026-08-22T06:07:00.000Z',
      failedClaim.validationStartedAt
    ), 1);
    assert.equal(database.getVideo(failedClaim.id).validationStatus, 'validation_failed');
    assert.equal(database.retryFailedValidations(), 1);
    assert.equal(database.getVideo(failedClaim.id).validationStatus, 'pending');

    const retriedClaim = database.claimNextVideoForValidation('2026-08-22T06:08:00.000Z');
    assert.equal(retriedClaim.id, 'finish-failed');
    assert.equal(database.failVideoValidation(
      retriedClaim.id,
      { code: 'VALIDATOR_TIMEOUT', retryable: false },
      '2026-08-22T06:09:00.000Z',
      retriedClaim.validationStartedAt
    ), 1);

    const staleClaim = database.claimNextVideoForValidation('2026-08-22T06:10:00.000Z');
    assert.equal(staleClaim.id, 'finish-stale');
    assert.equal(database.resetStaleValidations('2026-08-22T06:11:00.000Z'), 1);
    assert.equal(database.getVideo(staleClaim.id).validationStatus, 'pending');
    assert.equal(database.getVideo(staleClaim.id).validationStartedAt, null);
    const reclaimed = database.claimNextVideoForValidation('2026-08-22T06:12:00.000Z');
    assert.equal(reclaimed.id, 'finish-stale');
    assert.equal(database.rejectVideoValidation(
      staleClaim.id,
      { code: 'STALE_WORKER_REJECTION' },
      '2026-08-22T06:12:01.000Z',
      staleClaim.validationStartedAt
    ), 0, '旧 worker 不能提交已被重领任务的拒绝结果');
    assert.equal(database.failVideoValidation(
      staleClaim.id,
      { code: 'STALE_WORKER_FAILURE' },
      '2026-08-22T06:12:02.000Z',
      staleClaim.validationStartedAt
    ), 0);
    assert.equal(database.completeVideoValidation(
      staleClaim.id,
      readyResult,
      '2026-08-22T06:12:03.000Z',
      staleClaim.validationStartedAt
    ), 0);
    assert.equal(database.setVideoCover(staleClaim.id, {
      storageName: 'stale-worker-cover.jpg', mediaType: 'image/jpeg', source: 'generated'
    }, staleClaim.validationStartedAt), 0);
    assert.equal(database.getVideo(staleClaim.id).validationStartedAt, reclaimed.validationStartedAt);
    assert.equal(database.renewVideoValidationLease(
      reclaimed.id,
      reclaimed.validationStartedAt,
      '2026-08-22T06:13:00.000Z'
    ), 1);
    assert.equal(database.renewVideoValidationLease(
      reclaimed.id,
      reclaimed.validationStartedAt,
      '2026-08-22T06:14:00.000Z'
    ), 0, '续租后旧租约版本立即失效');
    assert.equal(
      database.listFileDeletionTargets().some((task) => task.storageName === 'finish-stale.mp4'),
      false,
      '旧 worker 的拒绝结果不得排队删除新 worker 正在验证的文件'
    );

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

test('媒体拒绝状态、封面解绑与持久删除任务在同一事务提交或回滚', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-rejection-queue-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'rejection.sqlite'));
    database.insertVideo({
      ...video('atomic-rejected', '2026-08-22T08:00:00.000Z'),
      validationStatus: 'pending',
      coverStorageName: 'atomic-rejected-cover.webp',
      coverMediaType: 'image/webp',
      coverSource: 'uploaded'
    });
    const rejectionClaim = database.claimNextVideoForValidation('2026-08-22T08:01:00.000Z');
    assert.equal(rejectionClaim.id, 'atomic-rejected');
    database.raw.exec(`
      CREATE TRIGGER abort_rejection_file_queue
      BEFORE INSERT ON file_deletion_queue
      BEGIN
        SELECT RAISE(ABORT, 'queue unavailable');
      END;
    `);
    assert.throws(() => database.rejectVideoValidation(
      'atomic-rejected',
      { code: 'INVALID_STRUCTURE' },
      '2026-08-22T08:02:00.000Z',
      rejectionClaim.validationStartedAt
    ), /queue unavailable/);
    let stored = database.getVideo('atomic-rejected');
    assert.equal(stored.validationStatus, 'validating');
    assert.equal(stored.coverStorageName, 'atomic-rejected-cover.webp');
    assert.deepEqual(database.listFileDeletionTargets(), []);

    database.raw.exec('DROP TRIGGER abort_rejection_file_queue');
    assert.equal(database.rejectVideoValidation(
      'atomic-rejected',
      { code: 'INVALID_STRUCTURE' },
      '2026-08-22T08:03:00.000Z',
      rejectionClaim.validationStartedAt
    ), 1);
    stored = database.getVideo('atomic-rejected');
    assert.equal(stored.validationStatus, 'rejected');
    assert.equal(stored.coverStorageName, null);
    assert.deepEqual(database.listFileDeletionTargets(), [
      { kind: 'video', storageName: 'atomic-rejected.mp4' },
      { kind: 'cover', storageName: 'atomic-rejected-cover.webp' }
    ]);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('分类、标签、树状讨论、搜索与双向投票保持可查询和唯一', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-catalog-db-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'catalog.sqlite'));
    const user = database.createUser({
      id: 'catalog-user', username: 'catalog_user', displayName: '目录用户',
      passwordHash: 'scrypt-test-value', createdAt: '2026-08-23T01:00:00.000Z'
    });
    database.insertVideo({
      ...video('catalog-video', '2026-08-23T02:00:00.000Z'),
      userId: user.id,
      categorySlug: 'science-technology',
      tags: [{ slug: 'open-source', name: '开源' }, { slug: 'long-video', name: '长视频' }]
    });
    const stored = database.getVideo('catalog-video');
    assert.equal(stored.categoryName, '科学与技术');
    assert.deepEqual(stored.tags.map((tag) => tag.name), ['开源', '长视频']);
    assert.deepEqual(database.listVideos({ query: '开源' }).map((entry) => entry.id), ['catalog-video']);
    assert.deepEqual(database.listVideos({ categorySlug: 'knowledge' }).map((entry) => entry.id), ['catalog-video']);
    assert.deepEqual(database.listVideos({ tagSlug: 'long-video' }).map((entry) => entry.id), ['catalog-video']);

    const topic = database.insertDiscussion({
      videoId: stored.id, userId: user.id, nickname: user.displayName,
      title: '这是一个主题', bodyMarkdown: '主题正文', createdAt: '2026-08-23T03:00:00.000Z'
    });
    const reply = database.insertDiscussion({
      videoId: stored.id, userId: user.id, nickname: user.displayName,
      parentId: topic.id, bodyMarkdown: '回复正文', createdAt: '2026-08-23T03:01:00.000Z'
    });
    assert.equal(database.getDiscussion(reply.id).parentId, topic.id);

    assert.equal(database.setVideoVote(stored.id, user.id, 1, '2026-08-23T04:00:00.000Z').upvoteCount, 1);
    assert.equal(database.setVideoVote(stored.id, user.id, 3, '2026-08-23T04:01:00.000Z').downvoteCount, 1);
    assert.equal(database.setVideoVote(stored.id, user.id, 0, '2026-08-23T04:02:00.000Z').downvoteCount, 0);
    assert.equal(database.setDiscussionVote(topic.id, user.id, 1, '2026-08-23T04:03:00.000Z').viewerVote, 1);
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('公开个人页的讨论和获票统计不泄露私有、撤回、隐藏或未验证稿件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-public-profile-count-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'profile-count.sqlite'));
    const owner = database.createUser({
      id: 'profile-count-owner', username: 'profile_count_owner', displayName: '公开作者',
      passwordHash: 'hash', createdAt: '2026-08-23T07:00:00.000Z'
    });
    const voter = database.createUser({
      id: 'profile-count-voter', username: 'profile_count_voter', displayName: '统计投票者',
      passwordHash: 'hash', createdAt: '2026-08-23T07:01:00.000Z'
    });
    const cases = [
      ['profile-public', {}],
      ['profile-private', { visibility: 'private' }],
      ['profile-withdrawn', {}],
      ['profile-hidden', { moderationStatus: 'hidden' }],
      ['profile-pending', { validationStatus: 'pending' }]
    ];
    for (const [id, overrides] of cases) {
      database.insertVideo({
        ...video(id, `2026-08-23T07:0${cases.findIndex(([candidate]) => candidate === id) + 2}:00.000Z`),
        userId: owner.id,
        ...overrides
      });
      database.insertDiscussion({
        videoId: id,
        userId: owner.id,
        nickname: owner.displayName,
        title: `讨论 ${id}`,
        bodyMarkdown: `正文 ${id}`,
        createdAt: '2026-08-23T07:10:00.000Z'
      });
    }
    database.withdrawVideo('profile-withdrawn', owner.id, '2026-08-23T07:11:00.000Z');
    database.setVideoVote('profile-public', voter.id, 1, '2026-08-23T07:12:00.000Z');
    database.setVideoVote('profile-private', voter.id, 3, '2026-08-23T07:13:00.000Z');
    database.setVideoVote('profile-withdrawn', voter.id, 1, '2026-08-23T07:14:00.000Z');
    database.setVideoVote('profile-hidden', voter.id, 3, '2026-08-23T07:15:00.000Z');
    database.setVideoVote('profile-pending', voter.id, 1, '2026-08-23T07:16:00.000Z');

    const profile = database.getPublicUserProfile(owner.username);
    assert.equal(profile.videoCount, 1);
    assert.equal(profile.discussionCount, 1);
    assert.equal(profile.receivedUpvoteCount, 1);
    assert.equal(profile.receivedDownvoteCount, 0);
    const publicDiscussion = database.raw.prepare(
      "SELECT id FROM discussions WHERE video_id = 'profile-public'"
    ).get();
    database.raw.prepare("UPDATE discussions SET moderation_status = 'hidden' WHERE id = ?")
      .run(publicDiscussion.id);
    assert.equal(database.getPublicUserProfile(owner.username).discussionCount, 0);
    database.raw.prepare("UPDATE discussions SET moderation_status = 'visible' WHERE id = ?")
      .run(publicDiscussion.id);
    assert.equal(database.getPublicUserProfile(owner.username).discussionCount, 1);
    database.raw.prepare("UPDATE discussions SET moderation_status = 'removed' WHERE id = ?")
      .run(publicDiscussion.id);
    assert.equal(database.getPublicUserProfile(owner.username).discussionCount, 0);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('账号资料、头像、稿件分页、撤回重发和永久删除保持一致', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-account-content-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'account.sqlite'));
    const owner = database.createUser({
      id: 'content-owner', username: 'content_owner', displayName: '原显示名',
      passwordHash: 'old-password-hash', createdAt: '2026-08-23T08:00:00.000Z'
    });
    const updated = database.updateUserProfile(owner.id, {
      displayName: '新显示名', bio: '开放知识贡献者', updatedAt: '2026-08-23T08:01:00.000Z'
    });
    assert.equal(updated.displayName, '新显示名');
    assert.equal(updated.bio, '开放知识贡献者');

    const avatar = database.updateUserAvatar(owner.id, {
      storageName: 'avatar-content-owner.webp', mediaType: 'image/webp',
      updatedAt: '2026-08-23T08:02:00.000Z'
    });
    assert.equal(avatar.previousAvatarStorageName, null);
    assert.equal(avatar.user.avatarMediaType, 'image/webp');
    const replacedAvatar = database.updateUserAvatar(owner.id, {
      storageName: 'avatar-content-owner-2.png', mediaType: 'image/png',
      updatedAt: '2026-08-23T08:03:00.000Z'
    });
    assert.equal(replacedAvatar.previousAvatarStorageName, 'avatar-content-owner.webp');
    assert.deepEqual(database.listAvatarStorageNames(), ['avatar-content-owner-2.png']);
    assert.equal(database.updateUserPassword(owner.id, 'new-password-hash', '2026-08-23T08:04:00.000Z'), 1);

    database.createSession({
      tokenHash: 'a'.repeat(64), userId: owner.id, csrfTokenHash: 'b'.repeat(64),
      createdAt: '2026-08-23T08:05:00.000Z', expiresAt: '2026-09-23T08:05:00.000Z'
    });
    database.createSession({
      tokenHash: 'c'.repeat(64), userId: owner.id, csrfTokenHash: 'd'.repeat(64),
      createdAt: '2026-08-23T08:06:00.000Z', expiresAt: '2026-09-23T08:06:00.000Z'
    });
    assert.equal(database.findSessionByTokenHash('a'.repeat(64)).user.avatarStorageName, 'avatar-content-owner-2.png');
    assert.equal(database.revokeOtherSessions(owner.id, 'a'.repeat(64)), 1);

    database.insertVideo({
      ...video('managed-a', '2026-08-23T09:00:00.000Z'), userId: owner.id,
      categorySlug: 'science-technology', tags: [{ slug: 'managed', name: '管理' }],
      coverStorageName: 'managed-a-cover.webp', coverMediaType: 'image/webp', coverSource: 'uploaded'
    });
    database.insertVideo({ ...video('managed-b', '2026-08-23T10:00:00.000Z'), userId: owner.id });
    assert.deepEqual(database.listUserVideos(owner.id, { limit: 1 }).items.map((item) => item.id), ['managed-b']);
    assert.equal(database.listUserVideos(owner.id, { limit: 1 }).total, 2);
    assert.equal(database.getPublicUserProfile(owner.username).videoCount, 2);
    assert.equal(database.listPublicUserVideos(owner.id).total, 2);

    const withdrawn = database.withdrawVideo('managed-a', owner.id, '2026-08-23T11:00:00.000Z');
    assert.equal(withdrawn.visibility, 'private');
    assert.equal(withdrawn.archivePublic, true);
    assert.equal(withdrawn.withdrawnAt, '2026-08-23T11:00:00.000Z');
    assert.equal(database.listVideos().some((item) => item.id === 'managed-a'), false);
    assert.equal(database.republishVideo('managed-a', owner.id).visibility, 'public');
    assert.equal(database.getVideo('managed-a').withdrawnAt, null);

    const discussion = database.insertDiscussion({
      videoId: 'managed-a', userId: owner.id, nickname: owner.displayName,
      title: '永久删除后保留', bodyMarkdown: '档案讨论', createdAt: '2026-08-23T11:10:00.000Z'
    });
    assert.equal(database.markVideoPermanentlyDeleted(
      'managed-a', owner.id, '2026-08-23T11:11:00.000Z'
    ), null, '未撤回稿件不能永久删除');
    database.withdrawVideo('managed-a', owner.id, '2026-08-23T11:12:00.000Z');
    const asset = database.markVideoPermanentlyDeleted(
      'managed-a', owner.id, '2026-08-23T11:13:00.000Z'
    );
    assert.deepEqual(asset, {
      videoId: 'managed-a', title: '标题 managed-a', storageName: 'managed-a.mp4',
      coverStorageName: 'managed-a-cover.webp', validationStatus: 'ready'
    });
    const deleted = database.getVideo('managed-a');
    assert.equal(deleted.deletedAt, '2026-08-23T11:13:00.000Z');
    assert.equal(deleted.archivePublic, true, '永久删除后保留撤回前的公开档案状态');
    assert.equal(deleted.title, '作品已删除');
    assert.equal(deleted.userId, null);
    assert.deepEqual(deleted.tags, []);
    assert.equal(database.getDiscussion(discussion.id).bodyMarkdown, '档案讨论');
    assert.equal(database.listVideoStorageNames().includes('managed-a.mp4'), false);
    assert.equal(database.listVideosMissingCover().some((item) => item.id === 'managed-a'), false);

    database.insertVideo({
      ...video('managed-private', '2026-08-23T11:14:00.000Z'),
      userId: owner.id,
      visibility: 'private'
    });
    assert.equal(database.withdrawVideo(
      'managed-private', owner.id, '2026-08-23T11:15:00.000Z'
    ).archivePublic, false);
    assert.equal(database.markVideoPermanentlyDeleted(
      'managed-private', owner.id, '2026-08-23T11:16:00.000Z'
    ).videoId, 'managed-private');
    assert.equal(database.getVideo('managed-private').archivePublic, false);

    database.insertVideo({
      ...video('managed-hidden', '2026-08-23T11:17:00.000Z'),
      userId: owner.id,
      moderationStatus: 'hidden'
    });
    assert.equal(database.withdrawVideo(
      'managed-hidden', owner.id, '2026-08-23T11:18:00.000Z'
    ).archivePublic, false);
    assert.equal(database.markVideoPermanentlyDeleted(
      'managed-hidden', owner.id, '2026-08-23T11:19:00.000Z'
    ), null, '审核隐藏中的视频必须保留为治理证据');
    assert.equal(database.getVideo('managed-hidden').deletedAt, null);
    assert.equal(database.getVideo('managed-hidden').archivePublic, false);

    database.insertVideo({
      ...video('managed-hidden-after-withdraw', '2026-08-23T11:20:00.000Z'),
      userId: owner.id
    });
    assert.equal(database.withdrawVideo(
      'managed-hidden-after-withdraw', owner.id, '2026-08-23T11:21:00.000Z'
    ).archivePublic, true);
    database.raw.prepare(`
      UPDATE videos SET moderation_status = 'hidden'
      WHERE id = 'managed-hidden-after-withdraw'
    `).run();
    assert.equal(database.markVideoPermanentlyDeleted(
      'managed-hidden-after-withdraw', owner.id, '2026-08-23T11:22:00.000Z'
    ), null, '撤回后被审核隐藏的内容仍须保留为治理证据');
    assert.equal(
      database.getVideo('managed-hidden-after-withdraw').archivePublic,
      true,
      '拒绝永久删除时不得改写撤回前的归档事实'
    );
    assert.equal(database.getVideo('managed-hidden-after-withdraw').deletedAt, null);

    database.insertVideo({
      ...video('managed-rejected-after-withdraw', '2026-08-23T11:23:00.000Z'),
      userId: owner.id
    });
    assert.equal(database.withdrawVideo(
      'managed-rejected-after-withdraw', owner.id, '2026-08-23T11:24:00.000Z'
    ).archivePublic, true);
    database.raw.prepare(`
      UPDATE videos SET validation_status = 'rejected'
      WHERE id = 'managed-rejected-after-withdraw'
    `).run();
    database.markVideoPermanentlyDeleted(
      'managed-rejected-after-withdraw', owner.id, '2026-08-23T11:25:00.000Z'
    );
    assert.equal(
      database.getVideo('managed-rejected-after-withdraw').archivePublic,
      false,
      '撤回后验证状态变为 rejected 时不得保留公开档案'
    );

    database.insertVideo({
      ...video('managed-pending', '2026-08-23T11:26:00.000Z'),
      userId: owner.id,
      validationStatus: 'pending'
    });
    assert.equal(database.withdrawVideo(
      'managed-pending', owner.id, '2026-08-23T11:27:00.000Z'
    ).archivePublic, false, 'pending 稿件即使 visibility 为 public 也不能公开归档');
    database.markVideoPermanentlyDeleted(
      'managed-pending', owner.id, '2026-08-23T11:28:00.000Z'
    );
    assert.equal(database.getVideo('managed-pending').archivePublic, false);

    const pendingAccount = database.createUser({
      id: 'pending-account-owner', username: 'pending_account_owner', displayName: '待验证作者',
      passwordHash: 'hash', createdAt: '2026-08-23T11:29:00.000Z'
    });
    database.insertVideo({
      ...video('pending-account-video', '2026-08-23T11:30:00.000Z'),
      userId: pendingAccount.id,
      validationStatus: 'pending'
    });
    database.deleteAccount(pendingAccount.id, {
      deleteVideos: true,
      deleteDiscussions: false,
      deletedAt: '2026-08-23T11:31:00.000Z'
    });
    assert.equal(
      database.getVideo('pending-account-video').archivePublic,
      false,
      '注销账号直接删除 pending 稿件也不能产生公开档案'
    );
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('文件删除队列幂等记录失败并与失去引用的资源保持同一事务', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-file-deletion-queue-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'queue.sqlite'));
    const enqueued = database.enqueueFileDeletion({
      kind: 'cover',
      storageName: 'orphan-cover.webp',
      createdAt: '2026-08-23T11:20:00.000Z'
    });
    assert.deepEqual(enqueued, {
      id: enqueued.id,
      kind: 'cover',
      storageName: 'orphan-cover.webp',
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: '2026-08-23T11:20:00.000Z',
      createdAt: '2026-08-23T11:20:00.000Z',
      updatedAt: '2026-08-23T11:20:00.000Z'
    });
    const duplicate = database.enqueueFileDeletion({
      kind: 'cover',
      storageName: 'orphan-cover.webp',
      createdAt: '2026-08-23T11:21:00.000Z'
    });
    assert.deepEqual(duplicate, enqueued, '重复入队不新增任务，也不重置任务状态');
    assert.equal(database.listPendingFileDeletions().length, 1);
    assert.throws(() => database.enqueueFileDeletion({
      kind: 'other', storageName: 'orphan.bin', createdAt: '2026-08-23T11:22:00.000Z'
    }), /video、cover 或 avatar/);
    assert.throws(() => database.enqueueFileDeletion({
      kind: 'video', storageName: '../escape.mp4', createdAt: '2026-08-23T11:22:00.000Z'
    }), /安全的存储文件名/);

    const failed = database.failFileDeletion(
      enqueued.id,
      new Error('x'.repeat(2500)),
      '2026-08-23T11:23:00.000Z'
    );
    assert.equal(failed.attemptCount, 1);
    assert.equal(failed.lastError.length, 2000);
    assert.equal(failed.nextAttemptAt, '2026-08-23T11:23:05.000Z');
    assert.equal(failed.updatedAt, '2026-08-23T11:23:00.000Z');
    assert.equal(database.failFileDeletion(999_999, 'missing', '2026-08-23T11:24:00.000Z'), null);
    assert.equal(database.enqueueFileDeletion({
      kind: 'cover',
      storageName: 'orphan-cover.webp',
      createdAt: '2026-08-23T11:25:00.000Z'
    }).attemptCount, 1, '重复入队不得清除失败次数');
    assert.equal(database.completeFileDeletion(enqueued.id), 1);
    assert.equal(database.completeFileDeletion(enqueued.id), 0);

    for (let index = 0; index < 50; index += 1) {
      const retryTask = database.enqueueFileDeletion({
        kind: 'video',
        storageName: `backoff-${String(index).padStart(2, '0')}.mp4`,
        createdAt: '2026-08-23T10:00:00.000Z'
      });
      database.failFileDeletion(
        retryTask.id,
        '等待退避重试',
        '2026-08-23T10:01:00.000Z'
      );
    }
    database.enqueueFileDeletion({
      kind: 'video',
      storageName: 'brand-new.mp4',
      createdAt: '2026-08-23T11:29:00.000Z'
    });
    const firstPage = database.listPendingFileDeletions({ limit: 50 });
    assert.equal(firstPage.length, 50);
    assert.equal(firstPage[0].storageName, 'brand-new.mp4');
    assert.equal(firstPage[0].attemptCount, 0);
    assert.equal(
      firstPage.filter((item) => item.attemptCount > 0).length,
      49,
      '50 个退避失败任务不能把后入队的新任务堵在分页之外'
    );
    for (const task of database.listPendingFileDeletions({ limit: 100 })) {
      database.completeFileDeletion(task.id);
    }

    const highAttemptTask = database.enqueueFileDeletion({
      kind: 'video',
      storageName: 'high-attempt.mp4',
      createdAt: '2026-08-23T12:00:00.000Z'
    });
    let highAttemptState;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      highAttemptState = database.failFileDeletion(
        highAttemptTask.id,
        '持续失败',
        '2026-08-23T12:00:00.000Z'
      );
    }
    assert.equal(highAttemptState.attemptCount, 14);
    assert.equal(highAttemptState.nextAttemptAt, '2026-08-23T18:00:00.000Z', '退避上限为 6 小时');
    const lowAttemptTask = database.enqueueFileDeletion({
      kind: 'cover',
      storageName: 'eligible-new-cover.webp',
      createdAt: '2026-08-23T12:01:00.000Z'
    });
    assert.deepEqual(
      database.listPendingFileDeletions({
        limit: 1,
        eligibleAt: '2026-08-23T12:02:00.000Z'
      }).map((item) => item.id),
      [lowAttemptTask.id],
      '高 attempt 且尚未到期的任务不会挡住后面已到期任务'
    );
    assert.throws(() => database.listPendingFileDeletions({ eligibleAt: 'not-a-date' }), /有效时间/);
    database.completeFileDeletion(highAttemptTask.id);
    database.completeFileDeletion(lowAttemptTask.id);

    const owner = database.createUser({
      id: 'queue-owner', username: 'queue_owner', displayName: '队列作者',
      passwordHash: 'hash', createdAt: '2026-08-23T11:30:00.000Z'
    });
    database.updateUserAvatar(owner.id, {
      storageName: 'queue-avatar-a.webp', mediaType: 'image/webp',
      updatedAt: '2026-08-23T11:31:00.000Z'
    });
    database.updateUserAvatar(owner.id, {
      storageName: 'queue-avatar-b.webp', mediaType: 'image/webp',
      updatedAt: '2026-08-23T11:32:00.000Z'
    });
    assert.ok(database.listPendingFileDeletions().some(
      (item) => item.kind === 'avatar' && item.storageName === 'queue-avatar-a.webp'
    ));
    database.insertVideo({
      ...video('queue-video', '2026-08-23T11:33:00.000Z'),
      userId: owner.id,
      coverStorageName: 'queue-cover.webp',
      coverMediaType: 'image/webp',
      coverSource: 'uploaded'
    });
    database.withdrawVideo('queue-video', owner.id, '2026-08-23T11:34:00.000Z');
    database.raw.exec(`
      CREATE TRIGGER abort_file_deletion_queue
      BEFORE INSERT ON file_deletion_queue
      BEGIN
        SELECT RAISE(ABORT, 'queue blocked');
      END;
    `);
    assert.throws(() => database.markVideoPermanentlyDeleted(
      'queue-video', owner.id, '2026-08-23T11:35:00.000Z'
    ), /queue blocked/);
    const rolledBackVideo = database.getVideo('queue-video');
    assert.equal(rolledBackVideo.deletedAt, null);
    assert.equal(rolledBackVideo.storageName, 'queue-video.mp4');
    assert.equal(database.listPendingFileDeletions().some(
      (item) => item.storageName === 'queue-video.mp4'
    ), false);
    database.raw.exec('DROP TRIGGER abort_file_deletion_queue');
    database.markVideoPermanentlyDeleted(
      'queue-video', owner.id, '2026-08-23T11:36:00.000Z'
    );
    assert.deepEqual(
      database.listPendingFileDeletions()
        .filter((item) => item.kind !== 'avatar')
        .map((item) => [item.kind, item.storageName]),
      [['video', 'queue-video.mp4'], ['cover', 'queue-cover.webp']]
    );

    const account = database.createUser({
      id: 'queue-account', username: 'queue_account', displayName: '待注销队列账号',
      passwordHash: 'hash', createdAt: '2026-08-23T11:40:00.000Z'
    });
    database.updateUserAvatar(account.id, {
      storageName: 'queue-account-avatar.webp', mediaType: 'image/webp',
      updatedAt: '2026-08-23T11:41:00.000Z'
    });
    database.raw.exec(`
      CREATE TRIGGER abort_account_file_deletion_queue
      BEFORE INSERT ON file_deletion_queue
      BEGIN
        SELECT RAISE(ABORT, 'account queue blocked');
      END;
    `);
    assert.throws(() => database.deleteAccount(account.id, {
      deleteVideos: false,
      deleteDiscussions: false,
      deletedAt: '2026-08-23T11:42:00.000Z'
    }), /account queue blocked/);
    assert.equal(database.getUserById(account.id).status, 'active');
    assert.equal(database.getUserById(account.id).avatarStorageName, 'queue-account-avatar.webp');
    database.raw.exec('DROP TRIGGER abort_account_file_deletion_queue');
    database.deleteAccount(account.id, {
      deleteVideos: false,
      deleteDiscussions: false,
      deletedAt: '2026-08-23T11:43:00.000Z'
    });
    assert.ok(database.listPendingFileDeletions().some(
      (item) => item.kind === 'avatar' && item.storageName === 'queue-account-avatar.webp'
    ));
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('讨论编辑只记录实际变化，有回复时墓碑、无回复时删除并清理空墓碑', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-discussion-manage-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'discussion.sqlite'));
    const author = database.createUser({
      id: 'discussion-author', username: 'discussion_author', displayName: '发起者',
      passwordHash: 'hash', createdAt: '2026-08-23T12:00:00.000Z'
    });
    const replier = database.createUser({
      id: 'discussion-replier', username: 'discussion_replier', displayName: '回复者',
      passwordHash: 'hash', createdAt: '2026-08-23T12:01:00.000Z'
    });
    database.insertVideo({ ...video('discussion-video', '2026-08-23T12:02:00.000Z'), userId: author.id });
    const topic = database.insertDiscussion({
      videoId: 'discussion-video', userId: author.id, nickname: author.displayName,
      title: '原始标题', bodyMarkdown: '原始正文', createdAt: '2026-08-23T12:03:00.000Z'
    });
    const unchanged = database.editDiscussion(topic.id, author.id, {
      title: '原始标题', bodyMarkdown: '原始正文', editedAt: '2026-08-23T12:04:00.000Z'
    });
    assert.equal(unchanged.editCount, 0);
    assert.equal(unchanged.editedAt, null);
    const edited = database.editDiscussion(topic.id, author.id, {
      title: '修改标题', bodyMarkdown: '修改正文', editedAt: '2026-08-23T12:05:00.000Z'
    });
    assert.equal(edited.editCount, 1);
    assert.equal(edited.editedAt, '2026-08-23T12:05:00.000Z');
    assert.equal(database.editDiscussion(topic.id, replier.id, {
      title: '越权', bodyMarkdown: '越权', editedAt: '2026-08-23T12:06:00.000Z'
    }), null);

    const reply = database.insertDiscussion({
      videoId: 'discussion-video', userId: replier.id, nickname: replier.displayName,
      parentId: topic.id, title: '回复标题', bodyMarkdown: '回复正文',
      createdAt: '2026-08-23T12:07:00.000Z'
    });
    const hardDeleteNotification = database.listNotifications(author.id).items[0];
    assert.equal(hardDeleteNotification.type, 'reply');
    assert.equal(hardDeleteNotification.discussionId, reply.id);
    assert.equal(database.getUnreadNotificationCount(author.id), 1);
    database.setDiscussionVote(topic.id, replier.id, 1, '2026-08-23T12:08:00.000Z');
    assert.deepEqual(database.deleteDiscussion(topic.id, author.id, '2026-08-23T12:09:00.000Z'), {
      id: topic.id, mode: 'tombstoned'
    });
    const tombstone = database.getDiscussion(topic.id);
    assert.equal(tombstone.deletedAt, '2026-08-23T12:09:00.000Z');
    assert.equal(tombstone.bodyMarkdown, '');
    assert.equal(tombstone.userId, null);
    assert.equal(tombstone.upvoteCount, 0);
    assert.equal(database.editDiscussion(topic.id, author.id, {
      title: '不能复活', bodyMarkdown: '不能复活', editedAt: '2026-08-23T12:10:00.000Z'
    }), null);
    assert.deepEqual(database.deleteDiscussion(reply.id, replier.id, '2026-08-23T12:11:00.000Z'), {
      id: reply.id, mode: 'deleted'
    });
    assert.equal(database.getDiscussion(reply.id), null);
    assert.equal(database.getDiscussion(topic.id), null, '最后一个回复删除后清理空墓碑');
    assert.equal(database.getUnreadNotificationCount(author.id), 0);
    assert.equal(
      database.listNotifications(author.id).items.some((item) => item.id === hardDeleteNotification.id),
      false,
      '无回复讨论硬删除时也删除对应回复通知'
    );

    const nestedTopic = database.insertDiscussion({
      videoId: 'discussion-video', userId: author.id, nickname: author.displayName,
      title: '嵌套主题', bodyMarkdown: '嵌套主题正文', createdAt: '2026-08-23T12:12:00.000Z'
    });
    const nestedReply = database.insertDiscussion({
      videoId: 'discussion-video', userId: replier.id, nickname: replier.displayName,
      parentId: nestedTopic.id, bodyMarkdown: '将被墓碑化的回复',
      createdAt: '2026-08-23T12:13:00.000Z'
    });
    const nestedReplyNotification = database.listNotifications(author.id).items[0];
    assert.equal(nestedReplyNotification.discussionId, nestedReply.id);
    database.insertDiscussion({
      videoId: 'discussion-video', userId: author.id, nickname: author.displayName,
      parentId: nestedReply.id, bodyMarkdown: '让父回复保留为墓碑',
      createdAt: '2026-08-23T12:14:00.000Z'
    });
    assert.equal(database.getUnreadNotificationCount(author.id), 1);
    assert.equal(database.getUnreadNotificationCount(replier.id), 1);
    assert.deepEqual(database.deleteDiscussion(
      nestedReply.id, replier.id, '2026-08-23T12:15:00.000Z'
    ), { id: nestedReply.id, mode: 'tombstoned' });
    assert.equal(database.getDiscussion(nestedReply.id).deletedAt, '2026-08-23T12:15:00.000Z');
    assert.equal(database.getUnreadNotificationCount(author.id), 0);
    assert.equal(
      database.listNotifications(author.id).items.some(
        (item) => item.id === nestedReplyNotification.id
      ),
      false,
      '有子回复的讨论墓碑化时删除对应回复通知'
    );
    assert.equal(
      database.getUnreadNotificationCount(replier.id),
      1,
      '指向仍存在子回复的另一条通知不应被误删'
    );

    const foreignKey = database.raw.prepare("PRAGMA foreign_key_list('discussions')").all()
      .find((entry) => entry.from === 'parent_id');
    assert.ok(['RESTRICT', 'NO ACTION'].includes(foreignKey.on_delete));
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('通知偏好、回复通知、投票聚合、系统链接和已读状态正确', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-notification-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'notification.sqlite'));
    const owner = database.createUser({
      id: 'notify-owner', username: 'notify_owner', displayName: '稿件作者',
      passwordHash: 'hash', createdAt: '2026-08-23T13:00:00.000Z'
    });
    const voterA = database.createUser({
      id: 'notify-voter-a', username: 'notify_voter_a', displayName: '投票甲',
      passwordHash: 'hash', createdAt: '2026-08-23T13:01:00.000Z'
    });
    const voterB = database.createUser({
      id: 'notify-voter-b', username: 'notify_voter_b', displayName: '投票乙',
      passwordHash: 'hash', createdAt: '2026-08-23T13:02:00.000Z'
    });
    assert.deepEqual(database.getNotificationPreferences(owner.id), {
      userId: owner.id, reply: true, videoVote: true, system: true,
      updatedAt: '2026-08-23T13:00:00.000Z'
    });
    database.insertVideo({ ...video('notify-video', '2026-08-23T13:03:00.000Z'), userId: owner.id });
    database.setVideoVote('notify-video', voterA.id, 1, '2026-08-23T13:04:00.000Z');
    database.setVideoVote('notify-video', voterA.id, 1, '2026-08-23T13:05:00.000Z');
    database.setVideoVote('notify-video', voterB.id, 1, '2026-08-23T13:06:00.000Z');
    let notification = database.listNotifications(owner.id).items[0];
    assert.equal(notification.type, 'video_upvote');
    assert.equal(notification.count, 2, '重复投票不提醒，不同用户同方向聚合');
    assert.equal(database.getUnreadNotificationCount(owner.id), 2);
    assert.equal(database.pollNotifications(owner.id).items.length, 1);

    database.setVideoVote('notify-video', voterA.id, 0, '2026-08-23T13:06:10.000Z');
    notification = database.listNotifications(owner.id, { unreadOnly: true }).items[0];
    assert.equal(notification.type, 'video_upvote');
    assert.equal(notification.count, 1, '取消投票会从当前未读聚合移除该账号');
    database.setVideoVote('notify-video', voterA.id, 1, '2026-08-23T13:06:20.000Z');
    assert.equal(database.getUnreadNotificationCount(owner.id), 2, '取消后重新投票不会刷高净人数');

    database.setVideoVote('notify-video', voterA.id, 3, '2026-08-23T13:06:30.000Z');
    let unreadVotes = database.listNotifications(owner.id, { unreadOnly: true }).items;
    // 三档价值下"低价值"(3)不向作者发送通知；切向低价值会取消该账号的高价值认可
    assert.equal(unreadVotes.length, 1, '切向低价值不应新增方向通知');
    assert.equal(unreadVotes[0].type, 'video_upvote');
    assert.equal(unreadVotes[0].count, 1, '切向低价值会取消该账号的高价值认可');
    database.setVideoVote('notify-video', voterA.id, 1, '2026-08-23T13:06:50.000Z');
    unreadVotes = database.listNotifications(owner.id, { unreadOnly: true }).items;
    assert.equal(unreadVotes.length, 1);
    assert.equal(unreadVotes[0].type, 'video_upvote');
    assert.equal(unreadVotes[0].count, 2);
    database.setVideoVote('notify-video', voterA.id, 0, '2026-08-23T13:06:55.000Z');
    database.setVideoVote('notify-video', voterA.id, 1, '2026-08-23T13:06:58.000Z');
    assert.equal(database.getUnreadNotificationCount(owner.id), 2);
    assert.equal(database.raw.prepare(`
      SELECT count(*) AS count FROM notification_vote_actors
      WHERE notification_id = ?
    `).get(database.listNotifications(owner.id, { unreadOnly: true }).items[0].id).count, 2);

    notification = database.listNotifications(owner.id, { unreadOnly: true }).items[0];
    assert.equal(database.markNotificationRead(
      notification.id, owner.id, '2026-08-23T13:07:00.000Z'
    ).isRead, true);

    database.setVideoVote('notify-video', voterA.id, 3, '2026-08-23T13:08:00.000Z');
    // 低价值不生成独立通知
    assert.equal(database.listNotifications(owner.id).items.some((item) => item.type === 'video_downvote'), false);
    const system = database.createSystemNotification({
      recipientUserId: owner.id, title: '稿件需要修改', body: '请检查封面',
      link: '/account/videos?status=returned', createdAt: '2026-08-23T13:09:00.000Z'
    });
    assert.equal(system.systemLink, '/account/videos?status=returned');
    assert.equal(database.markAllNotificationsRead(owner.id, '2026-08-23T13:10:00.000Z'), 1);
    assert.equal(database.getUnreadNotificationCount(owner.id), 0);

    database.updateNotificationPreferences(owner.id, {
      reply: true, videoVote: false, system: false
    }, '2026-08-23T13:11:00.000Z');
    database.setVideoVote('notify-video', voterB.id, 3, '2026-08-23T13:12:00.000Z');
    assert.equal(database.createSystemNotification({
      recipientUserId: owner.id, title: '不会生成', createdAt: '2026-08-23T13:13:00.000Z'
    }), null);
    assert.equal(database.getUnreadNotificationCount(owner.id), 0);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('注销账号可选择保留或清除内容，并撤销会话、投票、通知及个人资料', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-delete-account-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'delete-account.sqlite'));
    const retained = database.createUser({
      id: 'retained-user', username: 'retained_username', displayName: '保留作者',
      passwordHash: 'hash', createdAt: '2026-08-23T13:50:00.000Z'
    });
    database.insertVideo({
      ...video('retained-account-video', '2026-08-23T13:51:00.000Z'), userId: retained.id
    });
    const retainedDiscussion = database.insertDiscussion({
      videoId: 'retained-account-video', userId: retained.id, nickname: retained.displayName,
      title: '保留讨论', bodyMarkdown: '保留正文', createdAt: '2026-08-23T13:52:00.000Z'
    });
    database.deleteAccount(retained.id, {
      deleteVideos: false, deleteDiscussions: false, deletedAt: '2026-08-23T13:53:00.000Z'
    });
    assert.equal(database.getVideo('retained-account-video').deletedAt, null);
    assert.equal(database.getVideo('retained-account-video').accountDisplayName, '已注销用户');
    assert.equal(
      database.getVideo('retained-account-video').creator,
      '测试创作者',
      '保留稿件时不得把作品 CC 署名误当成账号显示名擦除'
    );
    assert.equal(database.getDiscussion(retainedDiscussion.id).accountDisplayName, '已注销用户');
    assert.equal(database.getDiscussion(retainedDiscussion.id).nickname, '已注销用户');

    const user = database.createUser({
      id: 'delete-user', username: 'reserved_username', displayName: '待注销用户',
      passwordHash: 'hash', createdAt: '2026-08-23T14:00:00.000Z'
    });
    database.updateUserAvatar(user.id, {
      storageName: 'deleted-avatar.webp', mediaType: 'image/webp', updatedAt: '2026-08-23T14:01:00.000Z'
    });
    database.createSession({
      tokenHash: 'e'.repeat(64), userId: user.id, csrfTokenHash: 'f'.repeat(64),
      createdAt: '2026-08-23T14:02:00.000Z', expiresAt: '2026-09-23T14:02:00.000Z'
    });
    database.insertVideo({
      ...video('delete-account-video', '2026-08-23T14:03:00.000Z'), userId: user.id,
      coverStorageName: 'delete-account-cover.webp', coverMediaType: 'image/webp', coverSource: 'uploaded'
    });
    database.insertDiscussion({
      videoId: 'delete-account-video', userId: user.id, nickname: user.displayName,
      title: '删除我的讨论', bodyMarkdown: '将被清除', createdAt: '2026-08-23T14:04:00.000Z'
    });
    const result = database.deleteAccount(user.id, {
      deleteVideos: true, deleteDiscussions: true, deletedAt: '2026-08-23T14:05:00.000Z'
    });
    assert.equal(result.avatarStorageName, 'deleted-avatar.webp');
    assert.deepEqual(result.assets.map((item) => item.storageName), ['delete-account-video.mp4']);
    assert.equal(database.findSessionByTokenHash('e'.repeat(64)), null);
    assert.equal(database.getPublicUserProfile(user.username), null);
    const tombstoneUser = database.findUserByUsername(user.username);
    assert.equal(tombstoneUser.status, 'disabled');
    assert.equal(tombstoneUser.displayName, '已注销用户');
    assert.equal(tombstoneUser.avatarStorageName, null);
    assert.equal(database.listAvatarStorageNames().includes('deleted-avatar.webp'), false);
    assert.equal(database.getNotificationPreferences(user.id), null);
    assert.equal(database.getVideo('delete-account-video').deletedAt, '2026-08-23T14:05:00.000Z');
    assert.equal(
      database.getVideo('delete-account-video').archivePublic,
      true,
      '注销账号直接删除公开稿件时也应保留公开档案属性'
    );
    assert.equal(database.getVideo('delete-account-video').creator, '已注销用户');
    assert.deepEqual(database.listDiscussions('delete-account-video'), []);
    assert.deepEqual(
      database.listPendingFileDeletions().map((item) => [item.kind, item.storageName]),
      [
        ['video', 'delete-account-video.mp4'],
        ['cover', 'delete-account-cover.webp'],
        ['avatar', 'deleted-avatar.webp']
      ]
    );
    assert.throws(() => database.createUser({
      id: 'replacement-user', username: user.username, displayName: '冒名用户',
      passwordHash: 'hash', createdAt: '2026-08-23T14:06:00.000Z'
    }), /UNIQUE/i);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('schema v3 迁移到最新版保留树状讨论和投票，并更换父级删除约束', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-v3-migration-test-'));
  const databasePath = path.join(directory, 'v3.sqlite');
  let database;
  try {
    const seed = openDatabase(databasePath);
    const user = seed.createUser({
      id: 'v3-user', username: 'v3_user', displayName: 'V3 用户',
      passwordHash: 'hash', createdAt: '2026-08-23T15:00:00.000Z'
    });
    seed.insertVideo({ ...video('v3-video', '2026-08-23T15:01:00.000Z'), userId: user.id });
    const parent = seed.insertDiscussion({
      videoId: 'v3-video', userId: user.id, nickname: user.displayName,
      title: 'V3 主题', bodyMarkdown: 'V3 正文', createdAt: '2026-08-23T15:02:00.000Z'
    });
    const reply = seed.insertDiscussion({
      videoId: 'v3-video', userId: user.id, nickname: user.displayName,
      parentId: parent.id, bodyMarkdown: 'V3 回复', createdAt: '2026-08-23T15:03:00.000Z'
    });
    seed.setDiscussionVote(parent.id, user.id, 1, '2026-08-23T15:04:00.000Z');

    seed.raw.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
    `);
    removeV5SchemaFromDowngradeFixture(seed.raw, { rebuildDiscussions: true });
    seed.raw.exec(`
      DROP TABLE notification_vote_actors;
      DROP TABLE notifications;
      DROP TABLE notification_preferences;
      DROP TABLE file_deletion_queue;
      DROP INDEX idx_users_avatar_storage_name;
      DROP INDEX idx_users_public_username;
      DROP INDEX idx_videos_user_created_at;
      DROP INDEX idx_videos_public_user_created_at;
      ALTER TABLE users DROP COLUMN bio;
      ALTER TABLE users DROP COLUMN avatar_storage_name;
      ALTER TABLE users DROP COLUMN avatar_media_type;
      ALTER TABLE users DROP COLUMN updated_at;
      ALTER TABLE users DROP COLUMN deleted_at;
      ALTER TABLE videos DROP COLUMN withdrawn_at;
      ALTER TABLE videos DROP COLUMN deleted_at;
      ALTER TABLE videos DROP COLUMN archive_public;
      CREATE TABLE discussions_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL,
        body_markdown TEXT NOT NULL CHECK (length(body_markdown) BETWEEN 1 AND 5000),
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        title TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120),
        parent_id INTEGER REFERENCES discussions_v3(id) ON DELETE CASCADE,
        edited_at TEXT,
        deleted_at TEXT
      ) STRICT;
      INSERT INTO discussions_v3 (
        id, video_id, nickname, body_markdown, user_id, created_at,
        title, parent_id, edited_at, deleted_at
      ) SELECT
        id, video_id, nickname, body_markdown, user_id, created_at,
        title, parent_id, edited_at, deleted_at
      FROM discussions ORDER BY id;
      DROP TABLE discussions;
      ALTER TABLE discussions_v3 RENAME TO discussions;
      CREATE INDEX idx_discussions_video_created_at_id ON discussions(video_id, created_at ASC, id ASC);
      CREATE INDEX idx_discussions_user_id ON discussions(user_id);
      CREATE INDEX idx_discussions_parent_created_at ON discussions(parent_id, created_at ASC, id ASC);
      PRAGMA user_version = 3;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    seed.close();

    database = openDatabase(databasePath);
    assert.equal(database.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.equal(database.getUserById(user.id).bio, '');
    assert.equal(database.getVideo('v3-video').withdrawnAt, null);
    assert.equal(database.getDiscussion(parent.id).editCount, 0);
    assert.equal(database.getDiscussion(reply.id).parentId, parent.id);
    assert.equal(database.getDiscussion(parent.id, user.id).viewerVote, 1);
    assert.deepEqual(database.getNotificationPreferences(user.id), {
      userId: user.id, reply: true, videoVote: true, system: true,
      updatedAt: '2026-08-23T15:00:00.000Z'
    });
    const parentForeignKey = database.raw.prepare("PRAGMA foreign_key_list('discussions')").all()
      .find((entry) => entry.from === 'parent_id');
    assert.ok(['RESTRICT', 'NO ACTION'].includes(parentForeignKey.on_delete));
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('已标记为 v4 的旧数据库会补建旧字段并幂等迁移到最新版', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-v4-supplement-test-'));
  const databasePath = path.join(directory, 'v4.sqlite');
  let database;
  try {
    const seed = openDatabase(databasePath);
    seed.insertVideo(video('pre-supplement-video', '2026-08-23T16:00:00.000Z'));
    seed.close();

    const oldV4 = new DatabaseSync(databasePath);
    oldV4.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
    `);
    removeV5SchemaFromDowngradeFixture(oldV4);
    oldV4.exec(`
      DROP TABLE file_deletion_queue;
      CREATE TABLE file_deletion_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('video', 'cover', 'avatar')),
        storage_name TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (kind, storage_name)
      ) STRICT;
      INSERT INTO file_deletion_queue (
        kind, storage_name, attempt_count, last_error, created_at, updated_at
      ) VALUES (
        'cover', 'legacy-v4-cover.webp', 2, '旧失败任务',
        '2026-08-23T15:58:00.000Z', '2026-08-23T15:59:00.000Z'
      );
      DROP TABLE notification_vote_actors;
      ALTER TABLE videos DROP COLUMN archive_public;
      PRAGMA user_version = 4;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    oldV4.close();

    database = openDatabase(databasePath);
    assert.equal(database.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.ok(database.raw.prepare("PRAGMA table_info('videos')").all()
      .some((column) => column.name === 'archive_public'));
    assert.deepEqual(
      database.raw.prepare("PRAGMA table_info('file_deletion_queue')").all()
        .map((column) => column.name),
      [
        'id', 'kind', 'storage_name', 'attempt_count', 'last_error',
        'created_at', 'updated_at', 'next_attempt_at'
      ]
    );
    const migratedDeletion = database.listPendingFileDeletions()
      .find((item) => item.storageName === 'legacy-v4-cover.webp');
    assert.equal(migratedDeletion.nextAttemptAt, '2026-08-23T15:59:00.000Z');
    assert.equal(database.getVideo('pre-supplement-video').archivePublic, false);
    assert.equal(database.enqueueFileDeletion({
      kind: 'video',
      storageName: 'old-v4-orphan.mp4',
      createdAt: '2026-08-23T16:01:00.000Z'
    }).storageName, 'old-v4-orphan.mp4');
    assert.equal(database.listPendingFileDeletions().length, 2);

    database.close();
    database = openDatabase(databasePath);
    assert.equal(database.listPendingFileDeletions().length, 2, '重复打开迁移后数据库不会清空或重复队列');
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('最后一名有效管理员不能注销，存在另一名有效管理员后才允许注销', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-last-admin-delete-test-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'last-admin-delete.sqlite'));
    const first = database.createUser({
      id: 'last-admin-delete-first',
      username: 'last_admin_delete_first',
      displayName: '首位管理员',
      passwordHash: 'hash',
      createdAt: '2026-08-25T09:00:00.000Z'
    });
    database.raw.prepare("UPDATE users SET role = 'administrator' WHERE id = ?").run(first.id);

    const refused = database.deleteAccount(first.id, {
      deleteVideos: false,
      deleteDiscussions: false,
      deletedAt: '2026-08-25T09:01:00.000Z'
    });
    assert.equal(refused, null);
    assert.equal(database.getUserById(first.id).status, 'active');
    assert.equal(database.getUserById(first.id).deletedAt, null);

    const second = database.createUser({
      id: 'last-admin-delete-second',
      username: 'last_admin_delete_second',
      displayName: '第二位管理员',
      passwordHash: 'hash',
      createdAt: '2026-08-25T09:02:00.000Z'
    });
    database.raw.prepare("UPDATE users SET role = 'administrator' WHERE id = ?").run(second.id);

    const deleted = database.deleteAccount(first.id, {
      deleteVideos: false,
      deleteDiscussions: false,
      deletedAt: '2026-08-25T09:03:00.000Z'
    });
    assert.ok(deleted);
    assert.equal(database.getUserById(first.id).status, 'disabled');
    assert.equal(database.getUserById(first.id).deletedAt, '2026-08-25T09:03:00.000Z');
    assert.equal(database.getUserById(second.id).status, 'active');
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
