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

test('旧版无账号数据库会原地迁移并完整保留视频和讨论', async () => {
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
    const migratedVideo = database.getVideo('legacy-video');
    assert.equal(migratedVideo.title, '旧视频');
    assert.equal(migratedVideo.userId, null);
    const migratedDiscussion = database.listDiscussions('legacy-video')[0];
    assert.equal(migratedDiscussion.bodyMarkdown, '旧讨论');
    assert.equal(migratedDiscussion.nickname, '月白灯塔111');
    assert.equal(migratedDiscussion.userId, null);
    assert.ok(database.raw.prepare("PRAGMA table_info('users')").all().length > 0);
    assert.ok(database.raw.prepare("PRAGMA table_info('sessions')").all().length > 0);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
