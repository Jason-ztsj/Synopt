import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

function makeFakeMp4(extraBytes = 0) {
  // This passes the fast upload-time signature check but must fail the
  // independent structural and full-decode validation step.
  const box = Buffer.alloc(24 + extraBytes);
  box.writeUInt32BE(24, 0);
  box.write('ftyp', 4, 'ascii');
  box.write('isom', 8, 'ascii');
  box.writeUInt32BE(0x200, 12);
  box.write('isom', 16, 'ascii');
  box.write('mp42', 20, 'ascii');
  return box;
}

const fixturePromises = new Map();

async function generateFixture(container) {
  if (fixturePromises.has(container)) return fixturePromises.get(container);
  const promise = (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-media-fixture-'));
    const extension = container === 'webm' ? 'webm' : 'mp4';
    const outputPath = path.join(directory, `fixture.${extension}`);
    const codecArguments = container === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '40', '-b:v', '0', '-c:a', 'libopus', '-b:a', '48k']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '12', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart'];
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=12',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-t', '0.6', '-map', '0:v:0', '-map', '1:a:0', '-threads', '1',
      ...codecArguments, '-y', outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code, signal] = await once(child, 'close');
    try {
      if (code !== 0) throw new Error(`FFmpeg 测试夹具生成失败（${code ?? signal}）：${stderr}`);
      return await readFile(outputPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  fixturePromises.set(container, promise);
  return promise;
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function collectCookies(jar, response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    for (const cookie of value.split(/,(?=\s*[^;,]+=)/)) {
      const pair = cookie.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = decodeURIComponent(pair.slice(separator + 1));
      if (cookieValue) jar.set(name, cookieValue);
      else jar.delete(name);
    }
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}

async function createTestAccount(baseUrl) {
  const cookies = new Map();
  const registerPage = await fetch(`${baseUrl}/register`);
  collectCookies(cookies, registerPage);
  const html = await registerPage.text();
  const csrfToken = /name="_csrf"\s+value="([^"]+)"/.exec(html)?.[1];
  if (!csrfToken) throw new Error('注册页面没有 CSRF 凭证');

  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const username = `tester_${suffix}`;
  const password = 'Correct-Horse-2026';
  const response = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(cookies),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      username,
      displayName: '🚀验收用户',
      password
    }),
    redirect: 'manual'
  });
  if (response.status !== 303) {
    throw new Error(`测试账号注册失败（${response.status}）：${await response.text()}`);
  }
  collectCookies(cookies, response);
  return {
    cookies,
    username,
    password,
    csrfToken: cookies.get('tongjian_csrf'),
    cookieHeader: () => cookieHeader(cookies)
  };
}

