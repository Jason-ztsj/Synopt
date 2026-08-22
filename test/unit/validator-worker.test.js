import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MediaRejectedError } from '../../src/media-validator.js';
import { cleanupOrphanedUploads, processNextValidation } from '../../src/validator-worker.js';

function testConfig(root) {
  return {
    videoStoragePath: path.join(root, 'videos'),
    pendingStoragePath: path.join(root, 'videos', '.pending'),
    temporaryStoragePath: path.join(root, 'videos', '.tmp'),
    mediaValidationPollMs: 50
  };
}

function fakeDatabase(video) {
  const events = [];
  let claimed = false;
  return {
    events,
    claimNextVideoForValidation(startedAt) {
      if (claimed) return null;
      claimed = true;
      events.push(['claim', startedAt]);
      return video;
    },
    completeVideoValidation(id, result, at) {
      events.push(['complete', id, result, at]);
      return 1;
    },
    rejectVideoValidation(id, summary, at) {
      events.push(['reject', id, summary, at]);
      return 1;
    },
    failVideoValidation(id, summary, at) {
      events.push(['fail', id, summary, at]);
      return 1;
    }
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'tongjian-worker-test-'));
  const config = testConfig(root);
  await mkdir(config.pendingStoragePath, { recursive: true });
  await mkdir(config.temporaryStoragePath, { recursive: true });
  return { root, config };
}

test('validator worker 通过后原子移出隔离区并提交 ready 元数据', async (t) => {
  const { root, config } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = { id: 'video-ready', storageName: 'asset.mp4', mediaType: 'video/mp4' };
  const database = fakeDatabase(video);
  const pendingPath = path.join(config.pendingStoragePath, video.storageName);
  const finalPath = path.join(config.videoStoragePath, video.storageName);
  await writeFile(pendingPath, 'trusted-after-validation');
  const validation = {
    mediaType: 'video/mp4', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac',
    playbackStrategy: 'native', sha256: 'a'.repeat(64), durationSeconds: 1,
    width: 64, height: 64, frameRate: 24, warningCount: 0, summary: {}
  };

  assert.equal(await processNextValidation(database, config, { validate: async () => validation }), true);
  assert.equal((await readFile(finalPath, 'utf8')), 'trusted-after-validation');
  await assert.rejects(stat(pendingPath), { code: 'ENOENT' });
  assert.equal(database.events.at(-1)[0], 'complete');
});

test('validator worker 区分媒体拒绝与系统失败，并只删除确定被拒绝的文件', async (t) => {
  const rejectedFixture = await fixture();
  const failedFixture = await fixture();
  t.after(async () => {
    await rm(rejectedFixture.root, { recursive: true, force: true });
    await rm(failedFixture.root, { recursive: true, force: true });
  });

  const rejectedVideo = { id: 'video-rejected', storageName: 'bad.mp4', mediaType: 'video/mp4' };
  const rejectedDatabase = fakeDatabase(rejectedVideo);
  const rejectedPath = path.join(rejectedFixture.config.pendingStoragePath, rejectedVideo.storageName);
  await writeFile(rejectedPath, 'bad-media');
  await processNextValidation(rejectedDatabase, rejectedFixture.config, {
    validate: async () => { throw new MediaRejectedError('结构无效', 'INVALID_STRUCTURE'); }
  });
  await assert.rejects(stat(rejectedPath), { code: 'ENOENT' });
  assert.equal(rejectedDatabase.events.at(-1)[0], 'reject');

  const failedVideo = { id: 'video-failed', storageName: 'retry.mp4', mediaType: 'video/mp4' };
  const failedDatabase = fakeDatabase(failedVideo);
  const failedPath = path.join(failedFixture.config.pendingStoragePath, failedVideo.storageName);
  await writeFile(failedPath, 'keep-for-retry');
  await processNextValidation(failedDatabase, failedFixture.config, {
    validate: async () => { throw new Error('ffmpeg unavailable'); }
  });
  assert.equal(await readFile(failedPath, 'utf8'), 'keep-for-retry');
  assert.equal(failedDatabase.events.at(-1)[0], 'fail');
});

test('孤儿清理保留数据库跟踪文件与新上传，只删除超过宽限期的残留', async (t) => {
  const { root, config } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const tracked = path.join(config.pendingStoragePath, 'tracked.mp4');
  const orphan = path.join(config.pendingStoragePath, 'orphan.webm');
  const recent = path.join(config.pendingStoragePath, 'recent.mp4');
  const oldTemporary = path.join(config.temporaryStoragePath, 'old.upload');
  const unrelatedTemporary = path.join(config.temporaryStoragePath, 'keep.txt');
  await Promise.all([
    writeFile(tracked, 'tracked'),
    writeFile(orphan, 'orphan'),
    writeFile(recent, 'recent'),
    writeFile(oldTemporary, 'temporary'),
    writeFile(unrelatedTemporary, 'unrelated')
  ]);
  const now = new Date('2026-08-22T12:00:00.000Z');
  const old = new Date(now.getTime() - 2 * 60 * 60_000);
  await Promise.all([
    utimes(tracked, old, old),
    utimes(orphan, old, old),
    utimes(oldTemporary, old, old),
    utimes(recent, now, now)
  ]);

  const removed = await cleanupOrphanedUploads({
    listVideoStorageNames: () => ['tracked.mp4']
  }, config, now);
  assert.equal(removed, 2);
  assert.equal(await readFile(tracked, 'utf8'), 'tracked');
  assert.equal(await readFile(recent, 'utf8'), 'recent');
  assert.equal(await readFile(unrelatedTemporary, 'utf8'), 'unrelated');
  await assert.rejects(stat(orphan), { code: 'ENOENT' });
  await assert.rejects(stat(oldTemporary), { code: 'ENOENT' });
});
