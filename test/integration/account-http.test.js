import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createApp, startServer } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/database.js';

const execFileAsync = promisify(execFile);

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

function csrfFromHtml(html) {
  return /name="_csrf"\s+value="([^"]+)"/.exec(html)?.[1];
}

function expectRedirect(response, location) {
  assert.equal(response.status, 303);
  if (location instanceof RegExp) assert.match(response.headers.get('location') || '', location);
  else if (location) assert.equal(response.headers.get('location'), location);
}

function missing(filePath) {
  return access(filePath).then(() => false, (error) => {
    if (error?.code === 'ENOENT') return true;
    throw error;
  });
}

async function startFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-account-http-'));
  const databasePath = path.join(directory, 'account.sqlite');
  const videoStoragePath = path.join(directory, 'videos');
  const config = loadConfig({
    PORT: '3000',
    DATABASE_PATH: databasePath,
    VIDEO_STORAGE_PATH: videoStoragePath,
    MAX_UPLOAD_MB: '2',
    DISCUSSION_COOLDOWN_SECONDS: '1',
    SESSION_TTL_HOURS: '24',
    SESSION_COOKIE_SECURE: 'false',
    AUTH_COOLDOWN_SECONDS: '1',
    CLIENT_IP_MODE: 'direct'
  }, directory);
  const database = openDatabase(databasePath);
  let timestamp = Date.parse('2026-08-23T10:00:00.000Z');
  const unlimited = {
    check: () => ({ allowed: true, retryAfterSeconds: 0 }),
    consume: () => {},
    clear: () => {}
  };
  const app = createApp({
    config,
    database,
    now: () => timestamp,
    rateLimiter: unlimited,
    registrationLimiter: unlimited,
    loginLimiter: unlimited
  });
  const running = await startServer({ app, port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${running.address.port}`;

  t.after(async () => {
    await running.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function register(username, displayName, password = 'Correct-Horse-2026') {
    const cookies = new Map();
    const page = await fetch(`${baseUrl}/register`);
    collectCookies(cookies, page);
    const csrf = csrfFromHtml(await page.text());
    assert.ok(csrf, '注册页应提供 CSRF 凭证');
    const response = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader(cookies),
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ _csrf: csrf, username, displayName, password }),
      redirect: 'manual'
    });
    expectRedirect(response, '/');
    collectCookies(cookies, response);
    assert.ok(cookies.get('tongjian_session'));
    assert.ok(cookies.get('tongjian_csrf'));
    return {
      username,
      displayName,
      password,
      cookies,
      get user() { return database.findUserByUsername(username); }
    };
  }

  async function login(username, password) {
    const cookies = new Map();
    const page = await fetch(`${baseUrl}/login`);
    collectCookies(cookies, page);
    const csrf = csrfFromHtml(await page.text());
    assert.ok(csrf, '登录页应提供 CSRF 凭证');
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader(cookies),
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ _csrf: csrf, username, password }),
      redirect: 'manual'
    });
    collectCookies(cookies, response);
    return { response, cookies, csrf };
  }

  async function request(route, { auth, method = 'GET', form, multipart, accept, redirect = 'manual' } = {}) {
    let body;
    const headers = {};
    if (auth) headers.cookie = cookieHeader(auth.cookies);
    if (accept) headers.accept = accept;
    if (form) {
      body = new URLSearchParams({
        _csrf: auth?.cookies.get('tongjian_csrf') ?? '',
        ...form
      });
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (multipart) {
      body = new FormData();
      body.set('_csrf', auth?.cookies.get('tongjian_csrf') ?? '');
      for (const [name, value] of Object.entries(multipart)) body.set(name, value);
    }
    const response = await fetch(`${baseUrl}${route}`, { method, headers, body, redirect });
    if (auth) collectCookies(auth.cookies, response);
    return response;
  }

  async function readyVideo(owner, {
    id = crypto.randomUUID(),
    title = `测试作品-${id.slice(0, 6)}`,
    cover = true
  } = {}) {
    const storageName = `${id}.mp4`;
    const coverStorageName = cover ? `${id}.jpg` : null;
    const mediaPath = path.join(config.videoStoragePath, storageName);
    const coverPath = coverStorageName ? path.join(config.coverStoragePath, coverStorageName) : null;
    const media = Buffer.from('account HTTP integration video placeholder');
    await writeFile(mediaPath, media);
    if (coverPath) await writeFile(coverPath, Buffer.from('cover placeholder'));
    database.insertVideo({
      id,
      title,
      creator: owner.displayName,
      description: '账号中心集成测试作品',
      licenseCode: 'CC-BY-4.0',
      storageName,
      originalFilename: `${title}.mp4`,
      mediaType: 'video/mp4',
      byteSize: media.length,
      container: 'mp4',
      videoCodec: 'avc',
      audioCodec: 'aac',
      playbackStrategy: 'native',
      validationStatus: 'ready',
      sha256: crypto.createHash('sha256').update(media).digest('hex'),
      durationSeconds: 1,
      width: 1920,
      height: 1080,
      frameRate: 24,
      validationWarningCount: 0,
      validationSummary: {},
      validatedAt: new Date(timestamp).toISOString(),
      sourceContainer: 'mp4',
      sourceVideoCodec: 'avc',
      sourceAudioCodec: 'aac',
      ingestOperation: 'direct',
      userId: owner.user.id,
      categorySlug: 'science-technology',
      coverStorageName,
      coverMediaType: cover ? 'image/jpeg' : null,
      coverSource: cover ? 'uploaded' : null,
      visibility: 'public',
      moderationStatus: 'visible',
      createdAt: new Date(timestamp).toISOString()
    });
    return { id, title, storageName, coverStorageName, mediaPath, coverPath };
  }

  function insertDiscussion(author, video, {
    title = '测试讨论',
    body = '测试讨论正文',
    parentId = null
  } = {}) {
    return database.insertDiscussion({
      videoId: video.id,
      userId: author.user.id,
      nickname: author.displayName,
      title,
      bodyMarkdown: body,
      parentId,
      createdAt: new Date(timestamp).toISOString()
    });
  }

  return {
    baseUrl,
    config,
    database,
    register,
    login,
    request,
    readyVideo,
    insertDiscussion,
    advance(milliseconds = 1000) { timestamp += milliseconds; }
  };
}

test('账号中心：真实 HTTP 覆盖资料、内容管理、通知与注销语义', async (t) => {
  const fixture = await startFixture(t);
  const owner = await fixture.register('account_owner', '账号所有者');
  const reader = await fixture.register('account_reader', '第一位读者');
  const secondReader = await fixture.register('account_reader_2', '第二位读者');

  await t.test('未登录访问账号页会重定向，资料更新公开可见，密码变更使旧密码失效', async () => {
    const anonymous = await fixture.request('/account/profile');
    expectRedirect(anonymous, /^\/login\?next=/);
    assert.match(decodeURIComponent(anonymous.headers.get('location') || ''), /\/account\/profile/);

    const update = await fixture.request('/account/profile', {
      auth: owner,
      method: 'POST',
      multipart: {
        displayName: '更新后的公开名称',
        bio: '这是公开个人简介，包含开放影像。'
      }
    });
    expectRedirect(update, '/account/profile?saved=profile');
    const stored = fixture.database.getUserById(owner.user.id);
    assert.equal(stored.displayName, '更新后的公开名称');
    assert.equal(stored.bio, '这是公开个人简介，包含开放影像。');

    const publicProfile = await fixture.request(`/users/${owner.username}`);
    assert.equal(publicProfile.status, 200);
    const profileHtml = await publicProfile.text();
    assert.match(profileHtml, /更新后的公开名称/);
    assert.match(profileHtml, /这是公开个人简介，包含开放影像/);
    assert.match(profileHtml, new RegExp(`@${owner.username}`));

    const avatarSource = path.join(fixture.config.temporaryStoragePath, 'http-test-avatar.png');
    await execFileAsync(fixture.config.ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x2563eb:s=128x128',
      '-frames:v', '1', '-compression_level', '2', '-update', '1', '-y', avatarSource
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const avatarUpload = await fixture.request('/account/profile', {
      auth: owner,
      method: 'POST',
      multipart: {
        displayName: '更新后的公开名称',
        bio: '这是公开个人简介，包含开放影像。',
        avatar: new File([await readFile(avatarSource)], 'avatar.png', { type: 'image/png' })
      }
    });
    expectRedirect(avatarUpload, '/account/profile?saved=profile');
    const avatarAccount = fixture.database.getUserById(owner.user.id);
    assert.equal(avatarAccount.avatarMediaType, 'image/webp');
    assert.match(avatarAccount.avatarStorageName, /\.webp$/);
    const publicAvatar = await fixture.request(`/users/${owner.username}/avatar`);
    assert.equal(publicAvatar.status, 200);
    assert.equal(publicAvatar.headers.get('content-type'), 'image/webp');
    assert.equal((await publicAvatar.arrayBuffer()).byteLength > 24, true);
    await rm(avatarSource, { force: true });

    const newPassword = 'New-Correct-Horse-2026';
    const changed = await fixture.request('/account/settings/password', {
      auth: owner,
      method: 'POST',
      form: {
        currentPassword: owner.password,
        newPassword,
        confirmPassword: newPassword
      }
    });
    expectRedirect(changed, '/account/settings?saved=password');

    const oldLogin = await fixture.login(owner.username, owner.password);
    assert.equal(oldLogin.response.status, 401);
    assert.match(await oldLogin.response.text(), /用户名或密码不正确/);
    const newLogin = await fixture.login(owner.username, newPassword);
    expectRedirect(newLogin.response, '/');
    assert.ok(newLogin.cookies.get('tongjian_session'));
    owner.password = newPassword;
  });

  await t.test('稿件只能由所有者撤回和重发，永久删除要求先撤回并保留讨论档案', async () => {
    const video = await fixture.readyVideo(owner, { title: '允许撤回的测试稿件' });
    const archivedDiscussion = fixture.insertDiscussion(reader, video, {
      title: '应保留的读者讨论',
      body: '作品删除后这段讨论仍应存在。'
    });

    const nonOwner = await fixture.request(`/account/videos/${video.id}/withdraw`, {
      auth: reader,
      method: 'POST',
      form: {}
    });
    assert.equal(nonOwner.status, 404);
    assert.equal(fixture.database.getVideo(video.id).withdrawnAt, null);

    const deleteBeforeWithdraw = await fixture.request(`/account/videos/${video.id}/delete`, {
      auth: owner,
      method: 'POST',
      form: { confirmTitle: video.title }
    });
    assert.equal(deleteBeforeWithdraw.status, 409);
    assert.equal(await missing(video.mediaPath), false);

    const withdrawn = await fixture.request(`/account/videos/${video.id}/withdraw`, {
      auth: owner,
      method: 'POST',
      form: {}
    });
    expectRedirect(withdrawn, '/account/videos?saved=withdrawn');
    assert.ok(fixture.database.getVideo(video.id).withdrawnAt);
    assert.equal(fixture.database.getVideo(video.id).visibility, 'private');
    assert.equal((await fixture.request(`/videos/${video.id}`)).status, 404);
    assert.equal((await fixture.request(`/videos/${video.id}/media`)).status, 404);
    assert.equal((await fixture.request(`/videos/${video.id}/cover`)).status, 404);
    const ownerMedia = await fixture.request(`/videos/${video.id}/media`, { auth: owner });
    assert.equal(ownerMedia.status, 200);
    assert.equal(ownerMedia.headers.get('cache-control'), 'private, no-store');
    const ownerCover = await fixture.request(`/videos/${video.id}/cover`, { auth: owner });
    assert.equal(ownerCover.status, 200);
    assert.equal(ownerCover.headers.get('cache-control'), 'private, no-store');

    const republished = await fixture.request(`/account/videos/${video.id}/republish`, {
      auth: owner,
      method: 'POST',
      form: {}
    });
    expectRedirect(republished, '/account/videos?saved=republished');
    assert.equal(fixture.database.getVideo(video.id).withdrawnAt, null);
    assert.equal(fixture.database.getVideo(video.id).visibility, 'public');
    assert.equal((await fixture.request(`/videos/${video.id}`)).status, 200);

    await fixture.request(`/account/videos/${video.id}/withdraw`, {
      auth: owner,
      method: 'POST',
      form: {}
    });
    const wrongTitle = await fixture.request(`/account/videos/${video.id}/delete`, {
      auth: owner,
      method: 'POST',
      form: { confirmTitle: '标题不匹配' }
    });
    assert.equal(wrongTitle.status, 400);
    assert.equal(await missing(video.mediaPath), false);

    const deleted = await fixture.request(`/account/videos/${video.id}/delete`, {
      auth: owner,
      method: 'POST',
      form: { confirmTitle: video.title }
    });
    expectRedirect(deleted, '/account/videos?saved=deleted');
    const archived = fixture.database.getVideo(video.id);
    assert.ok(archived.deletedAt);
    assert.equal(archived.title, '作品已删除');
    assert.equal(archived.userId, null);
    assert.equal(await missing(video.mediaPath), true);
    assert.equal(await missing(video.coverPath), true);
    assert.ok(fixture.database.getDiscussion(archivedDiscussion.id));

    const archivePage = await fixture.request(`/videos/${video.id}`);
    assert.equal(archivePage.status, 200);
    const archiveHtml = await archivePage.text();
    assert.match(archiveHtml, /作品已由发布者永久删除/);
    assert.match(archiveHtml, /作品删除后这段讨论仍应存在/);

    const privateVideo = await fixture.readyVideo(owner, { title: '从未公开的私密稿件', cover: false });
    fixture.database.raw.prepare("UPDATE videos SET visibility = 'private' WHERE id = ?").run(privateVideo.id);
    await fixture.request(`/account/videos/${privateVideo.id}/withdraw`, {
      auth: owner,
      method: 'POST',
      form: {}
    });
    const privateDeleted = await fixture.request(`/account/videos/${privateVideo.id}/delete`, {
      auth: owner,
      method: 'POST',
      form: { confirmTitle: privateVideo.title }
    });
    expectRedirect(privateDeleted, '/account/videos?saved=deleted');
    assert.equal(fixture.database.getVideo(privateVideo.id).archivePublic, false);
    assert.equal(
      (await fixture.request(`/videos/${privateVideo.id}`)).status,
      404,
      '永久删除不得把从未公开的讨论档案意外公开'
    );
  });

  await t.test('讨论编辑记录次数；无回复时删除，有回复时留下墓碑并保留子回复', async () => {
    const video = await fixture.readyVideo(owner, { title: '讨论管理测试稿件', cover: false });
    const root = fixture.insertDiscussion(owner, video, {
      title: '编辑前标题',
      body: '编辑前正文'
    });
    fixture.advance();
    const edited = await fixture.request(`/discussions/${root.id}/edit`, {
      auth: owner,
      method: 'POST',
      form: { title: '编辑后的标题', body: '编辑后的正文与 $x^2$。' }
    });
    expectRedirect(edited, new RegExp(`^/videos/${video.id}#discussion-${root.id}$`));
    const firstEdit = fixture.database.getDiscussion(root.id);
    assert.equal(firstEdit.title, '编辑后的标题');
    assert.equal(firstEdit.bodyMarkdown, '编辑后的正文与 $x^2$。');
    assert.equal(firstEdit.editCount, 1);
    assert.equal(firstEdit.editedAt, '2026-08-23T10:00:01.000Z');

    fixture.advance();
    await fixture.request(`/discussions/${root.id}/edit`, {
      auth: owner,
      method: 'POST',
      form: { title: firstEdit.title, body: firstEdit.bodyMarkdown }
    });
    assert.equal(fixture.database.getDiscussion(root.id).editCount, 1, '无变化提交不应增加修改次数');

    const leaf = fixture.insertDiscussion(owner, video, {
      title: '没有回复的讨论',
      body: '这条应被直接删除。'
    });
    const leafDeleted = await fixture.request(`/discussions/${leaf.id}/delete`, {
      auth: owner,
      method: 'POST',
      form: {}
    });
    expectRedirect(leafDeleted, `/videos/${video.id}#discussions`);
    assert.equal(fixture.database.getDiscussion(leaf.id), null);

    const reply = fixture.insertDiscussion(reader, video, {
      title: '保留下来的回复',
      body: '父讨论删除后我仍然存在。',
      parentId: root.id
    });
    fixture.database.setDiscussionVote(root.id, reader.user.id, 1, '2026-08-23T10:00:03.000Z');
    const rootDeleted = await fixture.request(`/discussions/${root.id}/delete`, {
      auth: owner,
      method: 'POST',
      form: {}
    });
    expectRedirect(rootDeleted, `/videos/${video.id}#discussions`);
    const tombstone = fixture.database.getDiscussion(root.id);
    assert.ok(tombstone.deletedAt);
    assert.equal(tombstone.title, null);
    assert.equal(tombstone.bodyMarkdown, '');
    assert.equal(tombstone.userId, null);
    assert.equal(tombstone.upvoteCount, 0);
    assert.equal(fixture.database.getDiscussion(reply.id).parentId, root.id);

    const detail = await fixture.request(`/videos/${video.id}`);
    const html = await detail.text();
    assert.match(html, /该讨论已由作者删除/);
    assert.match(html, /父讨论删除后我仍然存在/);
    assert.doesNotMatch(html, /编辑后的正文/);
  });

  await t.test('回复与稿件投票遵从偏好、自提醒排除和聚合规则，并可标记已读', async () => {
    const clearExisting = await fixture.request('/account/notifications/read-all', {
      auth: owner,
      method: 'POST',
      form: {}
    });
    expectRedirect(clearExisting, '/account/notifications');

    const video = await fixture.readyVideo(owner, { title: '通知测试稿件', cover: false });
    const topic = fixture.insertDiscussion(owner, video, {
      title: '等待回复的主题',
      body: '请在这里回复。'
    });

    const selfReply = await fixture.request(`/videos/${video.id}/discussions`, {
      auth: owner,
      method: 'POST',
      form: { parentId: String(topic.id), title: '自己的补充', body: '自己回复自己。' }
    });
    expectRedirect(selfReply, new RegExp(`#discussion-\\d+$`));
    assert.equal(fixture.database.raw.prepare('SELECT count(*) AS count FROM notifications WHERE recipient_user_id = ? AND is_read = 0').get(owner.user.id).count, 0);

    const reply = await fixture.request(`/videos/${video.id}/discussions`, {
      auth: reader,
      method: 'POST',
      form: { parentId: String(topic.id), title: '来自读者的回复', body: '这应生成一条回复通知。' }
    });
    expectRedirect(reply, new RegExp(`#discussion-\\d+$`));
    let notifications = fixture.database.raw.prepare('SELECT * FROM notifications WHERE recipient_user_id = ? AND is_read = 0 ORDER BY id').all(owner.user.id);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'reply');
    assert.equal(notifications[0].actor_user_id, reader.user.id);

    const preferences = await fixture.request('/account/settings/notifications', {
      auth: owner,
      method: 'POST',
      form: { videoVoteEnabled: 'on', systemEnabled: 'on' }
    });
    expectRedirect(preferences, '/account/settings?saved=notifications');
    const beforeDisabledReply = notifications.length;
    await fixture.request(`/videos/${video.id}/discussions`, {
      auth: secondReader,
      method: 'POST',
      form: { parentId: String(topic.id), title: '不提醒的回复', body: '回复偏好关闭后不应生成通知。' }
    });
    notifications = fixture.database.raw.prepare('SELECT * FROM notifications WHERE recipient_user_id = ? AND is_read = 0 ORDER BY id').all(owner.user.id);
    assert.equal(notifications.length, beforeDisabledReply);

    await fixture.request('/account/notifications/read-all', {
      auth: owner,
      method: 'POST',
      form: {}
    });
    await fixture.request(`/videos/${video.id}/vote`, {
      auth: owner,
      method: 'POST',
      form: { value: '1' },
      accept: 'application/json'
    });
    assert.equal(fixture.database.raw.prepare('SELECT count(*) AS count FROM notifications WHERE recipient_user_id = ? AND is_read = 0').get(owner.user.id).count, 0, '给自己的稿件投票不应提醒自己');

    for (const voter of [reader, secondReader]) {
      const vote = await fixture.request(`/videos/${video.id}/vote`, {
        auth: voter,
        method: 'POST',
        form: { value: '1' },
        accept: 'application/json'
      });
      assert.equal(vote.status, 200);
    }
    const aggregated = fixture.database.raw.prepare("SELECT * FROM notifications WHERE recipient_user_id = ? AND type = 'video_upvote' AND is_read = 0").get(owner.user.id);
    assert.ok(aggregated);
    assert.equal(aggregated.event_count, 2);

    const poll = await fixture.request('/account/notifications/poll?after=0', {
      auth: owner,
      accept: 'application/json'
    });
    assert.equal(poll.status, 200);
    const payload = await poll.json();
    assert.equal(payload.unreadCount, 2, '聚合通知的未读数按事件数量计算');
    const publicVoteNotice = payload.notifications.find((entry) => entry.type === 'video_upvote' && entry.count === 2);
    assert.ok(publicVoteNotice);
    assert.equal(Object.hasOwn(publicVoteNotice, 'actorUserId'), false, '投票通知不得泄露投票账号 ID');
    assert.equal(Object.hasOwn(publicVoteNotice, 'actorDisplayName'), false, '投票通知不得泄露投票者名称');
    assert.ok(payload.newItems.some((entry) => entry.id === aggregated.id));
    assert.equal(payload.cursor, aggregated.id);

    const unchangedPoll = await fixture.request(`/account/notifications/poll?after=${payload.cursor}`, {
      auth: owner,
      accept: 'application/json'
    });
    const unchangedPayload = await unchangedPoll.json();
    assert.deepEqual(unchangedPayload.newItems, []);
    assert.equal(unchangedPayload.cursor, payload.cursor);

    await fixture.request(`/videos/${video.id}/vote`, {
      auth: reader,
      method: 'POST',
      form: { value: '0' },
      accept: 'application/json'
    });
    fixture.advance();
    await fixture.request(`/videos/${video.id}/vote`, {
      auth: reader,
      method: 'POST',
      form: { value: '1' },
      accept: 'application/json'
    });
    const aggregatedPoll = await fixture.request(`/account/notifications/poll?after=${payload.cursor}`, {
      auth: owner,
      accept: 'application/json'
    });
    const aggregatedPayload = await aggregatedPoll.json();
    assert.deepEqual(aggregatedPayload.newItems, [], '同一未读通知的聚合更新不会伪装成新 ID');
    assert.equal(aggregatedPayload.cursor, payload.cursor);
    assert.equal(
      aggregatedPayload.items.find((entry) => entry.id === aggregated.id)?.count,
      2,
      '同一账号取消后重投不应刷高未读聚合数'
    );
    assert.equal(aggregatedPayload.unreadCount, 2);
    assert.equal(
      fixture.database.raw.prepare(`
        SELECT count(*) AS count FROM notification_vote_actors
        WHERE notification_id = ?
      `).get(aggregated.id).count,
      2,
      '聚合计数对应两个不同投票账号的净状态'
    );

    const readOne = await fixture.request(`/account/notifications/${aggregated.id}/read`, {
      auth: owner,
      method: 'POST',
      form: {},
      accept: 'application/json'
    });
    assert.ok([200, 303].includes(readOne.status));
    assert.equal(fixture.database.raw.prepare('SELECT is_read FROM notifications WHERE id = ?').get(aggregated.id).is_read, 1);

    await fixture.request('/account/settings/notifications', {
      auth: owner,
      method: 'POST',
      form: { replyEnabled: 'on', systemEnabled: 'on' }
    });
    await fixture.request(`/videos/${video.id}/vote`, {
      auth: reader,
      method: 'POST',
      form: { value: '0' },
      accept: 'application/json'
    });
    await fixture.request(`/videos/${video.id}/vote`, {
      auth: reader,
      method: 'POST',
      form: { value: '1' },
      accept: 'application/json'
    });
    assert.equal(fixture.database.raw.prepare('SELECT count(*) AS count FROM notifications WHERE recipient_user_id = ? AND is_read = 0').get(owner.user.id).count, 0, '投票提醒关闭后不产生新通知');
  });

  await t.test('注销要求密码、完整用户名和明确确认，并按两个内容选项处理', async () => {
    const retained = await fixture.register('retained_author', '保留内容作者');
    const retainedVideo = await fixture.readyVideo(retained, { title: '注销后保留的稿件', cover: false });
    const retainedDiscussion = fixture.insertDiscussion(retained, retainedVideo, {
      title: '注销后保留的讨论',
      body: '这条内容继续公开，但署名应匿名化。'
    });

    const missingConfirmation = await fixture.request('/account/delete', {
      auth: retained,
      method: 'POST',
      form: {
        currentPassword: retained.password,
        username: retained.username
      }
    });
    assert.equal(missingConfirmation.status, 400);
    assert.equal(fixture.database.getUserById(retained.user.id).deletedAt, null);

    const wrongUsername = await fixture.request('/account/delete', {
      auth: retained,
      method: 'POST',
      form: {
        currentPassword: retained.password,
        username: 'different_username',
        confirmDeletion: 'on'
      }
    });
    assert.equal(wrongUsername.status, 400);
    assert.equal(fixture.database.getUserById(retained.user.id).deletedAt, null);

    const retainedDeleted = await fixture.request('/account/delete', {
      auth: retained,
      method: 'POST',
      form: {
        currentPassword: retained.password,
        username: retained.username,
        confirmDeletion: 'on'
      }
    });
    expectRedirect(retainedDeleted, '/?accountDeleted=1');
    const retainedUser = fixture.database.getUserById(retained.user.id);
    assert.ok(retainedUser.deletedAt);
    assert.notEqual(retainedUser.status, 'active');
    assert.equal(fixture.database.getVideo(retainedVideo.id).deletedAt, null);
    assert.equal(fixture.database.getVideo(retainedVideo.id).accountDisplayName, '已注销用户');
    assert.equal(fixture.database.getDiscussion(retainedDiscussion.id).accountDisplayName, '已注销用户');
    assert.equal((await fixture.request(`/users/${retained.username}`)).status, 404);
    assert.equal((await fixture.login(retained.username, retained.password)).response.status, 401);

    const purged = await fixture.register('purged_author', '删除内容作者');
    const purgedVideo = await fixture.readyVideo(purged, { title: '随账号删除的稿件' });
    const root = fixture.insertDiscussion(purged, purgedVideo, {
      title: '有回复的待删除讨论',
      body: '注销时应变成墓碑。'
    });
    const child = fixture.insertDiscussion(reader, purgedVideo, {
      title: '其他用户的回复',
      body: '这条回复必须保留。',
      parentId: root.id
    });
    const leaf = fixture.insertDiscussion(purged, purgedVideo, {
      title: '无回复的待删除讨论',
      body: '注销时应直接删除。'
    });

    const purgedDeleted = await fixture.request('/account/delete', {
      auth: purged,
      method: 'POST',
      form: {
        currentPassword: purged.password,
        username: purged.username,
        confirmDeletion: 'on',
        deleteVideos: 'on',
        deleteDiscussions: 'on'
      }
    });
    expectRedirect(purgedDeleted, '/?accountDeleted=1');
    assert.ok(fixture.database.getUserById(purged.user.id).deletedAt);
    assert.ok(fixture.database.getVideo(purgedVideo.id).deletedAt);
    assert.equal(await missing(purgedVideo.mediaPath), true);
    assert.equal(await missing(purgedVideo.coverPath), true);
    assert.ok(fixture.database.getDiscussion(root.id).deletedAt);
    assert.equal(fixture.database.getDiscussion(root.id).bodyMarkdown, '');
    assert.equal(fixture.database.getDiscussion(leaf.id), null);
    assert.equal(fixture.database.getDiscussion(child.id).parentId, root.id);
  });
});
