import {
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  WEBM,
  WebMOutputFormat
} from '/assets/mediabunny/mediabunny.min.mjs';

import { selectMediaPlan } from './media-policy.js';

const INPUT_FORMATS = Object.freeze([MP4, QTFF, MATROSKA, WEBM]);
const TIMESTAMP_EPSILON_SECONDS = 1e-7;
const jobs = new Map();

class MediaJobCanceledError extends Error {
  constructor() {
    super('媒体处理已取消。');
    this.name = 'AbortError';
    this.code = 'MEDIA_JOB_CANCELED';
  }
}

function cancelOutput(output) {
  if (!output || ['canceled', 'finalizing', 'finalized'].includes(output.state)) return Promise.resolve();
  return output.cancel().catch(() => {});
}

function createJob() {
  return {
    canceled: false,
    input: null,
    output: null,
    ensureActive() {
      if (this.canceled) throw new MediaJobCanceledError();
    },
    cancel() {
      if (this.canceled) return;
      this.canceled = true;
      this.input?.dispose();
      void cancelOutput(this.output);
    }
  };
}

function sourceContainer(format) {
  if (format === MP4) return 'mp4';
  if (format === QTFF) return 'mov';
  if (format === WEBM) return 'webm';
  if (format === MATROSKA) return 'mkv';
  return null;
}

function outputFormatForPlan(plan) {
  if (plan.container === 'mp4') return new Mp4OutputFormat({ fastStart: 'in-memory' });
  if (plan.container === 'webm') return new WebMOutputFormat();
  throw new Error('媒体策略返回了未知的输出容器。');
}

function assertMuxCompatibility(format, plan, rotation) {
  if (!format.getSupportedVideoCodecs().includes(plan.videoCodec)) {
    throw new Error('目标容器不支持这条视频码流。');
  }
  if (plan.audioCodec && !format.getSupportedAudioCodecs().includes(plan.audioCodec)) {
    throw new Error('目标容器不支持这条音频码流。');
  }
  if (rotation !== 0 && !format.supportsVideoRotationMetadata) {
    throw new Error('目标容器不能保留这段视频的旋转元数据。');
  }
}

async function analyzeInput(input, job) {
  job.ensureActive();
  if (!await input.canRead()) throw new Error('无法识别这个媒体文件的容器结构。');
  job.ensureActive();

  const format = await input.getFormat();
  const tracks = await input.getTracks();
  job.ensureActive();

  const videoTracks = tracks.filter((track) => track.isVideoTrack());
  const audioTracks = tracks.filter((track) => track.isAudioTrack());
  const otherTrackCount = tracks.length - videoTracks.length - audioTracks.length;
  const videoTrack = videoTracks[0] ?? null;
  const audioTrack = audioTracks[0] ?? null;
  const container = sourceContainer(format);
  const [videoCodec, audioCodec, rotation] = await Promise.all([
    videoTrack ? videoTrack.getCodec() : null,
    audioTrack ? audioTrack.getCodec() : null,
    videoTrack ? videoTrack.getRotation() : 0
  ]);
  job.ensureActive();

  const plan = selectMediaPlan({
    container,
    videoCodec,
    audioCodec,
    videoTrackCount: videoTracks.length,
    audioTrackCount: audioTracks.length,
    otherTrackCount,
    rotation
  });
  const outputFormat = outputFormatForPlan(plan);
  assertMuxCompatibility(outputFormat, plan, rotation);

  const [
    videoCodecString,
    audioCodecString,
    width,
    height,
    duration,
    videoConfig,
    audioConfig
  ] = await Promise.all([
    videoTrack.getCodecParameterString(),
    audioTrack ? audioTrack.getCodecParameterString() : null,
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
    input.getDurationFromMetadata([videoTrack, audioTrack].filter(Boolean), { skipLiveWait: true }),
    videoTrack.getDecoderConfig(),
    audioTrack ? audioTrack.getDecoderConfig() : null
  ]);
  job.ensureActive();

  if (!videoConfig) throw new Error('视频轨缺少重封装所需的编码配置。');
  if (audioTrack && !audioConfig) throw new Error('音频轨缺少重封装所需的编码配置。');
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('视频轨没有有效的画面尺寸。');
  }

  return {
    input,
    tracks: [videoTrack, audioTrack].filter(Boolean),
    videoTrack,
    audioTrack,
    videoConfig,
    audioConfig,
    container,
    videoCodec,
    videoCodecString,
    audioCodec,
    audioCodecString,
    width,
    height,
    rotation,
    duration: Number.isFinite(duration) ? duration : null,
    videoTrackCount: videoTracks.length,
    audioTrackCount: audioTracks.length,
    otherTrackCount,
    plan
  };
}

