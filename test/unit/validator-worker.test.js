import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MediaRejectedError } from '../../src/media-validator.js';
import {
  cleanupOrphanedUploads,
  processNextValidation,
  processPendingFileDeletions
} from '../../src/validator-worker.js';

function testConfig(root) {
  return {
    videoStoragePath: path.join(root, 'videos'),
    pendingStoragePath: path.join(root, 'videos', '.pending'),
    temporaryStoragePath: path.join(root, 'videos', '.tmp'),
    coverStoragePath: path.join(root, 'covers'),
    avatarStoragePath: path.join(root, 'avatars'),
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
    completeVideoValidation(id, result, at, claimStartedAt) {
      events.push(['complete', id, result, at, claimStartedAt]);
      return 1;
    },
    rejectVideoValidation(id, summary, at, claimStartedAt) {
      events.push(['reject', id, summary, at, claimStartedAt]);
      return 1;
    },
    failVideoValidation(id, summary, at, claimStartedAt) {
      events.push(['fail', id, summary, at, claimStartedAt]);
      return 1;
    },
    renewVideoValidationLease(id, claimStartedAt, renewedAt) {
      events.push(['renew', id, claimStartedAt, renewedAt]);
      return 1;
    }
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'tongjian-worker-test-'));
  const config = testConfig(root);
  await mkdir(config.pendingStoragePath, { recursive: true });
  await mkdir(config.temporaryStoragePath, { recursive: true });
  await mkdir(config.coverStoragePath, { recursive: true });
  await mkdir(config.avatarStoragePath, { recursive: true });
  return { root, config };
}

test('validator worker 通过后原子移出隔离区并提交 ready 元数据', async (t) => {
  const { root, config } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = {
    id: 'video-ready', storageName: 'asset.mp4', mediaType: 'video/mp4',
    validationStartedAt: '2026-08-22T11:59:00.000Z'
  };
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
  const lastRenewal = database.events.findLast((event) => event[0] === 'renew');
  assert.equal(database.events.at(-1)[4], lastRenewal[3], '提交结果必须携带最新租约版本');
});

test('验证任务失去租约后放弃旧结果，不移动或改写新 worker 的任务', async (t) => {
  const { root, config } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = {
    id: 'video-lease-lost', storageName: 'lease-lost.mp4', mediaType: 'video/mp4',
    validationStartedAt: '2026-08-22T12:00:00.000Z', coverStorageName: 'already-covered.jpg'
  };
  const database = fakeDatabase(video);
  database.renewVideoValidationLease = () => 0;
  const pendingPath = path.join(config.pendingStoragePath, video.storageName);
  await writeFile(pendingPath, 'valid-but-stale-worker');
  const validation = {
    mediaType: 'video/mp4', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac',
    playbackStrategy: 'native', sha256: 'a'.repeat(64), durationSeconds: 1,
    width: 64, height: 64, frameRate: 24, warningCount: 0, summary: {}
  };
  const originalConsoleWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await processNextValidation(database, config, { validate: async () => validation }), true);
  } finally {
    console.warn = originalConsoleWarn;
  }
  assert.equal(await readFile(pendingPath, 'utf8'), 'valid-but-stale-worker');
  assert.equal(database.events.some((event) => ['complete', 'reject', 'fail'].includes(event[0])), false);
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

test('验证期间稿件状态变更时会清理未能入库的生成封面', async (t) => {
  const { root, config } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = { id: 'video-deleted-during-validation', storageName: 'racing.mp4', mediaType: 'video/mp4' };
  const database = fakeDatabase(video);
  database.setVideoCover = () => 0;
  const pendingPath = path.join(config.pendingStoragePath, video.storageName);
  const generatedCoverPath = path.join(config.coverStoragePath, 'generated-race.jpg');
  await writeFile(pendingPath, 'valid-enough-for-stubbed-validator');

  const validation = {
    mediaType: 'video/mp4', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac',
    playbackStrategy: 'native', sha256: 'a'.repeat(64), durationSeconds: 1,
    width: 64, height: 64, frameRate: 24, warningCount: 0, summary: {}
  };
  await processNextValidation(database, config, {
    validate: async () => validation,
    generateCover: async () => {
      await writeFile(generatedCoverPath, 'generated-cover');
      return { storageName: 'generated-race.jpg', mediaType: 'image/jpeg', source: 'generated' };
    }
  });

  await assert.rejects(stat(generatedCoverPath), { code: 'ENOENT' });
  assert.equal(database.events.at(-1)[0], 'fail');
});