async function startApplication({
  maxUploadMb = '1',
  cooldownSeconds = '30',
  startValidator = true,
  dataDirectory: existingDataDirectory
} = {}) {
  const dataDirectory = existingDataDirectory
    ?? await mkdtemp(path.join(tmpdir(), 'gongying-http-test-'));
  const storageDirectory = path.join(dataDirectory, 'videos');
  const databasePath = path.join(dataDirectory, 'test.sqlite');
  let port;
  try {
    port = await freePort();
  } catch (error) {
    if (!existingDataDirectory) await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
  const environment = {
    ...process.env,
    PORT: String(port),
    DATABASE_PATH: databasePath,
    VIDEO_STORAGE_PATH: storageDirectory,
    MAX_UPLOAD_MB: String(maxUploadMb),
    DISCUSSION_COOLDOWN_SECONDS: String(cooldownSeconds),
    MEDIA_VALIDATION_POLL_MS: '50',
    MEDIA_VALIDATION_STALE_MINUTES: '1',
    MEDIA_VALIDATION_THREADS: '1',
    CLIENT_IP_MODE: 'direct'
  };
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const validatorChild = startValidator
    ? spawn(process.execPath, ['src/validator-worker.js'], {
        cwd: PROJECT_ROOT,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    : null;

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  validatorChild?.stdout.on('data', (chunk) => { output += `[validator] ${chunk}`; });
  validatorChild?.stderr.on('data', (chunk) => { output += `[validator] ${chunk}`; });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`应用在健康检查前退出（${child.exitCode}）\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) {
        const auth = await createTestAccount(baseUrl);
        return {
          baseUrl,
          auth,
          child,
          validatorChild,
          dataDirectory,
          databasePath,
          storageDirectory,
          output: () => output
        };
      }
    } catch {
      // The listener may not be ready yet.
    }
    await delay(40);
  }

  child.kill('SIGTERM');
  throw new Error(`等待应用启动超时\n${output}`);
}

async function stopApplication(instance, { removeData = true } = {}) {
  if (instance.validatorChild && instance.validatorChild.exitCode === null && instance.validatorChild.signalCode === null) {
    instance.validatorChild.kill('SIGTERM');
    await Promise.race([once(instance.validatorChild, 'exit'), delay(2_000)]);
    if (instance.validatorChild.exitCode === null && instance.validatorChild.signalCode === null) {
      instance.validatorChild.kill('SIGKILL');
      await once(instance.validatorChild, 'exit');
    }
  }
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    instance.child.kill('SIGTERM');
    await Promise.race([once(instance.child, 'exit'), delay(2_000)]);
    if (instance.child.exitCode === null && instance.child.signalCode === null) {
      instance.child.kill('SIGKILL');
      await once(instance.child, 'exit');
    }
  }
  if (removeData) await rm(instance.dataDirectory, { recursive: true, force: true });
}

async function upload(instance, {
  title = '河流经过我们的村庄',
  creator = '山谷影像小组',
  description = '一段用于自动化验收的开放影像。',
  attribution = true,
  nonCommercial = false,
  noDerivatives = false,
  category = 'science-technology',
  tags = '开放视频, 自动化验收',
  bytes,
  filename = 'river.mp4',
  mimeType = 'video/mp4',
  acceptJson = false
} = {}) {
  const mediaBytes = bytes ?? await generateFixture(filename.toLowerCase().endsWith('.webm') ? 'webm' : 'mp4');
  const form = new FormData();
  form.set('_csrf', instance.auth.csrfToken);
  form.set('title', title);
  form.set('creator', creator);
  form.set('description', description);
  form.set('category', category);
  form.set('tags', tags);
  if (attribution) form.set('attribution', 'on');
  if (nonCommercial) form.set('nonCommercial', 'on');
  if (noDerivatives) form.set('noDerivatives', 'on');
  form.set('video', new Blob([mediaBytes], { type: mimeType }), filename);

  return fetch(`${instance.baseUrl}/videos`, {
    method: 'POST',
    headers: {
      cookie: instance.auth.cookieHeader(),
      ...(acceptJson ? { accept: 'application/json' } : {})
    },
    body: form,
    redirect: 'manual'
  });
}

async function waitForValidation(instance, location, { timeoutMs = 15_000 } = {}) {
  const id = location.split('/').at(-1);
  const deadline = Date.now() + timeoutMs;
  let lastPayload;
  while (Date.now() < deadline) {
    const response = await fetch(`${instance.baseUrl}/api/videos/${id}/status`, {
      headers: {
        accept: 'application/json',
        cookie: instance.auth.cookieHeader()
      },
      cache: 'no-store'
    });
    if (response.ok) {
      lastPayload = await response.json();
      if (lastPayload.terminal) return lastPayload;
    }
    if (instance.validatorChild && instance.validatorChild.exitCode !== null) {
      throw new Error(`验证器提前退出（${instance.validatorChild.exitCode}）\n${instance.output()}`);
    }
    await delay(50);
  }
  throw new Error(`等待媒体验证超时：${JSON.stringify(lastPayload)}\n${instance.output()}`);
}

async function allFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(entryPath));
    else files.push(entryPath);
  }
  return files;
}

test('真实 HTTP：上传 CC BY-NC-ND 视频并支持完整、Range 与 HEAD 媒体响应', async (t) => {
  const instance = await startApplication();
  t.after(() => stopApplication(instance));

  const original = await generateFixture('mp4');
  const response = await upload(instance, {
    bytes: original,
    nonCommercial: true,
    noDerivatives: true
  });
  assert.equal(response.status, 303);
  const location = response.headers.get('location');
  assert.match(location, /^\/videos\/[0-9a-f-]+$/i);
  const validation = await waitForValidation(instance, location);
  assert.equal(validation.status, 'ready');

  const detail = await fetch(new URL(location, instance.baseUrl));
  assert.equal(detail.status, 200);
  assert.match(detail.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(detail.headers.get('x-content-type-options'), 'nosniff');
  const detailHtml = await detail.text();
  assert.match(detailHtml, /CC BY-NC-ND 4\.0/);
  assert.match(detailHtml, /creativecommons\.org\/licenses\/by-nc-nd\/4\.0\/deed\.zh-hans/);
  assert.match(detailHtml, /rel="license noopener"/);

  const cover = await fetch(`${instance.baseUrl}${location}/cover`);
  assert.equal(cover.status, 200);
  assert.match(cover.headers.get('content-type') || '', /^image\/jpeg/);
  assert.ok((await cover.arrayBuffer()).byteLength > 100);

  const preview = await fetch(`${instance.baseUrl}/api/markdown-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      body: '**预览** [链接](https://example.com)\n\n- 条目\n\n$E=mc^2$\n\n<script>alert(1)</script>'
    })
  });
  assert.equal(preview.status, 200);
  const previewPayload = await preview.json();
  assert.match(previewPayload.html, /<strong>预览<\/strong>/);
  assert.match(previewPayload.html, /rel="ugc nofollow noopener"/);
  assert.match(previewPayload.html, /class="katex"/);
  assert.doesNotMatch(previewPayload.html, /<script\b/);
  assert.match(previewPayload.html, /&lt;script&gt;/);

  const mediaUrl = `${instance.baseUrl}${location}/media`;
  const full = await fetch(mediaUrl);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('cache-control'), 'private, no-store');
  const mediaCookies = new Map();
  collectCookies(mediaCookies, full);
  assert.ok(mediaCookies.has('tongjian_csrf'));
  assert.equal(Number(full.headers.get('content-length')), original.length);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), original);

  const range = await fetch(mediaUrl, {
    headers: {
      cookie: cookieHeader(mediaCookies),
      Range: 'bytes=4-7'
    }
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(range.headers.get('content-range'), `bytes 4-7/${original.length}`);
  assert.equal(range.headers.get('content-length'), '4');
  assert.equal(Buffer.from(await range.arrayBuffer()).toString('ascii'), 'ftyp');

  const suffix = await fetch(mediaUrl, { headers: { Range: 'bytes=-4' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), original.subarray(-4));

  const unsatisfiableStart = original.length + 100;
  const unsatisfiable = await fetch(mediaUrl, {
    headers: { Range: `bytes=${unsatisfiableStart}-${unsatisfiableStart + 100}` }
  });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${original.length}`);

  const head = await fetch(mediaUrl, {
    method: 'HEAD',
    headers: { Range: 'bytes=0-3' }
  });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), `bytes 0-3/${original.length}`);
  assert.equal(head.headers.get('content-length'), '4');
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const storedFiles = await allFiles(instance.storageDirectory);
  assert.equal(storedFiles.filter((file) => file.endsWith('.mp4')).length, 1);
  assert.equal(storedFiles.filter((file) => file.endsWith('.upload')).length, 0);
});

test('真实 HTTP：大文件分片上传（建会话→收片→组装→发布）可经受权与完整校验', async (t) => {
  const instance = await startApplication();
  t.after(() => stopApplication(instance));
  const auth = instance.auth;
  const original = await generateFixture('mp4');
  const csrfHeaders = { 'x-csrf-token': auth.csrfToken };

  const createResponse = await fetch(`${instance.baseUrl}/videos/media-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', cookie: auth.cookieHeader(), ...csrfHeaders },
    body: JSON.stringify({
      totalBytes: original.length,
      fileName: 'river.mp4',
      sourceFilename: 'river.mp4',
      mimeType: 'video/mp4',
      container: 'mp4',
      videoCodec: 'avc',
      audioCodec: 'aac',
      operation: 'direct'
    })
  });
  assert.equal(createResponse.status, 201);
  const session = await createResponse.json();
  assert.ok(session.sessionId);
  assert.ok(session.chunkSize > 0);
  assert.equal(session.expectedCount, 1, '测试文件远小于默认分片大小，应为单片');

  const chunkResponse = await fetch(`${instance.baseUrl}/videos/media-session/${session.sessionId}/chunks/0`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: auth.cookieHeader(), ...csrfHeaders },
    body: Buffer.from(original)
  });
  assert.equal(chunkResponse.status, 200);

  const completeResponse = await fetch(`${instance.baseUrl}/videos/media-session/${session.sessionId}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', cookie: auth.cookieHeader(), ...csrfHeaders },
    body: JSON.stringify({})
  });
  assert.equal(completeResponse.status, 200);

  const form = new FormData();
  form.set('_csrf', auth.csrfToken);
  form.set('title', '分片上传的河流');
  form.set('creator', '山谷影像小组');
  form.set('description', '一段用于自动化验收的开放影像。');
  form.set('category', 'science-technology');
  form.set('tags', '开放视频, 分片');
  form.set('attribution', 'on');
  form.set('mediaSessionId', session.sessionId);
  const publishResponse = await fetch(`${instance.baseUrl}/videos`, {
    method: 'POST',
    headers: { cookie: auth.cookieHeader() },
    body: form,
    redirect: 'manual'
  });
  assert.equal(publishResponse.status, 303);
  const location = publishResponse.headers.get('location');
  assert.match(location, /^\/videos\/[0-9a-f-]+$/i);
  const validation = await waitForValidation(instance, location);
  assert.equal(validation.status, 'ready');
});

test('真实 HTTP：WebM VP9/Opus 经完整验证后以正确 MIME 原样公开', async (t) => {
  const instance = await startApplication();
  t.after(() => stopApplication(instance));

  const original = await generateFixture('webm');
  const response = await upload(instance, {
    title: '开放的 WebM 作品',
    bytes: original,
    filename: 'open-work.webm',
    mimeType: 'video/webm',
    acceptJson: true
  });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.equal(accepted.status, 'pending');
  assert.match(accepted.statusUrl, /^\/api\/videos\/[0-9a-f-]+\/status$/i);
  const location = accepted.redirect;
  const validation = await waitForValidation(instance, location);
  assert.equal(validation.status, 'ready');

  const detail = await fetch(`${instance.baseUrl}${location}`);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /VP9[^<]*\+[^<]*Opus[^<]*WEBM/i);

  const media = await fetch(`${instance.baseUrl}${location}/media`);
  assert.equal(media.status, 200);
  assert.match(media.headers.get('content-type') || '', /^video\/webm/);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), original);
});

test('真实 HTTP：pending 媒体只对上传者展示状态，不能播放、列出或讨论', async (t) => {
  const instance = await startApplication({ startValidator: false });
  t.after(() => stopApplication(instance));

  const response = await upload(instance, { title: '仍在隔离区的作品' });
  assert.equal(response.status, 303);
  const location = response.headers.get('location');
  const id = location.split('/').at(-1);

  const status = await fetch(`${instance.baseUrl}/api/videos/${id}/status`, {
    headers: { cookie: instance.auth.cookieHeader(), accept: 'application/json' }
  });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).status, 'pending');

  const ownerDetail = await fetch(`${instance.baseUrl}${location}`, {
    headers: { cookie: instance.auth.cookieHeader() }
  });
  assert.equal(ownerDetail.status, 200);
  assert.match(await ownerDetail.text(), /等待验证|发布前安全检查/);
  assert.equal((await fetch(`${instance.baseUrl}${location}`)).status, 404);
  assert.equal((await fetch(`${instance.baseUrl}${location}/media`)).status, 409);

  const homepage = await fetch(instance.baseUrl);
  assert.doesNotMatch(await homepage.text(), /仍在隔离区的作品/);
  const discussion = await fetch(`${instance.baseUrl}${location}/discussions`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      cookie: instance.auth.cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ _csrf: instance.auth.csrfToken, body: '不应写入' })
  });
  assert.equal(discussion.status, 409);

  const storedFiles = await allFiles(instance.storageDirectory);
  assert.equal(storedFiles.length, 1);
  assert.match(storedFiles[0], /[/\\]\.pending[/\\].+\.mp4$/);
});

test('真实 HTTP：拒绝扩展名、MIME、ftyp 错误以及超限文件，并清理临时文件', async (t) => {
  const instance = await startApplication({ maxUploadMb: '1' });
  t.after(() => stopApplication(instance));

  const invalidCases = [
    { filename: 'not-video.txt', mimeType: 'video/mp4', bytes: makeFakeMp4() },
    { filename: 'not-video.mp4', mimeType: 'text/plain', bytes: makeFakeMp4() },
    {
      filename: 'not-video.mp4',
      mimeType: 'video/mp4',
      bytes: Buffer.from('this is not an mp4'),
      attribution: false,
      nonCommercial: true,
      noDerivatives: true
    }
  ];

  for (const invalid of invalidCases) {
    const response = await upload(instance, invalid);
    assert.equal(response.status, 400, `应拒绝 ${invalid.filename}/${invalid.mimeType}`);
    const responseHtml = await response.text();
    assert.match(responseHtml, /MP4|视频|文件/i);
    if (invalid.attribution === false) {
      assert.match(responseHtml, /CC0 1\.0/);
      assert.match(responseHtml, /publicdomain\/zero\/1\.0\/deed\.zh-hans/);
    }
    assert.deepEqual(await allFiles(instance.storageDirectory), []);
  }

  const tooLarge = await upload(instance, {
    bytes: makeFakeMp4(1024 * 1024 + 1)
  });
  assert.equal(tooLarge.status, 413);
  assert.match(await tooLarge.text(), /过大|上限|MiB|大小/i);
  assert.deepEqual(await allFiles(instance.storageDirectory), []);

  const disguisedGarbage = await upload(instance, {
    title: '伪造文件头不会公开',
    bytes: makeFakeMp4(64)
  });
  assert.equal(disguisedGarbage.status, 303);
  const rejectedLocation = disguisedGarbage.headers.get('location');
  const rejected = await waitForValidation(instance, rejectedLocation);
  assert.equal(rejected.status, 'rejected');
  const rejectedMedia = await fetch(`${instance.baseUrl}${rejectedLocation}/media`);
  assert.equal(rejectedMedia.status, 409);
  const ownerDetail = await fetch(`${instance.baseUrl}${rejectedLocation}`, {
    headers: { cookie: instance.auth.cookieHeader() }
  });
  assert.equal(ownerDetail.status, 200);
  assert.match(await ownerDetail.text(), /未通过验证|不能|无效|结构/);
  assert.deepEqual(await allFiles(instance.storageDirectory), []);

  const homepage = await fetch(instance.baseUrl);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /第一束光/);
});

test('真实 HTTP：讨论首次发布成功，立即重复返回 429、Retry-After 与中文剩余时间', async (t) => {
  const instance = await startApplication({ cooldownSeconds: '30' });
  t.after(() => stopApplication(instance));

  const uploaded = await upload(instance);
  assert.equal(uploaded.status, 303);
  const location = uploaded.headers.get('location');
  assert.equal((await waitForValidation(instance, location)).ready, true);

  const body = new URLSearchParams({
    _csrf: instance.auth.csrfToken,
    body: '**第一条讨论**，以及 $E=mc^2$。'
  });
  const first = await fetch(`${instance.baseUrl}${location}/discussions`, {
    method: 'POST',
    headers: {
      cookie: instance.auth.cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body,
    redirect: 'manual'
  });
  assert.equal(first.status, 303);
  assert.match(first.headers.get('location') || '', new RegExp(`^${location}#discussion-\\d+$`));

  const repeated = await fetch(`${instance.baseUrl}${location}/discussions`, {
    method: 'POST',
    headers: {
      cookie: instance.auth.cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body,
    redirect: 'manual'
  });
  assert.equal(repeated.status, 429);
  assert.match(repeated.headers.get('retry-after') || '', /^(?:29|30)$/);
  assert.match(await repeated.text(), /(?:29|30)\s*秒|稍后/);

  const detail = await fetch(`${instance.baseUrl}${location}`);
  const html = await detail.text();
  assert.match(html, /<strong>第一条讨论<\/strong>/);
  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /(?:127\.0\.0\.1|::1)/);
});

