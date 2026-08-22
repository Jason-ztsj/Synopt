import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('../../', import.meta.url);
const workerUrl = new URL('public/js/media-worker.js', projectRoot);
const uploadUrl = new URL('public/js/media-upload.js', projectRoot);
const policyUrl = new URL('public/js/media-policy.js', projectRoot);
const browserBundleUrl = new URL(
  'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs',
  projectRoot
);

test('媒体浏览器模块通过 Node 语法检查，上传模块可在无 DOM 时安全加载', async () => {
  for (const url of [workerUrl, uploadUrl, policyUrl]) {
    await execFileAsync(process.execPath, ['--check', url.pathname]);
  }

  await import(`${uploadUrl.href}?node-static-check=${Date.now()}`);
});

test('Mediabunny 1.55.2 浏览器 bundle 提供严格 packet-copy 所需 API', async () => {
  const media = await import(browserBundleUrl.href);
  for (const name of [
    'BlobSource',
    'BufferTarget',
    'EncodedAudioPacketSource',
    'EncodedPacketSink',
    'EncodedVideoPacketSource',
    'Input',
    'Mp4OutputFormat',
    'Output',
    'WebMOutputFormat'
  ]) {
    assert.equal(typeof media[name], 'function', `${name} must be exported`);
  }

  const mp4 = new media.Mp4OutputFormat({ fastStart: 'in-memory' });
  const webm = new media.WebMOutputFormat();
  assert.equal(mp4.supportsVideoRotationMetadata, true);
  assert.equal(webm.supportsVideoRotationMetadata, false);
  assert.equal(mp4.getSupportedVideoCodecs().includes('avc'), true);
  assert.equal(webm.getSupportedVideoCodecs().includes('vp9'), true);
  assert.equal(webm.getSupportedVideoCodecs().includes('av1'), true);
  assert.equal(webm.getSupportedAudioCodecs().includes('opus'), true);

  const original = new media.EncodedPacket(new Uint8Array([1, 2, 3]), 'key', -0.25, 0.04, 7);
  const shifted = original.clone({ timestamp: 0 });
  assert.equal(shifted.timestamp, 0);
  assert.equal(shifted.sequenceNumber, original.sequenceNumber);
  assert.deepEqual(shifted.data, original.data);
});

test('Worker 只使用 encoded packet 重封装，并保留转移、取消与清理不变式', async () => {
  const source = await readFile(workerUrl, 'utf8');

  for (const required of [
    'EncodedPacketSink',
    'EncodedVideoPacketSource',
    'EncodedAudioPacketSource',
    'BufferTarget',
    'Mp4OutputFormat',
    'WebMOutputFormat',
    'verifyKeyPackets: true',
    'packet.clone',
    'output.finalize()',
    'input.dispose()',
    "type === 'cancel'"
  ]) {
    assert.equal(source.includes(required), true, `missing strict remux invariant: ${required}`);
  }

  for (const prohibited of [
    /\bALL_FORMATS\b/,
    /\bConversion\b/,
    /\bVideoSampleSink\b/,
    /\bAudioSampleSink\b/,
    /\bVideoSampleSource\b/,
    /\bAudioSampleSource\b/,
    /\bVideoDecoder\b/,
    /\bVideoEncoder\b/,
    /\.canDecode\s*\(/
  ]) {
    assert.doesNotMatch(source, prohibited);
  }

  assert.match(source, /self\.postMessage\(\{ id, type: 'result', result \}, \[result\.buffer\]\)/);
  assert.match(source, /formats: INPUT_FORMATS/);
  assert.match(source, /Promise\.allSettled\(states\.map/);
});

test('上传端会取消过期任务、规范直传 MIME，并只按 JSON redirect 跳转', async () => {
  const source = await readFile(uploadUrl, 'utf8');

  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /instance\.postMessage\(\{ id, type: 'cancel' \}\)/);
  assert.match(source, /selected\.file\.slice\([\s\S]*selected\.probe\.plan\.mediaType/);
  assert.match(source, /const redirectPath = safeRedirectPath\(payload\.redirect\)/);
  assert.match(source, /redirect: 'error'/);
  assert.doesNotMatch(source, /redirect: 'manual'/);
  assert.doesNotMatch(source, /headers\.get\(['"]location['"]\)/);
});