test('持久删除队列覆盖隔离/公开视频、封面和头像，并对失败任务退避', async (t) => {
  const { root, config } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const pendingVideo = path.join(config.pendingStoragePath, 'delete-me.mp4');
  const publicVideo = path.join(config.videoStoragePath, 'delete-me.mp4');
  const cover = path.join(config.coverStoragePath, 'delete-cover.webp');
  const avatar = path.join(config.avatarStoragePath, 'delete-avatar.webp');
  const undeletable = path.join(config.coverStoragePath, 'directory-is-not-a-file.webp');
  await Promise.all([
    writeFile(pendingVideo, 'pending'),
    writeFile(publicVideo, 'public'),
    writeFile(cover, 'cover'),
    writeFile(avatar, 'avatar'),
    mkdir(undeletable)
  ]);

  const now = new Date('2026-08-23T12:00:00.000Z');
  const tasks = [
    { id: 1, kind: 'video', storageName: 'delete-me.mp4', attemptCount: 0, updatedAt: now.toISOString() },
    { id: 2, kind: 'cover', storageName: 'delete-cover.webp', attemptCount: 0, updatedAt: now.toISOString() },
    { id: 3, kind: 'avatar', storageName: 'delete-avatar.webp', attemptCount: 0, updatedAt: now.toISOString() },
    { id: 4, kind: 'cover', storageName: 'directory-is-not-a-file.webp', attemptCount: 0, updatedAt: now.toISOString() }
  ];
  const completed = [];
  const failed = [];
  const listCalls = [];
  const database = {
    listPendingFileDeletions(options) { listCalls.push(options); return tasks; },
    completeFileDeletion(id) { completed.push(id); return 1; },
    failFileDeletion(id, error, updatedAt) { failed.push({ id, error, updatedAt }); return {}; }
  };

  const result = await processPendingFileDeletions(database, config, { now: () => now });
  assert.deepEqual(result, { completed: 3, failed: 1, deferred: 0 });
  assert.deepEqual(listCalls, [{ limit: 50, eligibleAt: now.toISOString() }]);
  assert.deepEqual(completed, [1, 2, 3]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, 4);
  assert.equal(failed[0].updatedAt, now.toISOString());
  for (const deletedPath of [pendingVideo, publicVideo, cover, avatar]) {
    await assert.rejects(stat(deletedPath), { code: 'ENOENT' });
  }
});

