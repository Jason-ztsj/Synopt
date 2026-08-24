import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../src/database.js';

function user(id, createdAt) {
  return {
    id,
    username: id.replaceAll('-', '_'),
    displayName: `用户 ${id}`,
    passwordHash: 'test-password-hash',
    createdAt
  };
}

function video(id, createdAt, overrides = {}) {
  return {
    id,
    title: `标题 ${id}`,
    creator: `创作者 ${id}`,
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
    validationSummary: {},
    ingestOperation: 'unknown',
    visibility: 'public',
    moderationStatus: 'visible',
    createdAt,
    ...overrides
  };
}

test('账号注销后，已认证旧请求不能写入内容、投票、会话或偏好', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-account-race-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'race.sqlite'));
    const owner = database.createUser(user('race-owner', '2026-08-24T00:00:00.000Z'));
    const stale = database.createUser(user('race-stale', '2026-08-24T00:00:01.000Z'));
    database.insertVideo(video('race-target', '2026-08-24T00:01:00.000Z', { userId: owner.id }));
    database.insertVideo(video('race-owned', '2026-08-24T00:01:01.000Z', { userId: stale.id }));
    database.insertVideo(video('race-withdrawn-owned', '2026-08-24T00:01:02.000Z', { userId: stale.id }));
    database.withdrawVideo('race-withdrawn-owned', stale.id, '2026-08-24T00:01:03.000Z');
    const existing = database.insertDiscussion({
      videoId: 'race-target',
      userId: stale.id,
      nickname: stale.displayName,
      title: '注销前主题',
      bodyMarkdown: '注销前正文',
      createdAt: '2026-08-24T00:02:00.000Z'
    });

    assert.ok(database.deleteAccount(stale.id, {
      deleteVideos: false,
      deleteDiscussions: false,
      deletedAt: '2026-08-24T00:03:00.000Z'
    }));
    const discussionCount = database.raw.prepare('SELECT count(*) AS count FROM discussions').get().count;

    assert.equal(database.insertVideo(video('race-late-video', '2026-08-24T00:04:00.000Z', {
      userId: stale.id
    })), null);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM videos WHERE id = 'race-late-video'").get().count, 0);

    assert.equal(database.insertDiscussion({
      videoId: 'race-target',
      userId: stale.id,
      nickname: stale.displayName,
      title: '注销后主题',
      bodyMarkdown: '不应写入',
      createdAt: '2026-08-24T00:04:01.000Z'
    }), null);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM discussions').get().count, discussionCount);

    assert.equal(database.editDiscussion(existing.id, stale.id, {
      title: '不应修改',
      bodyMarkdown: '不应修改',
      editedAt: '2026-08-24T00:04:02.000Z'
    }), null);
    assert.equal(database.getDiscussion(existing.id).bodyMarkdown, '注销前正文');
    assert.equal(database.deleteDiscussion(existing.id, stale.id, '2026-08-24T00:04:03.000Z'), null);
    assert.equal(database.getDiscussion(existing.id).deletedAt, null);

    assert.equal(database.setVideoVote('race-target', stale.id, 1, '2026-08-24T00:04:04.000Z'), null);
    assert.equal(database.setDiscussionVote(existing.id, stale.id, 1, '2026-08-24T00:04:05.000Z'), null);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM video_votes WHERE user_id = ?').get(stale.id).count, 0);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM discussion_votes WHERE user_id = ?').get(stale.id).count, 0);

    assert.equal(database.createSession({
      tokenHash: 'a'.repeat(64),
      userId: stale.id,
      csrfTokenHash: 'b'.repeat(64),
      createdAt: '2026-08-24T00:04:06.000Z',
      expiresAt: '2026-09-24T00:04:06.000Z'
    }), null);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM sessions WHERE user_id = ?').get(stale.id).count, 0);
    assert.equal(database.updateNotificationPreferences(stale.id, {
      reply: false,
      videoVote: false,
      system: false
    }, '2026-08-24T00:04:07.000Z'), null);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM notification_preferences WHERE user_id = ?').get(stale.id).count, 0);

    assert.equal(database.withdrawVideo('race-owned', stale.id, '2026-08-24T00:04:08.000Z'), null);
    assert.equal(database.getVideo('race-owned').withdrawnAt, null);
    assert.equal(database.republishVideo('race-withdrawn-owned', stale.id), null);
    assert.ok(database.getVideo('race-withdrawn-owned').withdrawnAt);
    assert.equal(database.markVideoPermanentlyDeleted(
      'race-withdrawn-owned', stale.id, '2026-08-24T00:04:09.000Z'
    ), null);
    assert.equal(database.getVideo('race-withdrawn-owned').deletedAt, null);
    assert.equal(database.deleteAccount(stale.id, {
      deleteVideos: true,
      deleteDiscussions: true,
      deletedAt: '2026-08-24T00:04:10.000Z'
    }), null);
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('撤回或永久删除后拒绝新讨论和非零投票，但仍允许清除旧投票', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-content-state-race-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'state.sqlite'));
    const owner = database.createUser(user('state-owner', '2026-08-24T01:00:00.000Z'));
    const cleanupActor = database.createUser(user('state-cleanup', '2026-08-24T01:00:01.000Z'));
    const blockedActor = database.createUser(user('state-blocked', '2026-08-24T01:00:02.000Z'));
    database.insertVideo(video('state-video', '2026-08-24T01:01:00.000Z', { userId: owner.id }));
    const topic = database.insertDiscussion({
      videoId: 'state-video',
      userId: owner.id,
      nickname: owner.displayName,
      title: '状态主题',
      bodyMarkdown: '状态正文',
      createdAt: '2026-08-24T01:02:00.000Z'
    });
    database.setVideoVote('state-video', cleanupActor.id, 1, '2026-08-24T01:03:00.000Z');
    database.setDiscussionVote(topic.id, cleanupActor.id, 1, '2026-08-24T01:03:01.000Z');

    assert.ok(database.withdrawVideo('state-video', owner.id, '2026-08-24T01:04:00.000Z'));
    assert.equal(database.insertDiscussion({
      videoId: 'state-video',
      userId: blockedActor.id,
      nickname: blockedActor.displayName,
      title: '撤回后主题',
      bodyMarkdown: '不应写入',
      createdAt: '2026-08-24T01:04:01.000Z'
    }), null);
    assert.equal(database.setVideoVote('state-video', blockedActor.id, 1, '2026-08-24T01:04:02.000Z'), null);
    assert.equal(database.setDiscussionVote(topic.id, blockedActor.id, -1, '2026-08-24T01:04:03.000Z'), null);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM video_votes WHERE user_id = ?').get(blockedActor.id).count, 0);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM discussion_votes WHERE user_id = ?').get(blockedActor.id).count, 0);

    assert.equal(database.setVideoVote('state-video', cleanupActor.id, 0, '2026-08-24T01:04:04.000Z'), null);
    assert.equal(database.setDiscussionVote(topic.id, cleanupActor.id, 0, '2026-08-24T01:04:05.000Z'), null);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM video_votes WHERE user_id = ?').get(cleanupActor.id).count, 0);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM discussion_votes WHERE user_id = ?').get(cleanupActor.id).count, 0);

    assert.ok(database.markVideoPermanentlyDeleted(
      'state-video', owner.id, '2026-08-24T01:05:00.000Z'
    ));
    assert.equal(database.insertDiscussion({
      videoId: 'state-video',
      userId: blockedActor.id,
      nickname: blockedActor.displayName,
      title: '删除后主题',
      bodyMarkdown: '不应写入',
      createdAt: '2026-08-24T01:05:01.000Z'
    }), null);
    assert.equal(database.setVideoVote('state-video', blockedActor.id, -1, '2026-08-24T01:05:02.000Z'), null);
    assert.equal(database.setDiscussionVote(topic.id, blockedActor.id, 1, '2026-08-24T01:05:03.000Z'), null);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM video_votes WHERE video_id = ?').get('state-video').count, 0);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM discussion_votes WHERE discussion_id = ?').get(topic.id).count, 0);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('父讨论在并发窗口内被删除后，旧页面提交的回复不会写入', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-parent-delete-race-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'parent.sqlite'));
    const author = database.createUser(user('parent-author', '2026-08-24T02:00:00.000Z'));
    const replier = database.createUser(user('parent-replier', '2026-08-24T02:00:01.000Z'));
    database.insertVideo(video('parent-video', '2026-08-24T02:01:00.000Z', { userId: author.id }));
    const parent = database.insertDiscussion({
      videoId: 'parent-video',
      userId: author.id,
      nickname: author.displayName,
      title: '父主题',
      bodyMarkdown: '父正文',
      createdAt: '2026-08-24T02:02:00.000Z'
    });
    database.insertDiscussion({
      videoId: 'parent-video',
      userId: replier.id,
      nickname: replier.displayName,
      parentId: parent.id,
      bodyMarkdown: '已有回复使父级保留墓碑',
      createdAt: '2026-08-24T02:02:01.000Z'
    });
    const before = database.raw.prepare('SELECT count(*) AS count FROM discussions').get().count;
    assert.deepEqual(database.deleteDiscussion(parent.id, author.id, '2026-08-24T02:03:00.000Z'), {
      id: parent.id,
      mode: 'tombstoned'
    });
    assert.ok(database.getDiscussion(parent.id).deletedAt);

    assert.equal(database.insertDiscussion({
      videoId: 'parent-video',
      userId: replier.id,
      nickname: replier.displayName,
      parentId: parent.id,
      bodyMarkdown: '竞态窗口中的迟到回复',
      createdAt: '2026-08-24T02:03:01.000Z'
    }), null);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM discussions').get().count, before);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧 v4 投票聚合关闭不完整窗口，后续聚合保持事件数与参与者行一致', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-v4-vote-actor-race-'));
  const databasePath = path.join(directory, 'legacy-v4.sqlite');
  let database;
  try {
    database = openDatabase(databasePath);
    const owner = database.createUser(user('notice-owner', '2026-08-24T03:00:00.000Z'));
    const oldVoterA = database.createUser(user('notice-old-a', '2026-08-24T03:00:01.000Z'));
    const oldVoterB = database.createUser(user('notice-old-b', '2026-08-24T03:00:02.000Z'));
    const replier = database.createUser(user('notice-replier', '2026-08-24T03:00:03.000Z'));
    const futureVoterA = database.createUser(user('notice-future-a', '2026-08-24T03:00:04.000Z'));
    const futureVoterB = database.createUser(user('notice-future-b', '2026-08-24T03:00:05.000Z'));
    database.insertVideo(video('notice-video', '2026-08-24T03:01:00.000Z', { userId: owner.id }));
    const topic = database.insertDiscussion({
      videoId: 'notice-video',
      userId: owner.id,
      nickname: owner.displayName,
      title: '通知主题',
      bodyMarkdown: '通知正文',
      createdAt: '2026-08-24T03:02:00.000Z'
    });
    const reply = database.insertDiscussion({
      videoId: 'notice-video',
      userId: replier.id,
      nickname: replier.displayName,
      parentId: topic.id,
      bodyMarkdown: '回复通知',
      createdAt: '2026-08-24T03:02:01.000Z'
    });
    const system = database.createSystemNotification({
      recipientUserId: owner.id,
      title: '系统通知',
      body: '保持未读',
      createdAt: '2026-08-24T03:02:02.000Z'
    });
    database.setVideoVote('notice-video', oldVoterA.id, 1, '2026-08-24T03:03:00.000Z');
    database.setVideoVote('notice-video', oldVoterB.id, 1, '2026-08-24T03:03:01.000Z');
    const oldVote = database.raw.prepare(`
      SELECT id, event_count, actor_user_id FROM notifications
      WHERE recipient_user_id = ? AND type = 'video_upvote' AND is_read = 0
    `).get(owner.id);
    assert.equal(oldVote.event_count, 2);
    assert.equal(database.raw.prepare(`
      SELECT count(*) AS count FROM notification_vote_actors WHERE notification_id = ?
    `).get(oldVote.id).count, 2);

    database.close();
    database = null;
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('DROP TABLE notification_vote_actors; PRAGMA user_version = 4;');
    legacy.close();

    database = openDatabase(databasePath);
    const migratedVote = database.raw.prepare(`
      SELECT event_count, is_read, read_at, actor_user_id FROM notifications WHERE id = ?
    `).get(oldVote.id);
    assert.equal(migratedVote.event_count, 2);
    assert.equal(migratedVote.is_read, 1);
    assert.ok(migratedVote.read_at);
    assert.equal(migratedVote.actor_user_id, null);
    assert.equal(database.raw.prepare(`
      SELECT count(*) AS count FROM notification_vote_actors WHERE notification_id = ?
    `).get(oldVote.id).count, 0);
    const replyAfterMigration = database.raw.prepare(`
      SELECT is_read, actor_user_id, event_count FROM notifications WHERE id = ?
    `).get(database.raw.prepare("SELECT id FROM notifications WHERE type = 'reply' AND discussion_id = ?").get(reply.id).id);
    assert.deepEqual({ ...replyAfterMigration }, {
      is_read: 0,
      actor_user_id: replier.id,
      event_count: 1
    });
    const systemAfterMigration = database.raw.prepare(`
      SELECT is_read, actor_user_id, event_count FROM notifications WHERE id = ?
    `).get(system.id);
    assert.deepEqual({ ...systemAfterMigration }, {
      is_read: 0,
      actor_user_id: null,
      event_count: 1
    });
    assert.equal(database.getUnreadNotificationCount(owner.id), 2);

    database.close();
    database = openDatabase(databasePath);
    assert.deepEqual({ ...database.raw.prepare(`
      SELECT event_count, is_read, actor_user_id FROM notifications WHERE id = ?
    `).get(oldVote.id) }, {
      event_count: 2,
      is_read: 1,
      actor_user_id: null
    });
    assert.equal(database.getUnreadNotificationCount(owner.id), 2, '重复打开不得重新激活旧投票窗口');

    database.setVideoVote('notice-video', futureVoterA.id, 1, '2026-08-24T03:04:00.000Z');
    database.setVideoVote('notice-video', futureVoterB.id, 1, '2026-08-24T03:04:01.000Z');
    let currentVote = database.raw.prepare(`
      SELECT id, event_count FROM notifications
      WHERE recipient_user_id = ? AND type = 'video_upvote' AND is_read = 0
    `).get(owner.id);
    assert.equal(currentVote.event_count, 2);
    assert.equal(database.raw.prepare(`
      SELECT count(*) AS count FROM notification_vote_actors WHERE notification_id = ?
    `).get(currentVote.id).count, currentVote.event_count);

    database.close();
    database = openDatabase(databasePath);
    currentVote = database.raw.prepare(`
      SELECT id, event_count FROM notifications
      WHERE recipient_user_id = ? AND type = 'video_upvote' AND is_read = 0
    `).get(owner.id);
    assert.equal(currentVote.event_count, 2, '完整的新窗口在重复打开后仍保持未读');
    assert.equal(database.raw.prepare(`
      SELECT count(*) AS count FROM notification_vote_actors WHERE notification_id = ?
    `).get(currentVote.id).count, currentVote.event_count);

    database.setVideoVote('notice-video', futureVoterA.id, 0, '2026-08-24T03:05:00.000Z');
    currentVote = database.raw.prepare(`
      SELECT id, event_count FROM notifications
      WHERE recipient_user_id = ? AND type = 'video_upvote' AND is_read = 0
    `).get(owner.id);
    assert.equal(currentVote.event_count, 1);
    assert.equal(database.raw.prepare(`
      SELECT count(*) AS count FROM notification_vote_actors WHERE notification_id = ?
    `).get(currentVote.id).count, currentVote.event_count);
    database.setVideoVote('notice-video', futureVoterB.id, 0, '2026-08-24T03:05:01.000Z');
    assert.equal(database.raw.prepare(`
      SELECT count(*) AS count FROM notifications
      WHERE recipient_user_id = ? AND type = 'video_upvote' AND is_read = 0
    `).get(owner.id).count, 0);
    assert.equal(database.getUnreadNotificationCount(owner.id), 2, '回复和系统未读数不受投票窗口迁移及取消影响');
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