test('真实 HTTP：视频与讨论投票可切换，讨论标题和树状回复可持久化', async (t) => {
  const instance = await startApplication({ cooldownSeconds: '1' });
  t.after(() => stopApplication(instance));

  const uploaded = await upload(instance, { title: '树状讨论与投票' });
  const location = uploaded.headers.get('location');
  assert.equal((await waitForValidation(instance, location)).ready, true);

  const topicResponse = await fetch(`${instance.baseUrl}${location}/discussions`, {
    method: 'POST',
    headers: { cookie: instance.auth.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: instance.auth.csrfToken,
      title: '关于第一幕的讨论',
      body: '这是主题正文。'
    }),
    redirect: 'manual'
  });
  assert.equal(topicResponse.status, 303);
  const topicId = Number(/#discussion-(\d+)$/.exec(topicResponse.headers.get('location') || '')?.[1]);
  assert.ok(Number.isSafeInteger(topicId));

  await delay(1100);
  const replyResponse = await fetch(`${instance.baseUrl}${location}/discussions`, {
    method: 'POST',
    headers: { cookie: instance.auth.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: instance.auth.csrfToken,
      parentId: String(topicId),
      title: '回复中的补充观点',
      body: '这是对主题的回复。'
    }),
    redirect: 'manual'
  });
  assert.equal(replyResponse.status, 303);

  const videoVote = await fetch(`${instance.baseUrl}${location}/vote`, {
    method: 'POST',
    headers: { accept: 'application/json', cookie: instance.auth.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: instance.auth.csrfToken, value: '1' })
  });
  assert.deepEqual(await videoVote.json(), { upvotes: 1, downvotes: 0, viewerVote: 1 });

  const discussionVote = await fetch(`${instance.baseUrl}/discussions/${topicId}/vote`, {
    method: 'POST',
    headers: { accept: 'application/json', cookie: instance.auth.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: instance.auth.csrfToken, value: '-1' })
  });
  assert.deepEqual(await discussionVote.json(), { upvotes: 0, downvotes: 1, viewerVote: -1 });

  const detail = await fetch(`${instance.baseUrl}${location}`, {
    headers: { cookie: instance.auth.cookieHeader() }
  });
  const html = await detail.text();
  assert.match(html, /关于第一幕的讨论/);
  assert.match(html, /回复中的补充观点/);
  assert.match(html, /这是对主题的回复/);
  assert.match(html, /discussion-reply/);
  assert.match(html, new RegExp(`id="reply-composer-${topicId}-formula-dialog"`));
  assert.match(html, new RegExp(`name="parentId" value="${topicId}"`));
  assert.match(html, /回复标题/);
  assert.doesNotMatch(html, /data-formula-keyboard/);
});

