import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../../src/database.js';

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
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
