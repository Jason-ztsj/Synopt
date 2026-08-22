import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MediaPolicyError,
  mediaTypeForContainer,
  selectMediaPlan
} from '../../public/js/media-policy.js';

test('媒体策略将 H.264/AAC 规范为 MP4，将 VP9/AV1/Opus 规范为 WebM', () => {
  const mov = selectMediaPlan({ container: 'mov', videoCodec: 'avc', audioCodec: 'aac' });
  assert.equal(mov.container, 'mp4');
  assert.equal(mov.mediaType, 'video/mp4');
  assert.equal(mov.remuxRequired, true);
  assert.equal(mov.playbackStrategy, 'native');

  const webm = selectMediaPlan({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' });
  assert.equal(webm.container, 'webm');
  assert.equal(webm.remuxRequired, false);

  const av1InMkv = selectMediaPlan({ container: 'mkv', videoCodec: 'av1', audioCodec: 'opus' });
  assert.equal(av1InMkv.container, 'webm');
  assert.equal(av1InMkv.remuxRequired, true);
  assert.equal(mediaTypeForContainer(av1InMkv.container), 'video/webm');
});

test('媒体策略允许无音频视频，并把 HEVC 明确标记为原生实验路径', () => {
  const silent = selectMediaPlan({
    container: 'mp4',
    videoCodec: 'avc',
    audioTrackCount: 0
  });
  assert.equal(silent.audioCodec, null);

  const hevc = selectMediaPlan({ container: 'mov', videoCodec: 'hevc', audioCodec: 'aac' });
  assert.equal(hevc.container, 'mp4');
  assert.equal(hevc.playbackStrategy, 'native-hevc');
  assert.equal(hevc.experimental, true);
});

test('媒体策略拒绝不兼容编码组合、多轨和额外轨道', () => {
  const cases = [
    [{ container: 'avi', videoCodec: 'avc', audioCodec: 'aac' }, 'UNSUPPORTED_CONTAINER'],
    [{ container: 'mp4', videoCodec: 'mpeg2', audioCodec: 'aac' }, 'UNSUPPORTED_VIDEO_CODEC'],
    [{ container: 'mp4', videoCodec: 'avc', audioCodec: 'opus' }, 'UNSUPPORTED_AUDIO_CODEC'],
    [{ container: 'webm', videoCodec: 'vp9', audioCodec: 'aac' }, 'UNSUPPORTED_AUDIO_CODEC'],
    [{ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', videoTrackCount: 2 }, 'UNSUPPORTED_VIDEO_TRACK_COUNT'],
    [{ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', audioTrackCount: 0 }, 'INCONSISTENT_AUDIO_TRACK'],
    [{ container: 'mp4', videoCodec: 'avc', audioTrackCount: 1 }, 'UNKNOWN_AUDIO_CODEC'],
    [{ container: 'mp4', videoCodec: 'avc', audioTrackCount: 0.5 }, 'UNSUPPORTED_AUDIO_TRACK_COUNT'],
    [{ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', otherTrackCount: 1 }, 'UNSUPPORTED_EXTRA_TRACKS'],
    [{ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', rotation: 90 }, 'UNSUPPORTED_ROTATION_METADATA'],
    [{ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', rotation: 45 }, 'INVALID_ROTATION']
  ];

  for (const [input, code] of cases) {
    assert.throws(() => selectMediaPlan(input), (error) => (
      error instanceof MediaPolicyError && error.code === code
    ));
  }
});

test('MP4 保留标准旋转元数据，返回策略为只读对象', () => {
  const plan = selectMediaPlan({
    container: 'mov',
    videoCodec: 'avc',
    audioCodec: 'aac',
    rotation: 270
  });

  assert.equal(plan.container, 'mp4');
  assert.equal(plan.remuxRequired, true);
  assert.equal(Object.isFrozen(plan), true);
});
