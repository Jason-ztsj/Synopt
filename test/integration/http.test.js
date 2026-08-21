import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

function makeMp4(extraBytes = 0) {
  // A minimal ISO-BMFF ftyp box. The application intentionally checks the
  // container signature only; codec probing belongs outside this MVP.
  const box = Buffer.alloc(24 + extraBytes);
  box.writeUInt32BE(24, 0);
  box.write('ftyp', 4, 'ascii');
  box.write('isom', 8, 'ascii');
  box.writeUInt32BE(0x200, 12);
  box.write('isom', 16, 'ascii');
  box.write('mp42', 20, 'ascii');
  return box;
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
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: databasePath,
      VIDEO_STORAGE_PATH: storageDirectory,
      MAX_UPLOAD_MB: String(maxUploadMb),
      DISCUSSION_COOLDOWN_SECONDS: String(cooldownSeconds),
      CLIENT_IP_MODE: 'direct'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

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
  bytes = makeMp4(),
  filename = 'river.mp4',
  mimeType = 'video/mp4'
} = {}) {
  const form = new FormData();
  form.set('_csrf', instance.auth.csrfToken);
  form.set('title', title);
  form.set('creator', creator);
  form.set('description', description);
  if (attribution) form.set('attribution', 'on');
  if (nonCommercial) form.set('nonCommercial', 'on');
  if (noDerivatives) form.set('noDerivatives', 'on');
  form.set('video', new Blob([bytes], { type: mimeType }), filename);

  return fetch(`${instance.baseUrl}/videos`, {
    method: 'POST',
    headers: { cookie: instance.auth.cookieHeader() },
    body: form,
    redirect: 'manual'
  });
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

  const original = makeMp4(64);
  const response = await upload(instance, {
    bytes: original,
    nonCommercial: true,
    noDerivatives: true
  });
  assert.equal(response.status, 303);
  const location = response.headers.get('location');
  assert.match(location, /^\/videos\/[0-9a-f-]+$/i);

  const detail = await fetch(new URL(location, instance.baseUrl));
  assert.equal(detail.status, 200);
  assert.match(detail.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(detail.headers.get('x-content-type-options'), 'nosniff');
  const detailHtml = await detail.text();
  assert.match(detailHtml, /CC BY-NC-ND 4\.0/);
  assert.match(detailHtml, /creativecommons\.org\/licenses\/by-nc-nd\/4\.0\/deed\.zh-hans/);
  assert.match(detailHtml, /rel="license noopener"/);

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

  const unsatisfiable = await fetch(mediaUrl, { headers: { Range: 'bytes=9999-10000' } });
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

test('真实 HTTP：拒绝扩展名、MIME、ftyp 错误以及超限文件，并清理临时文件', async (t) => {
  const instance = await startApplication({ maxUploadMb: '1' });
  t.after(() => stopApplication(instance));

  const invalidCases = [
    { filename: 'not-video.txt', mimeType: 'video/mp4', bytes: makeMp4() },
    { filename: 'not-video.mp4', mimeType: 'text/plain', bytes: makeMp4() },
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
    bytes: makeMp4(1024 * 1024 + 1)
  });
  assert.equal(tooLarge.status, 413);
  assert.match(await tooLarge.text(), /过大|上限|MiB|大小/i);
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
  assert.equal(first.headers.get('location'), `${location}#discussion-list`);

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
  const detail = await fetch(new URL(location, instance.baseUrl));
  assert.match(await detail.text(), /验收用户/);

  const authenticatedDetail = await fetch(new URL(location, instance.baseUrl), {
    headers: { cookie: instance.auth.cookieHeader() }
  });
  const authenticatedHtml = await authenticatedDetail.text();
  assert.match(authenticatedHtml, /account-chip__avatar[^>]*>🚀<\/span>/);
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
  const mediaBytes = makeMp4(32);
  const uploaded = await upload(firstInstance, {
    bytes: mediaBytes,
    attribution: false,
    nonCommercial: true,
    noDerivatives: true
  });
  assert.equal(uploaded.status, 303);
  const location = uploaded.headers.get('location');

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
