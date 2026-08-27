import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { loadConfig } from '../../src/config.js';
import {
  decodeErrorRate,
  MediaRejectedError,
  MediaValidationSystemError,
  parseProgress,
  probeCanonicalMedia,
  validateMediaFile
} from '../../src/media-validator.js';
import { processNextValidation, runValidatorWorker } from '../../src/validator-worker.js';

const execFileAsync = promisify(execFile);

function hasMediaTool(command) {
  const result = spawnSync(command, ['-version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore']
  });
  return !result.error && result.status === 0;
}

const mediaToolsAvailable = hasMediaTool('ffmpeg') && hasMediaTool('ffprobe');

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function fakeFtypFile() {
  const buffer = Buffer.alloc(128, 0x61);
  buffer.writeUInt32BE(24, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write('isom', 8, 'ascii');
  buffer.writeUInt32BE(0x200, 12);
  buffer.write('isom', 16, 'ascii');
  buffer.write('mp42', 20, 'ascii');
  return buffer;
}

function validationResult() {
  return {
    mediaType: 'video/mp4',
    container: 'mp4',
    videoCodec: 'avc',
    audioCodec: null,
    playbackStrategy: 'native',
    sha256: 'a'.repeat(64),
    durationSeconds: 1,
    width: 64,
    height: 64,
    frameRate: 4,
    warningCount: 0,
    summary: { version: 1, validator: 'test' }
  };
}

test('动态解码阈值给短片最少容忍量，并限制长片的总错误绝对量', () => {
  assert.deepEqual(decodeErrorRate(1, { rate: 0.001, absolute: 30 }), {
    allowed: 1,
    rate: 1
  });
  assert.deepEqual(decodeErrorRate(100, { rate: 0.001, absolute: 30 }), {
    allowed: 3,
    rate: 0.03
  });
  assert.deepEqual(decodeErrorRate(10_000, { rate: 0.001, absolute: 30 }), {
    allowed: 10,
    rate: 0.001
  });
  assert.deepEqual(decodeErrorRate(100_000, { rate: 0.001, absolute: 30 }), {
    allowed: 30,
    rate: 0.0003
  });
});

test('FFmpeg progress 只采用最后一个进度快照', () => {
  const progress = parseProgress([
    'frame=4',
    'out_time_us=500000',
    'drop_frames=0',
    'progress=continue',
    'frame=8',
    'out_time_us=1000000',
    'drop_frames=1',
    'progress=end'
  ].join('\n'));
  assert.deepEqual(progress, {
    frameCount: 8,
    outTimeSeconds: 1,
    droppedFrames: 1,
    ended: true
  });
});

test('真实极小 H.264 MP4 能通过完整探测与解码', {
  skip: mediaToolsAvailable ? false : '系统没有 ffmpeg/ffprobe',
  timeout: 30_000
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-validator-real-'));
  const mediaPath = path.join(directory, 'tiny.mp4');
  try {
    await execFileAsync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=4:d=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-an', '-movflags', '+faststart', '-y', mediaPath
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });

    const result = await validateMediaFile(mediaPath, 'video/mp4', loadConfig({
      FFPROBE_PATH: 'ffprobe',
      FFMPEG_PATH: 'ffmpeg',
      MAX_VIDEO_DURATION_SECONDS: '60',
      MEDIA_VALIDATION_THREADS: '1'
    }, directory));

    assert.equal(result.container, 'mp4');
    assert.equal(result.videoCodec, 'avc');
    assert.equal(result.audioCodec, null);
    assert.equal(result.playbackStrategy, 'native');
    assert.equal(result.width, 64);
    assert.equal(result.height, 64);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.summary.video.decodedFrames >= 1);
    assert.ok(result.summary.video.coveredSeconds >= 0.9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('只有合法 ftyp 文件头、主体为垃圾的伪 MP4 会被完整探测拒绝', {
  skip: mediaToolsAvailable ? false : '系统没有 ffprobe',
  timeout: 10_000
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-validator-fake-'));
  const mediaPath = path.join(directory, 'fake.mp4');
  try {
    await writeFile(mediaPath, fakeFtypFile());
    const config = loadConfig({ FFPROBE_PATH: 'ffprobe' }, directory);
    await assert.rejects(
      () => probeCanonicalMedia(mediaPath, 'video/mp4', config),
      (error) => error instanceof MediaRejectedError && error.code === 'INVALID_MEDIA_STRUCTURE'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('服务端会拒绝绕过浏览器直接提交的旋转 WebM', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-validator-rotation-'));
  const rotatedPath = path.join(directory, 'rotated.webm');
  const probePath = path.join(directory, 'ffprobe-fixture');
  try {
    await writeFile(rotatedPath, Buffer.alloc(32, 0x1a));
    await writeFile(probePath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  format: { format_name: 'matroska,webm', duration: '1', size: '32', nb_streams: 1 },
  streams: [{
    index: 0, codec_name: 'vp9', codec_type: 'video', width: 64, height: 64,
    avg_frame_rate: '4/1', nb_read_packets: '4', tags: { rotate: '90' }
  }]
}));
`);
    await chmod(probePath, 0o700);

    await assert.rejects(
      () => probeCanonicalMedia(rotatedPath, 'video/webm', loadConfig({ FFPROBE_PATH: probePath }, directory)),
      (error) => error instanceof MediaRejectedError && error.code === 'UNSUPPORTED_ROTATION_METADATA'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker 验证成功后原子提升待验证文件并提交 ready 结果', async (t) => {
  t.mock.method(console, 'log', () => {});
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-validator-worker-ready-'));
  const pendingStoragePath = path.join(directory, 'pending');
  const videoStoragePath = path.join(directory, 'videos');
  const storageName = 'ready.mp4';
  await mkdir(pendingStoragePath);
  await mkdir(videoStoragePath);
  await writeFile(path.join(pendingStoragePath, storageName), Buffer.from('media'));

  let completed;
  const database = {
    claimNextVideoForValidation: () => ({ id: 'video-ready', storageName, mediaType: 'video/mp4' }),
    completeVideoValidation: (id, result, validatedAt) => {
      completed = { id, result, validatedAt };
      return 1;
    },
    rejectVideoValidation: () => assert.fail('不应拒绝有效任务'),
    failVideoValidation: () => assert.fail('不应把有效任务标为系统失败')
  };

  try {
    assert.equal(await processNextValidation(database, { pendingStoragePath, videoStoragePath }, {
      validate: async () => validationResult(),
      now: () => new Date('2026-08-22T12:00:00.000Z')
    }), true);
    assert.equal(await pathExists(path.join(pendingStoragePath, storageName)), false);
    assert.deepEqual(await readFile(path.join(videoStoragePath, storageName)), Buffer.from('media'));
    assert.equal(completed.id, 'video-ready');
    assert.equal(completed.result.videoCodec, 'avc');
    assert.equal(completed.validatedAt, '2026-08-22T12:00:00.000Z');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker 区分内容拒绝与可重试的验证系统故障', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-validator-worker-errors-'));
  const pendingStoragePath = path.join(directory, 'pending');
  const videoStoragePath = path.join(directory, 'videos');
  await mkdir(pendingStoragePath);
  await mkdir(videoStoragePath);

  let rejected;
  let failed;
  const makeDatabase = (id, storageName) => ({
    claimNextVideoForValidation: () => ({ id, storageName, mediaType: 'video/mp4' }),
    completeVideoValidation: () => assert.fail('失败任务不应提交 ready'),
    rejectVideoValidation: (videoId, summary) => {
      rejected = { videoId, summary };
      return 1;
    },
    failVideoValidation: (videoId, summary) => { failed = { videoId, summary }; }
  });

  try {
    await writeFile(path.join(pendingStoragePath, 'rejected.mp4'), Buffer.from('bad'));
    await processNextValidation(
      makeDatabase('video-rejected', 'rejected.mp4'),
      { pendingStoragePath, videoStoragePath },
      { validate: async () => { throw new MediaRejectedError('无法解码', 'DECODE_UNRECOVERABLE'); } }
    );
    assert.equal(rejected.videoId, 'video-rejected');
    assert.equal(rejected.summary.code, 'DECODE_UNRECOVERABLE');
    assert.equal(await pathExists(path.join(pendingStoragePath, 'rejected.mp4')), false);

    await writeFile(path.join(pendingStoragePath, 'retry.mp4'), Buffer.from('retry'));
    await processNextValidation(
      makeDatabase('video-retry', 'retry.mp4'),
      { pendingStoragePath, videoStoragePath },
      { validate: async () => { throw new MediaValidationSystemError('资源不足', 'DECODE_RESOURCE_FAILURE'); } }
    );
    assert.equal(failed.videoId, 'video-retry');
    assert.equal(failed.summary.code, 'DECODE_RESOURCE_FAILURE');
    assert.equal(await pathExists(path.join(pendingStoragePath, 'retry.mp4')), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker 在常驻轮询中会再次回收超时 validating 任务', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-validator-worker-stale-'));
  const staleCutoffs = [];
  let nowCalls = 0;
  let closed = false;
  const database = {
    resetStaleValidations: (cutoff) => {
      staleCutoffs.push(cutoff);
      return 0;
    },
    retryFailedValidations: () => 0,
    claimNextVideoForValidation: () => null,
    close: () => { closed = true; }
  };
  const config = {
    videoStoragePath: path.join(directory, 'videos'),
    pendingStoragePath: path.join(directory, 'videos', '.pending'),
    temporaryStoragePath: path.join(directory, 'videos', '.tmp'),
    mediaValidationStaleMs: 60_000,
    mediaValidationPollMs: 100
  };

  try {
    await runValidatorWorker({
      config,
      database,
      once: true,
      now: () => new Date(Date.parse('2026-08-22T12:00:00.000Z') + nowCalls++ * 2_000)
    });
    assert.equal(staleCutoffs.length, 2);
    assert.equal(staleCutoffs[0], '2026-08-22T11:59:00.000Z');
    assert.equal(staleCutoffs[1], '2026-08-22T11:59:02.000Z');
    assert.equal(closed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