async function openAnalyzedInput(file, job) {
  const input = new Input({ source: new BlobSource(file), formats: INPUT_FORMATS });
  job.input = input;
  try {
    job.ensureActive();
    return await analyzeInput(input, job);
  } catch (error) {
    input.dispose();
    if (job.input === input) job.input = null;
    throw error;
  }
}

async function inspectFile(file, job) {
  const analyzed = await openAnalyzedInput(file, job);
  try {
    const {
      input: _input,
      tracks: _tracks,
      videoTrack: _videoTrack,
      audioTrack: _audioTrack,
      videoConfig: _videoConfig,
      audioConfig: _audioConfig,
      ...result
    } = analyzed;
    return result;
  } finally {
    analyzed.input.dispose();
    if (job.input === analyzed.input) job.input = null;
  }
}

async function nextPacket(state, job) {
  job.ensureActive();
  const result = await state.iterator.next();
  job.ensureActive();
  state.packet = result.done ? null : result.value;
}

function validatePacket(packet) {
  if (!Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration) || packet.duration < 0) {
    throw new Error('媒体中存在非法时间戳，无法安全重封装。');
  }
  if (!Number.isSafeInteger(packet.byteLength) || packet.byteLength <= 0) {
    throw new Error('媒体中存在空的或过大的编码数据包。');
  }
}