test('真实 HTTP：账号会话保护上传与讨论，校验 CSRF，并支持退出后重新登录', async (t) => {
  const instance = await startApplication();
  t.after(() => stopApplication(instance));

  const anonymousRegister = await fetch(`${instance.baseUrl}/register`);
  assert.equal(anonymousRegister.headers.get('cache-control'), 'no-store');
  const anonymousCookies = typeof anonymousRegister.headers.getSetCookie === 'function'
    ? anonymousRegister.headers.getSetCookie()
    : [anonymousRegister.headers.get('set-cookie')].filter(Boolean);
  assert.match(anonymousCookies.join('; '), /tongjian_csrf=.*HttpOnly/i);
  assert.match(anonymousCookies.join('; '), /SameSite=Lax/i);
  const unsafeNextPage = await fetch(`${instance.baseUrl}/login?next=${encodeURIComponent('//evil.example/path')}`);
  assert.match(await unsafeNextPage.text(), /name="next"\s+value="\/"/);

  const anonymousUploadPage = await fetch(`${instance.baseUrl}/upload`, { redirect: 'manual' });
  assert.equal(anonymousUploadPage.status, 303);
  assert.match(anonymousUploadPage.headers.get('location') || '', /^\/login\?next=/);

  const uploaded = await upload(instance, { title: '账号归属验证' });
  assert.equal(uploaded.status, 303);
  const location = uploaded.headers.get('location');
  assert.equal((await waitForValidation(instance, location)).ready, true);
  const detail = await fetch(new URL(location, instance.baseUrl));
  assert.match(await detail.text(), /验收用户/);

  const authenticatedDetail = await fetch(new URL(location, instance.baseUrl), {
    headers: { cookie: instance.auth.cookieHeader() }
  });
  const authenticatedHtml = await authenticatedDetail.text();
  assert.match(authenticatedHtml, /account-chip__avatar[^>]*>🚀<\/span>/);
  assert.match(authenticatedHtml, /data-vote-kind="up"[^]*?name="value" value="1"/);
  assert.match(authenticatedHtml, /data-vote-kind="down"[^]*?name="value" value="-1"/);
  assert.match(authenticatedHtml, /data-formula-editor/);
  assert.match(authenticatedHtml, /\/static\/js\/math-editor\.js/);
  const mathLiveModule = await fetch(`${instance.baseUrl}/assets/mathlive/mathlive.min.mjs`);
  assert.equal(mathLiveModule.status, 200);
  assert.match(mathLiveModule.headers.get('content-type') || '', /javascript/);
  const mathLiveFont = await fetch(`${instance.baseUrl}/assets/mathlive/fonts/KaTeX_Main-Regular.woff2`);
  assert.equal(mathLiveFont.status, 200);

  const rejectedCsrf = await fetch(`${instance.baseUrl}${location}/discussions`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      cookie: instance.auth.cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ body: '缺少页面凭证的请求' })
  });
  assert.equal(rejectedCsrf.status, 403);
  assert.match((await rejectedCsrf.json()).error, /凭证|刷新/);

  const logout = await fetch(`${instance.baseUrl}/logout`, {
    method: 'POST',
    headers: {
      cookie: instance.auth.cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ _csrf: instance.auth.csrfToken }),
    redirect: 'manual'
  });
  assert.equal(logout.status, 303);
  collectCookies(instance.auth.cookies, logout);
  const afterLogout = await fetch(`${instance.baseUrl}/upload`, {
    headers: { cookie: instance.auth.cookieHeader() },
    redirect: 'manual'
  });
  assert.equal(afterLogout.status, 303);

  const loginPage = await fetch(`${instance.baseUrl}/login`, {
    headers: { cookie: instance.auth.cookieHeader() }
  });
  collectCookies(instance.auth.cookies, loginPage);
  const loginHtml = await loginPage.text();
  const loginCsrf = /name="_csrf"\s+value="([^"]+)"/.exec(loginHtml)?.[1];
  assert.ok(loginCsrf);
  const login = await fetch(`${instance.baseUrl}/login`, {
    method: 'POST',
    headers: {
      cookie: instance.auth.cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      _csrf: loginCsrf,
      username: instance.auth.username,
      password: instance.auth.password,
      next: '/upload'
    }),
    redirect: 'manual'
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/upload');
  collectCookies(instance.auth.cookies, login);
  const authenticatedAgain = await fetch(`${instance.baseUrl}/upload`, {
    headers: { cookie: instance.auth.cookieHeader() }
  });
  assert.equal(authenticatedAgain.status, 200);
});

