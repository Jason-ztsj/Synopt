export class MediaPolicyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MediaPolicyError';
    this.code = code;
  }
}

export const SUPPORTED_SOURCE_CONTAINERS = Object.freeze(['mp4', 'mov', 'mkv', 'webm']);

const PLANS = Object.freeze({
  avc: Object.freeze({
    allowedAudioCodecs: Object.freeze(['aac', 'mp3', 'opus', 'flac']),
    // AAC 在 MP4 中所有主流浏览器原生播放；mp3/opus/flac 可无损重封装进 MP4，
    // 但并非所有浏览器都原生播放，故归为 limited。
    guaranteedAudioCodecs: Object.freeze(['aac']),
    container: 'mp4',
    extension: '.mp4',
    mediaType: 'video/mp4',
    playbackStrategy: 'native',
    label: 'H.264 / AAC · MP4',
    experimental: false
  }),
  hevc: Object.freeze({
    allowedAudioCodecs: Object.freeze(['aac', 'mp3', 'opus', 'flac']),
    guaranteedAudioCodecs: Object.freeze(['aac']),
    container: 'mp4',
    extension: '.mp4',
    mediaType: 'video/mp4',
    playbackStrategy: 'native-hevc',
    label: 'HEVC / AAC · MP4',
    experimental: true
  }),
  vp8: Object.freeze({
    allowedAudioCodecs: Object.freeze(['opus']),
    guaranteedAudioCodecs: Object.freeze(['opus']),
    container: 'webm',
    extension: '.webm',
    mediaType: 'video/webm',
    playbackStrategy: 'native',
    label: 'VP8 / Opus · WebM',
    experimental: false
  }),
  vp9: Object.freeze({
    allowedAudioCodecs: Object.freeze(['opus']),
    guaranteedAudioCodecs: Object.freeze(['opus']),
    container: 'webm',
    extension: '.webm',
    mediaType: 'video/webm',
    playbackStrategy: 'native',
    label: 'VP9 / Opus · WebM',
    experimental: false
  }),
  av1: Object.freeze({
    allowedAudioCodecs: Object.freeze(['opus']),
    guaranteedAudioCodecs: Object.freeze(['opus']),
    container: 'webm',
    extension: '.webm',
    mediaType: 'video/webm',
    playbackStrategy: 'native',
    label: 'AV1 / Opus · WebM',
    experimental: false
  })
});

function readableCodec(codec) {
  return ({ avc: 'H.264', hevc: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', aac: 'AAC', opus: 'Opus', mp3: 'MP3', flac: 'FLAC' })[codec]
    ?? String(codec || '未知编码');
}

export function selectMediaPlan({
  container,
  videoCodec,
  audioCodec = null,
  videoTrackCount = 1,
  audioTrackCount = audioCodec ? 1 : 0,
  otherTrackCount = 0,
  rotation = 0
} = {}) {
  if (!SUPPORTED_SOURCE_CONTAINERS.includes(container)) {
    throw new MediaPolicyError('目前只接受 MP4、MOV、MKV 和 WebM 容器。', 'UNSUPPORTED_CONTAINER');
  }
  if (!Number.isInteger(videoTrackCount) || videoTrackCount !== 1) {
    throw new MediaPolicyError('首期只支持恰好一条视频轨。', 'UNSUPPORTED_VIDEO_TRACK_COUNT');
  }
  if (!Number.isInteger(audioTrackCount) || audioTrackCount < 0 || audioTrackCount > 1) {
    throw new MediaPolicyError('首期最多支持一条音频轨。', 'UNSUPPORTED_AUDIO_TRACK_COUNT');
  }
  if (!Number.isInteger(otherTrackCount) || otherTrackCount !== 0) {
    throw new MediaPolicyError('首期暂不保留字幕、附件或数据轨，请先移除后上传。', 'UNSUPPORTED_EXTRA_TRACKS');
  }
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new MediaPolicyError('视频的旋转元数据无法安全解析。', 'INVALID_ROTATION');
  }

  const plan = PLANS[videoCodec];
  if (!plan) {
    throw new MediaPolicyError(
      `暂不支持 ${readableCodec(videoCodec)} 视频编码；建议转换为 H.264、VP9 或 AV1。`,
      'UNSUPPORTED_VIDEO_CODEC'
    );
  }

  if (audioTrackCount === 0 && audioCodec !== null) {
    throw new MediaPolicyError('音频轨数与编码信息不一致。', 'INCONSISTENT_AUDIO_TRACK');
  }
  if (audioTrackCount === 1 && (typeof audioCodec !== 'string' || !audioCodec)) {
    throw new MediaPolicyError('无法识别音频编码，请移除音轨或转换后再试。', 'UNKNOWN_AUDIO_CODEC');
  }
  if (audioCodec && !plan.allowedAudioCodecs.includes(audioCodec)) {
    const expected = plan.allowedAudioCodecs.map(readableCodec).join(' 或 ');
    const suggested = plan.guaranteedAudioCodecs.length
      ? readableCodec(plan.guaranteedAudioCodecs[0])
      : '兼容编码';
    throw new MediaPolicyError(
      `${readableCodec(videoCodec)} 视频目前只支持搭配 ${expected} 音频；检测到 ${readableCodec(audioCodec)}。请先在本地把音轨转成 ${suggested} 再上传。`,
      'UNSUPPORTED_AUDIO_CODEC'
    );
  }
  if (rotation !== 0 && plan.container === 'webm') {
    throw new MediaPolicyError(
      '当前 WebM 发布格式不能可靠保留旋转元数据，请先将画面旋转到正确方向。',
      'UNSUPPORTED_ROTATION_METADATA'
    );
  }

  const audioLimited = Boolean(audioCodec) && !plan.guaranteedAudioCodecs.includes(audioCodec);
  const compatibility = (plan.experimental || audioLimited) ? 'limited' : 'guaranteed';
  return Object.freeze({
    ...plan,
    videoCodec,
    audioCodec,
    compatibility,
    remuxRequired: container !== plan.container
  });
}

export function mediaTypeForContainer(container) {
  if (container === 'mp4') return 'video/mp4';
  if (container === 'webm') return 'video/webm';
  return null;
}
