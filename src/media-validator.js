import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import { selectMediaPlan } from '../public/js/media-policy.js';

const PROBE_STDOUT_LIMIT = 1024 * 1024;
const LOG_LIMIT = 256 * 1024;
const MAX_PROCESS_SECONDS = 3 * 60 * 60;

export class MediaRejectedError extends Error {
  constructor(message, code, summary = {}) {
    super(message);
    this.name = 'MediaRejectedError';
    this.code = code;
    this.summary = { code, message, ...summary };
    this.retryable = false;
  }
}

export class MediaValidationSystemError extends Error {
  constructor(message, code, summary = {}) {
    super(message);
    this.name = 'MediaValidationSystemError';
    this.code = code;
    this.summary = { code, message, ...summary };
    this.retryable = true;
  }
}

function boundedAppend(current, chunk, limit) {
  if (current.length >= limit) return { value: current, overflow: true };
  const remaining = limit - current.length;
  return {
    value: current + chunk.toString('utf8', 0, remaining),
    overflow: chunk.length > remaining
  };
}

export function runBoundedProcess(command, args, {
  timeoutMs,
  maxStdoutBytes = PROBE_STDOUT_LIMIT,
  maxStderrBytes = LOG_LIMIT,
  env = process.env
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: env.PATH,
          LANG: 'C',
          LC_ALL: 'C',
          AV_LOG_FORCE_NOCOLOR: '1'
        }
      });
    } catch (error) {
      reject(new MediaValidationSystemError('无法启动媒体验证器', 'VALIDATOR_SPAWN_FAILED', {
        cause: error.message
      }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5000).unref();
    }, Math.max(1000, timeoutMs ?? 60_000));
    timer.unref();

    child.stdout.on('data', (chunk) => {
      const appended = boundedAppend(stdout, chunk, maxStdoutBytes);
      stdout = appended.value;
      stdoutOverflow ||= appended.overflow;
      if (stdoutOverflow) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      const appended = boundedAppend(stderr, chunk, maxStderrBytes);
      stderr = appended.value;
      stderrOverflow ||= appended.overflow;
      if (stderrOverflow) child.kill('SIGTERM');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      settled = true;
      reject(new MediaValidationSystemError('媒体验证器无法执行', 'VALIDATOR_EXEC_FAILED', {
        cause: error.message
      }));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ code, signal, stdout, stderr, stdoutOverflow, stderrOverflow, timedOut });
    });
  });
}