test('真实 HTTP：重启进程后视频、Range、许可证和讨论仍然存在，内存冷却窗口会清空', async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'gongying-restart-test-'));
  let firstInstance;
  let secondInstance;
  t.after(async () => {
    if (firstInstance) await stopApplication(firstInstance, { removeData: false });
    if (secondInstance) await stopApplication(secondInstance, { removeData: false });
    await rm(dataDirectory, { recursive: true, force: true });
  });

  firstInstance = await startApplication({ dataDirectory });
  const mediaBytes = await generateFixture('mp4');
  const uploaded = await upload(firstInstance, {
    bytes: mediaBytes,
    attribution: false,
    nonCommercial: true,
    noDerivatives: true
  });
  assert.equal(uploaded.status, 303);
  const location = uploaded.headers.get('location');
  assert.equal((await waitForValidation(firstInstance, location)).ready, true);

  const firstDiscussion = await fetch(`${firstInstance.baseUrl}${location}/discussions`, {
    method: 'POST',
    headers: {
      cookie: firstInstance.auth.cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      _csrf: firstInstance.auth.csrfToken,
      body: '重启前的讨论'
    }),
    redirect: 'manual'
  });
  assert.equal(firstDiscussion.status, 303);
  await stopApplication(firstInstance, { removeData: false });
  firstInstance = undefined;

  secondInstance = await startApplication({ dataDirectory });
  const detail = await fetch(`${secondInstance.baseUrl}${location}`);
  assert.equal(detail.status, 200);
  const html = await detail.text();
  assert.match(html, /CC0 1\.0/);
  assert.match(html, /公共领域工具/);
  assert.match(html, /重启前的讨论/);

  const range = await fetch(`${secondInstance.baseUrl}${location}/media`, {
    headers: { Range: 'bytes=4-7' }
  });
  assert.equal(range.status, 206);
  assert.equal(Buffer.from(await range.arrayBuffer()).toString('ascii'), 'ftyp');

  // The limiter is intentionally process-local, so a post from the same loopback
  // address is accepted immediately after restarting while persisted data remains.
  const afterRestart = await fetch(`${secondInstance.baseUrl}${location}/discussions`, {
    method: 'POST',
    headers: {
      cookie: secondInstance.auth.cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      _csrf: secondInstance.auth.csrfToken,
      body: '重启后的第二条讨论'
    }),
    redirect: 'manual'
  });
  assert.equal(afterRestart.status, 303);

  const finalDetail = await fetch(`${secondInstance.baseUrl}${location}`);
  const finalHtml = await finalDetail.text();
  assert.match(finalHtml, /重启前的讨论/);
  assert.match(finalHtml, /重启后的第二条讨论/);
});