test('孤儿清理保留数据库、完整删除队列跟踪文件与新上传，只删除超过宽限期的残留', async (t) => {
  const { root, config } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const tracked = path.join(config.pendingStoragePath, 'tracked.mp4');
  const orphan = path.join(config.pendingStoragePath, 'orphan.webm');
  const recent = path.join(config.pendingStoragePath, 'recent.mp4');
  const oldTemporary = path.join(config.temporaryStoragePath, 'old.upload');
  const oldAvatarTemporary = path.join(config.temporaryStoragePath, 'old.avatar-upload');
  const oldNormalizedImage = path.join(config.temporaryStoragePath, 'old.normalized-image.webp');
  const unrelatedTemporary = path.join(config.temporaryStoragePath, 'keep.txt');
  const trackedAvatar = path.join(config.avatarStoragePath, 'tracked-avatar.webp');
  const orphanAvatar = path.join(config.avatarStoragePath, 'orphan-avatar.webp');
  const queuedVideo = path.join(config.pendingStoragePath, 'queued-after-one-hundred.mp4');
  const queuedCover = path.join(config.coverStoragePath, 'queued-cover.webp');
  const queuedAvatar = path.join(config.avatarStoragePath, 'queued-avatar.webp');
  await Promise.all([
    writeFile(tracked, 'tracked'),
    writeFile(orphan, 'orphan'),
    writeFile(recent, 'recent'),
    writeFile(oldTemporary, 'temporary'),
    writeFile(oldAvatarTemporary, 'avatar-temporary'),
    writeFile(oldNormalizedImage, 'normalized-temporary'),
    writeFile(unrelatedTemporary, 'unrelated'),
    writeFile(trackedAvatar, 'tracked-avatar'),
    writeFile(orphanAvatar, 'orphan-avatar'),
    writeFile(queuedVideo, 'queued-video'),
    writeFile(queuedCover, 'queued-cover'),
    writeFile(queuedAvatar, 'queued-avatar')
  ]);
  const now = new Date('2026-08-22T12:00:00.000Z');
  const old = new Date(now.getTime() - 2 * 60 * 60_000);
  await Promise.all([
    utimes(tracked, old, old),
    utimes(orphan, old, old),
    utimes(oldTemporary, old, old),
    utimes(oldAvatarTemporary, old, old),
    utimes(oldNormalizedImage, old, old),
    utimes(trackedAvatar, old, old),
    utimes(orphanAvatar, old, old),
    utimes(queuedVideo, old, old),
    utimes(queuedCover, old, old),
    utimes(queuedAvatar, old, old),
    utimes(recent, now, now)
  ]);

  const queuedTargets = Array.from({ length: 100 }, (_, index) => ({
    kind: 'cover', storageName: `unrelated-${index}.webp`
  }));
  queuedTargets.push(
    { kind: 'video', storageName: 'queued-after-one-hundred.mp4' },
    { kind: 'cover', storageName: 'queued-cover.webp' },
    { kind: 'avatar', storageName: 'queued-avatar.webp' }
  );
  const removed = await cleanupOrphanedUploads({
    listVideoStorageNames: () => ['tracked.mp4'],
    listAvatarStorageNames: () => ['tracked-avatar.webp'],
    listFileDeletionTargets: () => queuedTargets
  }, config, now);
  assert.equal(removed, 5);
  assert.equal(await readFile(tracked, 'utf8'), 'tracked');
  assert.equal(await readFile(recent, 'utf8'), 'recent');
  assert.equal(await readFile(unrelatedTemporary, 'utf8'), 'unrelated');
  assert.equal(await readFile(trackedAvatar, 'utf8'), 'tracked-avatar');
  assert.equal(await readFile(queuedVideo, 'utf8'), 'queued-video');
  assert.equal(await readFile(queuedCover, 'utf8'), 'queued-cover');
  assert.equal(await readFile(queuedAvatar, 'utf8'), 'queued-avatar');
  await assert.rejects(stat(orphan), { code: 'ENOENT' });
  await assert.rejects(stat(oldTemporary), { code: 'ENOENT' });
  await assert.rejects(stat(oldAvatarTemporary), { code: 'ENOENT' });
  await assert.rejects(stat(oldNormalizedImage), { code: 'ENOENT' });
  await assert.rejects(stat(orphanAvatar), { code: 'ENOENT' });
});

test('孤儿文件无法删除时只记录错误，不会中止清理 worker', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 不受目录写权限限制');
    return;
  }
  const { root, config } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stubborn = path.join(config.pendingStoragePath, 'stubborn.mp4');
  await writeFile(stubborn, 'keep-until-next-sweep');
  const now = new Date('2026-08-22T12:00:00.000Z');
  const old = new Date(now.getTime() - 2 * 60 * 60_000);
  await utimes(stubborn, old, old);
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  await chmod(config.pendingStoragePath, 0o500);
  try {
    assert.equal(await cleanupOrphanedUploads({}, config, now), 0);
  } finally {
    await chmod(config.pendingStoragePath, 0o700);
    console.error = originalConsoleError;
  }
  assert.equal(await readFile(stubborn, 'utf8'), 'keep-until-next-sweep');
  assert.ok(errors.some((entry) => entry.includes('孤立文件清理失败')));
});

test('被拒绝媒体的即时 unlink 失败不会阻断状态落库', async (t) => {
  const { root, config } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = {
    id: 'video-rejected-cleanup-failure',
    storageName: 'bad-with-cover.mp4',
    mediaType: 'video/mp4',
    coverStorageName: 'stuck-cover.webp'
  };
  const database = fakeDatabase(video);
  const pendingPath = path.join(config.pendingStoragePath, video.storageName);
  const undeletableCover = path.join(config.coverStoragePath, video.coverStorageName);
  await writeFile(pendingPath, 'bad-media');
  await mkdir(undeletableCover);
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(await processNextValidation(database, config, {
      validate: async () => { throw new MediaRejectedError('结构无效', 'INVALID_STRUCTURE'); }
    }), true);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(database.events.at(-1)[0], 'reject');
  await assert.rejects(stat(pendingPath), { code: 'ENOENT' });
  assert.equal((await stat(undeletableCover)).isDirectory(), true);
  assert.ok(errors.some((entry) => entry.includes('拒绝媒体即时清理失败')));
});