function parseRational(value) {
  if (typeof value !== 'string') return null;
  const match = /^(-?\d+)\/(-?\d+)$/.exec(value);
  if (!match) return Number.isFinite(Number(value)) ? Number(value) : null;
  const denominator = Number(match[2]);
  if (denominator === 0) return null;
  const result = Number(match[1]) / denominator;
  return Number.isFinite(result) ? result : null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function containerFromProbe(formatName, expectedMediaType) {
  const formats = String(formatName || '').split(',');
  if (expectedMediaType === 'video/mp4' && formats.some((entry) => ['mov', 'mp4'].includes(entry))) return 'mp4';
  if (expectedMediaType === 'video/webm' && formats.includes('webm')) return 'webm';
  return null;
}

function policyCodec(codecName) {
  return ({ h264: 'avc', hevc: 'hevc', vp9: 'vp9', av1: 'av1', aac: 'aac', opus: 'opus' })[codecName] ?? null;
}

function rotationFromStream(stream) {
  const sideData = Array.isArray(stream?.side_data_list)
    ? stream.side_data_list.find((entry) => entry?.rotation !== undefined)
    : null;
  const raw = sideData?.rotation ?? stream?.tags?.rotate ?? stream?.tags?.ROTATE ?? 0;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;
  const normalized = ((numeric % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function ensurePolicyLimits(metadata, config) {
  if (metadata.durationSeconds > config.maxVideoDurationSeconds) {
    throw new MediaRejectedError(
      `视频时长超过 ${config.maxVideoDurationSeconds} 秒上限`,
      'DURATION_LIMIT_EXCEEDED'
    );
  }
  if (
    metadata.width > config.maxVideoWidth
    || metadata.height > config.maxVideoHeight
    || metadata.width * metadata.height > config.maxVideoPixels
  ) {
    throw new MediaRejectedError('视频分辨率超过当前实验限制', 'RESOLUTION_LIMIT_EXCEEDED');
  }
  if (!metadata.frameRate || metadata.frameRate > config.maxVideoFps) {
    throw new MediaRejectedError('视频帧率无效或超过当前实验限制', 'FRAME_RATE_LIMIT_EXCEEDED');
  }
}

async function validateTopLevelMp4(filePath, fileSize) {
  const handle = await open(filePath, 'r');
  const types = new Set();
  try {
    let position = 0;
    let boxes = 0;
    while (position < fileSize) {
      if (++boxes > 100_000) throw new MediaRejectedError('MP4 顶层 box 数量异常', 'INVALID_MP4_STRUCTURE');
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, position);
      if (bytesRead < 8) throw new MediaRejectedError('MP4 尾部存在不完整 box', 'TRUNCATED_MP4');
      const size32 = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      let boxSize;
      let headerSize = 8;
      if (size32 === 1) {
        if (bytesRead < 16) throw new MediaRejectedError('MP4 扩展尺寸 box 不完整', 'TRUNCATED_MP4');
        const extended = header.readBigUInt64BE(8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new MediaRejectedError('MP4 box 尺寸超出安全范围', 'INVALID_MP4_STRUCTURE');
        }
        boxSize = Number(extended);
        headerSize = 16;
      } else if (size32 === 0) {
        boxSize = fileSize - position;
      } else {
        boxSize = size32;
      }
      if (boxSize < headerSize || position + boxSize > fileSize) {
        throw new MediaRejectedError('MP4 box 尺寸越界', 'INVALID_MP4_STRUCTURE');
      }
      types.add(type);
      position += boxSize;
    }
    if (position !== fileSize || !types.has('ftyp') || !types.has('moov') || !types.has('mdat')) {
      throw new MediaRejectedError('MP4 缺少 ftyp、moov 或 mdat 必需结构', 'INVALID_MP4_STRUCTURE');
    }
  } finally {
    await handle.close();
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function sanitizeWarnings(stderr, filePath) {
  const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutPath = String(stderr || '').replace(new RegExp(escapedPath, 'g'), '[media]');
  return withoutPath
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((line) => line.slice(0, 500));
}

function filterKnownParserNoise(warnings, metadata) {
  if (metadata.container !== 'webm' || metadata.audioCodec !== 'opus') return warnings;
  // FFmpeg 8 emits one Opus parser error while draining otherwise-valid WebM
  // streams, including files produced by its own WebM muxer. Ignore only the
  // first exact occurrence per pass; additional occurrences still surface as
  // recoverable-damage warnings and remain subject to -max_error_rate.
  const index = warnings.findIndex((line) => /\[opus @ [^\]]+\] \[error\] Error parsing Opus packet header\.$/.test(line));
  return index < 0 ? warnings : warnings.toSpliced(index, 1);
}

function parseProgress(stdout) {
  const values = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return {
    frameCount: positiveInteger(values.frame) ?? 0,
    outTimeSeconds: positiveNumber(values.out_time_us) ? Number(values.out_time_us) / 1_000_000 : 0,
    droppedFrames: Number.isFinite(Number(values.drop_frames)) ? Number(values.drop_frames) : 0,
    ended: values.progress === 'end'
  };
}

function decodeErrorRate(packetCount, cap) {
  const packets = Math.max(1, packetCount);
  const allowed = Math.min(packets, Math.max(3, Math.min(Math.ceil(packets * cap.rate), cap.absolute)));
  return { allowed, rate: Math.min(1, allowed / packets) };
}

async function decodeTrack(filePath, stream, metadata, config) {
  const isVideo = stream.codec_type === 'video';
  const packetCount = positiveInteger(stream.nb_read_packets) ?? positiveInteger(stream.nb_frames) ?? 1;
  const averagePacketDuration = metadata.durationSeconds / packetCount;
  const threshold = decodeErrorRate(packetCount, {
    rate: config.mediaDecodeErrorRate,
    absolute: isVideo
      ? Math.max(1, Math.ceil(metadata.frameRate))
      : Math.max(1, Math.ceil(0.5 / Math.max(averagePacketDuration, 0.000001)))
  });
  const multiplier = ['hevc', 'av1'].includes(metadata.videoCodec) ? 4 : 2;
  const minimum = ['hevc', 'av1'].includes(metadata.videoCodec) ? 90 : 60;
  const timeoutSeconds = Math.min(MAX_PROCESS_SECONDS, Math.max(minimum, metadata.durationSeconds * multiplier));
  const map = isVideo ? '0:v:0' : '0:a:0';
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'repeat+level+warning',
    '-max_alloc', '268435456', '-protocol_whitelist', 'file,pipe',
    '-threads', String(config.mediaValidationThreads),
    '-err_detect', 'crccheck+bitstream+buffer+careful',
    '-i', filePath,
    '-map', map,
    ...(isVideo ? ['-an', '-sn', '-dn', '-fps_mode', 'passthrough'] : ['-vn', '-sn', '-dn']),
    '-abort_on', 'empty_output_stream',
    '-max_error_rate', String(threshold.rate),
    '-progress', 'pipe:1', '-stats_period', '2', '-nostats',
    '-f', 'null', '-'
  ];
  const result = await runBoundedProcess(config.ffmpegPath, args, {
    timeoutMs: Math.ceil(timeoutSeconds * 1000),
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: LOG_LIMIT
  });
  if (result.timedOut || result.signal || [126, 127, 137].includes(result.code)) {
    throw new MediaValidationSystemError('完整解码验证超时或被系统终止', 'DECODE_RESOURCE_FAILURE', {
      stream: isVideo ? 'video' : 'audio', signal: result.signal, exitCode: result.code
    });
  }
  if (result.stdoutOverflow || result.stderrOverflow) {
    throw new MediaRejectedError('媒体在解码时产生异常数量的输出', 'DECODE_OUTPUT_LIMIT');
  }
  if (result.code === 69) {
    throw new MediaRejectedError('媒体损坏比例超过允许范围', 'DECODE_ERROR_RATE_EXCEEDED', {
      stream: isVideo ? 'video' : 'audio', allowedErrors: threshold.allowed, packetCount
    });
  }
  if (result.code !== 0) {
    throw new MediaRejectedError('媒体无法完整解码', 'DECODE_UNRECOVERABLE', {
      stream: isVideo ? 'video' : 'audio', exitCode: result.code,
      warnings: sanitizeWarnings(result.stderr, filePath)
    });
  }

  const progress = parseProgress(result.stdout);
  const expectedDuration = positiveNumber(stream.duration) ?? metadata.durationSeconds;
  const coverageTolerance = Math.max(1, expectedDuration * 0.01);
  if (!progress.ended || progress.outTimeSeconds < expectedDuration - coverageTolerance) {
    throw new MediaRejectedError('解码没有覆盖到媒体结尾', 'INCOMPLETE_DECODE_COVERAGE', {
      stream: isVideo ? 'video' : 'audio', outTimeSeconds: progress.outTimeSeconds, expectedDuration
    });
  }
  if (isVideo && progress.frameCount < 1) {
    throw new MediaRejectedError('视频轨没有产生可解码画面', 'EMPTY_VIDEO_OUTPUT');
  }
  const warnings = filterKnownParserNoise(sanitizeWarnings(result.stderr, filePath), metadata);
  return { warnings, progress, allowedErrors: threshold.allowed, packetCount };
}

export async function probeCanonicalMedia(filePath, expectedMediaType, config) {
  const before = await stat(filePath);
  if (!before.isFile() || before.size < 16) {
    throw new MediaRejectedError('上传内容不是有效的常规媒体文件', 'INVALID_FILE');
  }
  const probeTimeout = Math.min(120, 15 + before.size / (1024 * 1024)) * 1000;
  const entries = [
    'format=format_name,start_time,duration,size,bit_rate,probe_score,nb_streams',
    'stream=index,codec_name,codec_type,codec_tag_string,profile,level,width,height,pix_fmt,r_frame_rate,avg_frame_rate,time_base,start_time,duration,bit_rate,nb_frames,nb_read_packets,sample_rate,channels,channel_layout,extradata_size',
    'stream_disposition=attached_pic',
    'stream_tags=rotate',
    'stream_side_data=rotation'
  ].join(':');
  const result = await runBoundedProcess(config.ffprobePath, [
    '-v', 'error', '-show_error', '-count_packets', '-show_entries', entries,
    '-of', 'json', '-protocol_whitelist', 'file', '-probesize', '64M',
    '-analyzeduration', '30M', '-i', filePath
  ], { timeoutMs: probeTimeout });
  if (result.timedOut || result.signal || [126, 127, 137].includes(result.code)) {
    throw new MediaValidationSystemError('媒体结构探测超时或被系统终止', 'PROBE_RESOURCE_FAILURE');
  }
  if (result.stdoutOverflow || result.stderrOverflow) {
    throw new MediaRejectedError('媒体结构信息异常庞大', 'PROBE_OUTPUT_LIMIT');
  }
  if (result.code !== 0) {
    throw new MediaRejectedError('无法解析完整媒体结构', 'INVALID_MEDIA_STRUCTURE', {
      warnings: sanitizeWarnings(result.stderr, filePath)
    });
  }

  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch {
    throw new MediaValidationSystemError('ffprobe 返回了无法解析的结果', 'INVALID_PROBE_RESULT');
  }
  if (probe.error) throw new MediaRejectedError('媒体解析器报告结构错误', 'INVALID_MEDIA_STRUCTURE');
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStreams = streams.filter((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  const otherStreams = streams.filter((stream) => (
    !['video', 'audio'].includes(stream.codec_type) || stream.disposition?.attached_pic
  ));
  const container = containerFromProbe(probe.format?.format_name, expectedMediaType);
  const videoStream = videoStreams[0];
  const audioStream = audioStreams[0] ?? null;
  const videoCodec = policyCodec(videoStream?.codec_name);
  const audioCodec = audioStream ? policyCodec(audioStream.codec_name) : null;
  const rotation = rotationFromStream(videoStream);
  let plan;
  try {
    plan = selectMediaPlan({
      container,
      videoCodec,
      audioCodec,
      videoTrackCount: videoStreams.length,
      audioTrackCount: audioStreams.length,
      otherTrackCount: otherStreams.length,
      rotation
    });
  } catch (error) {
    throw new MediaRejectedError(error.message, error.code || 'UNSUPPORTED_MEDIA');
  }
  if (plan.mediaType !== expectedMediaType) {
    throw new MediaRejectedError('媒体真实容器与上传类型不一致', 'CONTAINER_MISMATCH');
  }
  for (const stream of [videoStream, audioStream].filter(Boolean)) {
    if (!positiveInteger(stream.nb_read_packets)) {
      throw new MediaRejectedError('媒体轨道没有可读取的数据包', 'EMPTY_MEDIA_TRACK');
    }
  }
  const metadata = {
    container,
    mediaType: plan.mediaType,
    videoCodec,
    audioCodec,
    playbackStrategy: plan.playbackStrategy,
    durationSeconds: positiveNumber(probe.format?.duration) ?? positiveNumber(videoStream.duration),
    width: positiveInteger(videoStream.width),
    height: positiveInteger(videoStream.height),
    frameRate: parseRational(videoStream.avg_frame_rate) ?? parseRational(videoStream.r_frame_rate),
    rotation,
    streams: { video: videoStream, audio: audioStream },
    fileSize: before.size
  };
  if (!metadata.durationSeconds || !metadata.width || !metadata.height) {
    throw new MediaRejectedError('媒体缺少有效的时长或画面尺寸', 'INCOMPLETE_MEDIA_METADATA');
  }
  ensurePolicyLimits(metadata, config);
  if (container === 'mp4') await validateTopLevelMp4(filePath, before.size);
  const after = await stat(filePath);
  if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new MediaValidationSystemError('媒体文件在验证期间发生变化', 'MEDIA_CHANGED_DURING_VALIDATION');
  }
  return metadata;
}

export async function validateMediaFile(filePath, expectedMediaType, config) {
  const metadata = await probeCanonicalMedia(filePath, expectedMediaType, config);
  const sha256 = await sha256File(filePath);
  const videoResult = await decodeTrack(filePath, metadata.streams.video, metadata, config);
  const audioResult = metadata.streams.audio
    ? await decodeTrack(filePath, metadata.streams.audio, metadata, config)
    : null;
  const warnings = [...videoResult.warnings, ...(audioResult?.warnings ?? [])];
  const finalStat = await stat(filePath);
  if (!finalStat.isFile() || finalStat.size !== metadata.fileSize) {
    throw new MediaValidationSystemError('媒体文件在完整解码期间发生变化', 'MEDIA_CHANGED_DURING_VALIDATION');
  }
  return {
    mediaType: metadata.mediaType,
    container: metadata.container,
    videoCodec: metadata.videoCodec,
    audioCodec: metadata.audioCodec,
    playbackStrategy: metadata.playbackStrategy,
    sha256,
    durationSeconds: metadata.durationSeconds,
    width: metadata.width,
    height: metadata.height,
    frameRate: metadata.frameRate,
    warningCount: warnings.length,
    summary: {
      version: 1,
      validator: 'ffprobe+ffmpeg',
      warnings,
      video: {
        packets: videoResult.packetCount,
        allowedDecodeErrors: videoResult.allowedErrors,
        decodedFrames: videoResult.progress.frameCount,
        coveredSeconds: videoResult.progress.outTimeSeconds
      },
      audio: audioResult ? {
        packets: audioResult.packetCount,
        allowedDecodeErrors: audioResult.allowedErrors,
        coveredSeconds: audioResult.progress.outTimeSeconds
      } : null
    }
  };
}

export { decodeErrorRate, parseProgress };