async function remuxFile(file, expectedContainer, reportProgress, job) {
  const analyzed = await openAnalyzedInput(file, job);
  const {
    input,
    videoTrack,
    audioTrack,
    videoConfig,
    audioConfig,
    plan,
    rotation
  } = analyzed;
  let output = null;
  let states = [];

  try {
    if (plan.container !== expectedContainer) {
      throw new Error('媒体文件在处理期间发生了变化，请重新选择。');
    }

    const target = new BufferTarget();
    const format = outputFormatForPlan(plan);
    assertMuxCompatibility(format, plan, rotation);
    output = new Output({ format, target });
    job.output = output;

    const videoSource = new EncodedVideoPacketSource(plan.videoCodec);
    output.addVideoTrack(videoSource, { decoderConfig: videoConfig, rotation });

    let audioSource = null;
    if (audioTrack) {
      audioSource = new EncodedAudioPacketSource(plan.audioCodec);
      output.addAudioTrack(audioSource, { decoderConfig: audioConfig });
    }

    states = [
      {
        kind: 'video',
        source: videoSource,
        decoderConfig: videoConfig,
        iterator: new EncodedPacketSink(videoTrack).packets(
          undefined,
          undefined,
          { verifyKeyPackets: true }
        ),
        packet: null,
        packetCount: 0,
        sawKeyPacket: false
      }
    ];
    if (audioTrack) {
      states.push({
        kind: 'audio',
        source: audioSource,
        decoderConfig: audioConfig,
        iterator: new EncodedPacketSink(audioTrack).packets(),
        packet: null,
        packetCount: 0,
        sawKeyPacket: false
      });
    }

    await Promise.all(states.map((state) => nextPacket(state, job)));
    if (!states[0].packet) throw new Error('视频轨没有可读取的编码数据包。');
    if (states.some((state) => state.kind === 'audio' && !state.packet)) {
      throw new Error('音频轨没有可读取的编码数据包。');
    }

    const startTimestamp = Math.min(...states.map((state) => state.packet.timestamp));
    if (!Number.isFinite(startTimestamp)) throw new Error('媒体起始时间戳无效。');
    const progressDuration = Number.isFinite(analyzed.duration) && analyzed.duration > startTimestamp
      ? analyzed.duration - startTimestamp
      : null;

    job.ensureActive();
    await output.start();
    job.ensureActive();

    let lastReported = -1;
    while (states.some((state) => state.packet)) {
      job.ensureActive();
      let selected = null;
      for (const state of states) {
        if (!state.packet) continue;
        if (!selected || state.packet.timestamp < selected.packet.timestamp) selected = state;
      }

      const packet = selected.packet;
      validatePacket(packet);
      const normalizedTimestamp = packet.timestamp - startTimestamp;
      if (normalizedTimestamp < -TIMESTAMP_EPSILON_SECONDS) {
        throw new Error('媒体中存在无法规范化的负时间戳。');
      }
      const outputPacket = packet.clone({
        timestamp: normalizedTimestamp < 0 ? 0 : normalizedTimestamp
      });
      const metadata = selected.packetCount === 0
        ? { decoderConfig: selected.decoderConfig }
        : undefined;
      await selected.source.add(outputPacket, metadata);
      job.ensureActive();

      selected.packetCount += 1;
      selected.sawKeyPacket ||= selected.kind === 'video' && outputPacket.type === 'key';
      if (progressDuration) {
        const progress = Math.min(
          0.99,
          Math.max(0, (outputPacket.timestamp + outputPacket.duration) / progressDuration)
        );
        const percent = Math.floor(progress * 100);
        if (percent > lastReported) {
          lastReported = percent;
          reportProgress(progress);
        }
      }
      await nextPacket(selected, job);
    }

    const videoState = states.find((state) => state.kind === 'video');
    if (!videoState?.sawKeyPacket) throw new Error('视频轨中没有可验证的关键帧。');
    if (states.some((state) => state.packetCount === 0)) {
      throw new Error('媒体中存在空轨道，无法安全重封装。');
    }

    videoSource.close();
    audioSource?.close();
    await output.finalize();
    job.ensureActive();

    const buffer = target.buffer;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
      throw new Error('重封装没有生成有效输出。');
    }
    reportProgress(1);
    return { buffer, plan };
  } catch (error) {
    await cancelOutput(output);
    throw error;
  } finally {
    await Promise.allSettled(states.map((state) => state.iterator.return?.()));
    input.dispose();
    if (job.input === input) job.input = null;
    if (job.output === output) job.output = null;
  }
}

self.addEventListener('message', async (event) => {
  const { id, type, file, targetContainer } = event.data ?? {};
  if (typeof id !== 'string' || !id) return;

  if (type === 'cancel') {
    jobs.get(id)?.cancel();
    return;
  }
  if (!(file instanceof Blob)) {
    self.postMessage({
      id,
      type: 'error',
      error: '媒体处理请求缺少有效文件。',
      code: 'INVALID_MEDIA_REQUEST'
    });
    return;
  }
  if (jobs.has(id)) {
    self.postMessage({
      id,
      type: 'error',
      error: '媒体处理请求标识重复。',
      code: 'DUPLICATE_MEDIA_REQUEST'
    });
    return;
  }

  const job = createJob();
  jobs.set(id, job);
  try {
    if (type === 'probe') {
      const result = await inspectFile(file, job);
      job.ensureActive();
      self.postMessage({ id, type: 'result', result });
      return;
    }
    if (type === 'remux') {
      const result = await remuxFile(file, targetContainer, (progress) => {
        if (!job.canceled) self.postMessage({ id, type: 'progress', progress });
      }, job);
      job.ensureActive();
      self.postMessage({ id, type: 'result', result }, [result.buffer]);
      return;
    }
    throw new Error('未知的媒体处理请求。');
  } catch (error) {
    if (!job.canceled) {
      self.postMessage({
        id,
        type: 'error',
        error: error?.message || '浏览器无法处理这个媒体文件。',
        code: error?.code || 'MEDIA_PROCESSING_FAILED'
      });
    }
  } finally {
    if (jobs.get(id) === job) jobs.delete(id);
  }
});
