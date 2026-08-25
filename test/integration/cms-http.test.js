import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp, startServer } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/database.js';

const PASSWORD = 'Correct-Horse-2026';
const REPORT_DESCRIPTION = '这是一段足够详细的举报说明，用来验证完整的治理 HTTP 工作流。';
const INVESTIGATION_DESCRIPTION = '这是一段足够详细的主动调查理由，用来验证私密媒体授权边界。';

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
  else assert.equal(response.headers.get('location'), location);
}

async function startFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cms-http-'));
  const databasePath = path.join(directory, 'cms.sqlite');
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
    CMS_REAUTH_MINUTES: '30',
    CMS_PRIVATE_MEDIA_GRANT_MINUTES: '15',
    REPORT_COOLDOWN_SECONDS: '30',
    APPEAL_WINDOW_DAYS: '30',
    CLIENT_IP_MODE: 'direct'
  }, directory);
  const database = openDatabase(databasePath);
  let timestamp = Date.parse('2026-08-25T02:00:00.000Z');
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

  async function register(username, displayName, password = PASSWORD) {
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
    return { username, password, cookies, response };
  }

  async function request(route, {
    auth,
    method = 'GET',
    form,
    csrf = true,
    headers: extraHeaders = {},
    redirect = 'manual'
  } = {}) {
    const headers = { ...extraHeaders };
    if (auth) headers.cookie = cookieHeader(auth.cookies);
    let body;
    if (form !== undefined) {
      const values = new URLSearchParams();
      if (csrf && auth) values.set('_csrf', auth.cookies.get('tongjian_csrf') ?? '');
      for (const [name, value] of Object.entries(form)) {
        if (value !== undefined && value !== null) values.set(name, String(value));
      }
      body = values;
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const response = await fetch(`${baseUrl}${route}`, { method, headers, body, redirect });
    if (auth) collectCookies(auth.cookies, response);
    return response;
  }

  async function reauthenticate(auth, next = '/cms') {
    return request('/cms/reauth', {
      auth,
      method: 'POST',
      form: { password: auth.password, next }
    });
  }

  async function readyVideo(owner, {
    id = crypto.randomUUID(),
    title = `治理测试视频-${id.slice(0, 6)}`,
    visibility = 'public'
  } = {}) {
    const storageName = `${id}.mp4`;
    const media = Buffer.from(`cms HTTP media ${id}`);
    await writeFile(path.join(config.videoStoragePath, storageName), media);
    database.insertVideo({
      id,
      title,
      creator: owner.displayName,
      description: 'CMS HTTP 集成测试作品',
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
      width: 320,
      height: 180,
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
      visibility,
      moderationStatus: 'visible',
      createdAt: new Date(timestamp).toISOString()
    });
    return { id, title, storageName, media };
  }

  function context(actorUserId, requestId) {
    return {
      actorUserId,
      requestId,
      createdAt: new Date(timestamp).toISOString()
    };
  }

  return {
    baseUrl,
    config,
    database,
    service: app.locals.governanceService,
    register,
    login,
    request,
    reauthenticate,
    readyVideo,
    context,
    nowIso() { return new Date(timestamp).toISOString(); },
    advance(milliseconds) { timestamp += milliseconds; }
  };
}

test('CMS HTTP：权限、治理命令、暂停账号与私密媒体授权边界', async (t) => {
  const fixture = await startFixture(t);
  const admin = await fixture.register('cms_admin', 'CMS 管理员');
  const moderator = await fixture.register('cms_moderator', 'CMS 审核员');
  const member = await fixture.register('cms_member', '普通成员');
  const owner = await fixture.register('cms_owner', '内容作者');
  const suspendTarget = await fixture.register('cms_suspended', '待暂停成员');

  fixture.service.grantAdministratorByUsername(admin.username, fixture.context(null, 'http-bootstrap-admin'));
  fixture.service.setUserRole({
    userId: moderator.user.id,
    role: 'moderator',
    expectedVersion: moderator.user.governanceVersion,
    publicReason: '授予治理工作所需的审核员角色。',
    internalNote: 'CMS HTTP 集成测试初始化。'
  }, fixture.context(admin.user.id, 'http-bootstrap-moderator'));

  const reportVideo = await fixture.readyVideo(owner, { id: 'cms-report-one', title: '第一条可举报视频' });
  const secondReportVideo = await fixture.readyVideo(owner, { id: 'cms-report-two', title: '第二条可举报视频' });
  const privateVideo = await fixture.readyVideo(owner, {
    id: 'cms-private-one', title: '第一条私密视频', visibility: 'private'
  });
  const otherPrivateVideo = await fixture.readyVideo(owner, {
    id: 'cms-private-two', title: '第二条私密视频', visibility: 'private'
  });

  await t.test('成员被拒绝；工作人员必须密码复核；审核员不能访问管理员页面', async () => {
    const memberCms = await fixture.request('/cms', { auth: member });
    assert.equal(memberCms.status, 403);

    const beforeReauth = await fixture.request('/cms', { auth: moderator });
    expectRedirect(beforeReauth, /^\/cms\/reauth\?next=/);

    const missingCsrf = await fixture.request('/cms/reauth', {
      auth: moderator,
      method: 'POST',
      csrf: false,
      form: { password: moderator.password, next: '/cms' }
    });
    assert.equal(missingCsrf.status, 403);

    const wrongPassword = await fixture.request('/cms/reauth', {
      auth: moderator,
      method: 'POST',
      form: { password: 'Wrong-Correct-Horse-2026', next: '/cms' }
    });
    assert.equal(wrongPassword.status, 401);

    const throttledPassword = await fixture.reauthenticate(moderator);
    assert.equal(throttledPassword.status, 429);
    assert.match(throttledPassword.headers.get('retry-after') || '', /^\d+$/);
    fixture.advance(1_100);

    expectRedirect(await fixture.reauthenticate(moderator), '/cms');
    const moderatorCms = await fixture.request('/cms', { auth: moderator });
    assert.equal(moderatorCms.status, 200);
    assert.equal(moderatorCms.headers.get('cache-control'), 'no-store');
    assert.match(moderatorCms.headers.get('x-robots-tag') || '', /noindex/);
    assert.equal((await fixture.request('/cms/users', { auth: moderator })).status, 403);

    const adminBeforeReauth = await fixture.request('/cms', { auth: admin });
    expectRedirect(adminBeforeReauth, /^\/cms\/reauth\?next=/);
    fixture.advance(1_100);
    expectRedirect(await fixture.reauthenticate(admin), '/cms');
    assert.equal((await fixture.request('/cms', { auth: admin })).status, 200);
    const adminUsers = await fixture.request('/cms/users', { auth: admin });
    assert.equal(adminUsers.status, 200);
    const adminUsersHtml = await adminUsers.text();
    assert.doesNotMatch(adminUsersHtml, new RegExp(`/cms/users/${admin.user.id}(?:[?\"/]|$)`));
    assert.match(adminUsersHtml, /href="\/account\/settings">账号设置/);

    const ownAdminDetail = await fixture.request(`/cms/users/${admin.user.id}`, { auth: admin });
    assert.equal(ownAdminDetail.status, 404);
    const ownAdminDetailHtml = await ownAdminDetail.text();
    assert.doesNotMatch(ownAdminDetailHtml, /首位或后续管理员的明确本地授权|system-cli/);

    const adminAudit = await fixture.request('/cms/audit', { auth: admin });
    assert.equal(adminAudit.status, 200);
    const adminAuditHtml = await adminAudit.text();
    assert.doesNotMatch(adminAuditHtml, /http-bootstrap-admin/);
  });

  let reportCase;
  await t.test('举报受用户/IP 限流，冷却后由未结案件唯一约束去重', async () => {
    const first = await fixture.request(`/videos/${reportVideo.id}/reports`, {
      auth: member,
      method: 'POST',
      form: { reasonCategory: 'spam_fraud', description: REPORT_DESCRIPTION }
    });
    expectRedirect(first, /^\/account\/reports\?created=\d+$/);
    reportCase = fixture.service.store.listUserReports(member.user.id, { limit: 10 }).items[0];
    assert.equal(reportCase.videoId, reportVideo.id);

    const limited = await fixture.request(`/videos/${secondReportVideo.id}/reports`, {
      auth: member,
      method: 'POST',
      form: { reasonCategory: 'other', description: REPORT_DESCRIPTION }
    });
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after') || '', /^\d+$/);

    fixture.advance(31_000);
    const duplicate = await fixture.request(`/videos/${reportVideo.id}/reports`, {
      auth: member,
      method: 'POST',
      form: { reasonCategory: 'spam_fraud', description: REPORT_DESCRIPTION }
    });
    assert.equal(duplicate.status, 409);
  });

  await t.test('关键 CMS 命令使用 PRG 303，缺少 CSRF 或旧版本会失败', async () => {
    const missingCsrf = await fixture.request(`/cms/cases/${reportCase.id}/claim`, {
      auth: moderator,
      method: 'POST',
      csrf: false,
      form: { expectedVersion: 0, internalReason: '开始核查举报。' }
    });
    assert.equal(missingCsrf.status, 403);

    const claimed = await fixture.request(`/cms/cases/${reportCase.id}/claim`, {
      auth: moderator,
      method: 'POST',
      form: { expectedVersion: 0, internalReason: '开始核查举报。' }
    });
    expectRedirect(claimed, `/cms/cases/${reportCase.id}?saved=claimed`);

    const staleClaim = await fixture.request(`/cms/cases/${reportCase.id}/claim`, {
      auth: moderator,
      method: 'POST',
      form: { expectedVersion: 0, internalReason: '使用旧页面重复认领。' }
    });
    assert.equal(staleClaim.status, 409);

    const hidden = await fixture.request(`/cms/videos/${reportVideo.id}/hide`, {
      auth: moderator,
      method: 'POST',
      form: {
        caseId: reportCase.id,
        expectedVersion: 0,
        publicReason: '视频正在接受规则核查。',
        internalNote: '举报内容需要进一步核实。'
      }
    });
    expectRedirect(hidden, `/cms/videos/${reportVideo.id}?saved=hide`);

    const staleHide = await fixture.request(`/cms/videos/${reportVideo.id}/hide`, {
      auth: moderator,
      method: 'POST',
      form: {
        caseId: reportCase.id,
        expectedVersion: 0,
        publicReason: '视频正在接受规则核查。',
        internalNote: '旧页面不应覆盖新状态。'
      }
    });
    assert.equal(staleHide.status, 409);
  });

  await t.test('私密媒体只能凭会话、案件和目标完全匹配的短时 grant 读取', async () => {
    const privateCase = fixture.service.createInvestigation({
      videoId: privateVideo.id,
      reasonCategory: 'privacy_copyright',
      description: INVESTIGATION_DESCRIPTION
    }, fixture.context(moderator.user.id, 'http-private-case'));
    const otherCase = fixture.service.createInvestigation({
      videoId: otherPrivateVideo.id,
      reasonCategory: 'other',
      description: INVESTIGATION_DESCRIPTION
    }, fixture.context(moderator.user.id, 'http-private-other-case'));
    fixture.service.claimCase({
      caseId: privateCase.id,
      expectedVersion: privateCase.version,
      internalReason: '认领案件后申请短时私密媒体访问'
    }, fixture.context(moderator.user.id, 'http-private-claim'));

    assert.equal((await fixture.request(`/videos/${privateVideo.id}/media`, { auth: moderator })).status, 404);
    assert.equal((await fixture.request(
      `/cms/videos/${privateVideo.id}/media?caseId=${privateCase.id}`,
      { auth: moderator }
    )).status, 404);

    const mismatch = await fixture.request(`/cms/cases/${otherCase.id}/media-grants`, {
      auth: moderator,
      method: 'POST',
      form: { expectedVersion: otherCase.version, videoId: privateVideo.id, reason: '案件目标不匹配时不能授权。' }
    });
    assert.equal(mismatch.status, 409);

    const granted = await fixture.request(`/cms/cases/${privateCase.id}/media-grants`, {
      auth: moderator,
      method: 'POST',
      form: { expectedVersion: 1, videoId: privateVideo.id, reason: '核查案件中的隐私与版权证据。' }
    });
    expectRedirect(granted, new RegExp(`^/cms/cases/${privateCase.id}\\?saved=media-granted&expires=`));

    const ranged = await fixture.request(
      `/cms/videos/${privateVideo.id}/media?caseId=${privateCase.id}`,
      { auth: moderator, headers: { range: 'bytes=0-3' } }
    );
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('cache-control'), 'private, no-store');
    assert.equal(ranged.headers.get('content-range'), `bytes 0-3/${privateVideo.media.length}`);
    assert.equal((await ranged.arrayBuffer()).byteLength, 4);

    assert.equal((await fixture.request(
      `/cms/videos/${privateVideo.id}/media?caseId=${otherCase.id}`,
      { auth: moderator }
    )).status, 404);

    fixture.advance(16 * 60 * 1000);
    assert.equal((await fixture.request(
      `/cms/videos/${privateVideo.id}/media?caseId=${privateCase.id}`,
      { auth: moderator }
    )).status, 404);
  });

  await t.test('暂停立即撤销旧会话；重新登录后仅保留公开浏览、安全操作与申诉', async () => {
    const suspended = await fixture.request(`/cms/users/${suspendTarget.user.id}/suspend`, {
      auth: admin,
      method: 'POST',
      form: {
        expectedVersion: suspendTarget.user.governanceVersion,
        publicReason: '账号因平台规则核查被临时暂停。',
        internalNote: 'HTTP 测试验证暂停账号的最小权限。'
      }
    });
    expectRedirect(suspended, `/cms/users/${suspendTarget.user.id}?saved=suspend`);

    const suspendAction = fixture.service.store.listUserGovernanceHistory(suspendTarget.user.id)
      .find((entry) => entry.action === 'user_suspend');
    assert.ok(suspendAction);

    const staleSuspend = await fixture.request(`/cms/users/${suspendTarget.user.id}/suspend`, {
      auth: admin,
      method: 'POST',
      form: {
        expectedVersion: 0,
        publicReason: '旧页面不应覆盖账号治理状态。',
        internalNote: '验证账号治理 CAS 冲突。'
      }
    });
    assert.equal(staleSuspend.status, 409);

    const oldSession = await fixture.request('/account/appeals', { auth: suspendTarget });
    expectRedirect(oldSession, /^\/login\?next=/);

    const relogin = await fixture.login(suspendTarget.username, suspendTarget.password);
    expectRedirect(relogin.response, '/');
    const restricted = relogin;
    assert.equal((await fixture.request('/', { auth: restricted })).status, 200);
    assert.equal((await fixture.request('/account/appeals', { auth: restricted })).status, 200);
    assert.equal((await fixture.request('/upload', { auth: restricted })).status, 403);
    assert.equal((await fixture.request('/account/profile', {
      auth: restricted,
      method: 'POST',
      form: { displayName: '不应保存的名称', bio: '不应保存的资料' }
    })).status, 403);

    const appeal = await fixture.request('/account/appeals', {
      auth: restricted,
      method: 'POST',
      form: {
        moderationActionId: suspendAction.id,
        reason: '我认为暂停决定遗漏了关键上下文，希望由另一名工作人员重新复核。'
      }
    });
    expectRedirect(appeal, /^\/account\/appeals\?created=\d+$/);

    const changedPassword = await fixture.request('/account/settings/password', {
      auth: restricted,
      method: 'POST',
      form: {
        currentPassword: suspendTarget.password,
        newPassword: 'New-Correct-Horse-2026',
        confirmPassword: 'New-Correct-Horse-2026'
      }
    });
    expectRedirect(changedPassword, '/account/settings?saved=password');
    expectRedirect(await fixture.request('/logout', {
      auth: restricted,
      method: 'POST',
      form: {}
    }), '/');
  });

  await t.test('工作人员本人内容与本人申诉不会泄露到 CMS 详情、列表或概览', async () => {
    const ownVideo = await fixture.readyVideo(moderator, {
      id: 'cms-moderator-owned',
      title: '审核员本人内容回避测试'
    });
    const ownDiscussion = fixture.database.insertDiscussion({
      videoId: secondReportVideo.id,
      userId: moderator.user.id,
      nickname: moderator.displayName,
      title: '审核员本人讨论回避测试',
      bodyMarkdown: '这是审核员本人发表、不能从 CMS 内部详情查看的讨论正文。',
      createdAt: fixture.nowIso()
    });
    assert.ok(ownDiscussion);

    const ownTargetCase = fixture.service.createInvestigation({
      videoId: ownVideo.id,
      reasonCategory: 'other',
      description: 'SELF_CASE_SECRET：这段主动调查说明不得展示给作为内容作者的工作人员。'
    }, fixture.context(admin.user.id, 'http-self-interest-case'));
    const claimed = fixture.service.claimCase({
      caseId: ownTargetCase.id,
      expectedVersion: ownTargetCase.version,
      internalReason: '由无利益冲突的管理员负责案件。'
    }, fixture.context(admin.user.id, 'http-self-interest-claim'));
    assert.equal(claimed.assigneeUserId, admin.user.id);
    fixture.service.moderateVideo({
      videoId: ownVideo.id,
      caseId: ownTargetCase.id,
      command: 'hide',
      expectedVersion: 0,
      publicReason: 'SELF_PUBLIC_REASON：该视频正在接受独立规则复核。',
      internalNote: 'SELF_ACTION_INTERNAL：这段内部证据不得向目标作者泄露。'
    }, fixture.context(admin.user.id, 'http-self-interest-hide'));
    const ownAction = fixture.service.store.listActionsForCase(ownTargetCase.id)
      .find((entry) => entry.action === 'video_hide');
    assert.ok(ownAction);
    const ownAppeal = fixture.service.submitAppeal({
      appellantUserId: moderator.user.id,
      moderationActionId: ownAction.id,
      reason: '我作为受影响作者申请由另一名工作人员独立复核这项视频治理决定。'
    }, fixture.context(moderator.user.id, 'http-self-interest-appeal'));

    for (const route of [
      `/cms/cases/${ownTargetCase.id}`,
      `/cms/videos/${ownVideo.id}`,
      `/cms/discussions/${ownDiscussion.id}`,
      `/cms/appeals/${ownAppeal.id}`
    ]) {
      const response = await fixture.request(route, { auth: moderator });
      assert.equal(response.status, 404, `${route} 应隐藏本人利益冲突目标的存在性`);
      const body = await response.text();
      assert.doesNotMatch(body, /SELF_CASE_SECRET|SELF_ACTION_INTERNAL/);
    }

    const casesResponse = await fixture.request('/cms/cases', { auth: moderator });
    const appealsResponse = await fixture.request('/cms/appeals', { auth: moderator });
    const dashboardResponse = await fixture.request('/cms', { auth: moderator });
    assert.equal(casesResponse.status, 200);
    assert.equal(appealsResponse.status, 200);
    assert.equal(dashboardResponse.status, 200);
    const casesHtml = await casesResponse.text();
    const appealsHtml = await appealsResponse.text();
    const dashboardHtml = await dashboardResponse.text();
    for (const html of [casesHtml, appealsHtml, dashboardHtml]) {
      assert.doesNotMatch(html, new RegExp(`/cms/cases/${ownTargetCase.id}(?:[?\"/]|$)`));
      assert.doesNotMatch(html, new RegExp(`/cms/appeals/${ownAppeal.id}(?:[?\"/]|$)`));
      assert.doesNotMatch(html, /SELF_CASE_SECRET|SELF_ACTION_INTERNAL/);
      assert.doesNotMatch(html, new RegExp(admin.displayName));
    }
    assert.doesNotMatch(dashboardHtml, new RegExp(`/cms/videos/${ownVideo.id}(?:[?\"/]|$)`));
    assert.match(dashboardHtml, /本人内容回避/);

    const videosHtml = await (await fixture.request('/cms/videos', { auth: moderator })).text();
    const discussionsHtml = await (await fixture.request('/cms/discussions', { auth: moderator })).text();
    assert.match(videosHtml, new RegExp(ownVideo.title));
    assert.doesNotMatch(videosHtml, new RegExp(`/cms/videos/${ownVideo.id}(?:[?\"/]|$)`));
    assert.doesNotMatch(discussionsHtml, new RegExp(`/cms/discussions/${ownDiscussion.id}(?:[?\"/]|$)`));

    const accountAppeals = await fixture.request('/account/appeals', { auth: moderator });
    assert.equal(accountAppeals.status, 200);
    const accountAppealsHtml = await accountAppeals.text();
    assert.match(accountAppealsHtml, /SELF_PUBLIC_REASON/);
    assert.doesNotMatch(accountAppealsHtml, /SELF_ACTION_INTERNAL|SELF_CASE_SECRET/);
  });

  await t.test('工作人员作为举报人时不能换用 CMS 身份处理同一目标或申诉', async () => {
    const reportedVideo = await fixture.readyVideo(owner, {
      id: 'cms-staff-reported',
      title: '工作人员举报人回避测试'
    });
    const reportResponse = await fixture.request(`/videos/${reportedVideo.id}/reports`, {
      auth: moderator,
      method: 'POST',
      form: {
        reasonCategory: 'other',
        description: 'STAFF_REPORT_SECRET：这段举报说明不得通过后台工作身份与内部证据合并查看。'
      }
    });
    expectRedirect(reportResponse, /^\/account\/reports\?created=\d+$/);
    const reportedCase = fixture.service.store.listUserReports(moderator.user.id, { limit: 20 }).items
      .find((item) => item.videoId === reportedVideo.id);
    assert.ok(reportedCase);

    const reporterClaim = await fixture.request(`/cms/cases/${reportedCase.id}/claim`, {
      auth: moderator,
      method: 'POST',
      form: { expectedVersion: 0, internalReason: '举报人不应能认领自己提交的案件。' }
    });
    assert.equal(reporterClaim.status, 403);

    const claimed = fixture.service.claimCase({
      caseId: reportedCase.id,
      expectedVersion: 0,
      internalReason: '由无举报人利益冲突的管理员负责。'
    }, fixture.context(admin.user.id, 'http-reporter-conflict-claim'));
    const reporterModeration = await fixture.request(`/cms/videos/${reportedVideo.id}/hide`, {
      auth: moderator,
      method: 'POST',
      form: {
        caseId: reportedCase.id,
        expectedVersion: 0,
        publicReason: '举报人不应能使用工作身份治理自己举报的目标。',
        internalNote: '这项伪造的治理写入必须被服务端拒绝。'
      }
    });
    assert.equal(reporterModeration.status, 403);
    fixture.service.moderateVideo({
      videoId: reportedVideo.id,
      caseId: reportedCase.id,
      command: 'hide',
      expectedVersion: 0,
      publicReason: 'STAFF_REPORT_ACTION_PUBLIC：该视频正在接受独立规则复核。',
      internalNote: 'STAFF_REPORT_ACTION_INTERNAL：举报人切换工作身份后不得看到该内部备注。'
    }, fixture.context(admin.user.id, 'http-reporter-conflict-hide'));
    const action = fixture.service.store.listActionsForCase(reportedCase.id)
      .find((entry) => entry.action === 'video_hide');
    assert.ok(action);
    const reporterConflictAppeal = fixture.service.submitAppeal({
      appellantUserId: owner.user.id,
      moderationActionId: action.id,
      reason: '我是受影响的作者，申请由与举报无关的工作人员独立复核这项决定。'
    }, fixture.context(owner.user.id, 'http-reporter-conflict-appeal'));
    const reporterAppealClaim = await fixture.request(`/cms/appeals/${reporterConflictAppeal.id}/claim`, {
      auth: moderator,
      method: 'POST',
      form: { expectedVersion: 0, internalReason: '举报人不应能复核由该举报产生的申诉。' }
    });
    assert.equal(reporterAppealClaim.status, 403);
    fixture.service.resolveCase({
      caseId: reportedCase.id,
      expectedVersion: claimed.version,
      resolution: 'violation_confirmed',
      publicExplanation: 'STAFF_REPORT_RESULT_PUBLIC：平台已完成调查并采取必要措施。',
      internalReason: 'STAFF_REPORT_RESOLUTION_INTERNAL：只能由无冲突工作人员查看。'
    }, fixture.context(admin.user.id, 'http-reporter-conflict-resolve'));

    for (const route of [
      `/cms/cases/${reportedCase.id}`,
      `/cms/videos/${reportedVideo.id}`,
      `/cms/appeals/${reporterConflictAppeal.id}`
    ]) {
      const response = await fixture.request(route, { auth: moderator });
      assert.equal(response.status, 404, `${route} 应隐藏举报人与工作人员双重身份`);
      assert.doesNotMatch(await response.text(), /STAFF_REPORT_ACTION_INTERNAL|STAFF_REPORT_RESOLUTION_INTERNAL/);
    }

    const listBodies = await Promise.all(['/cms/cases', '/cms/videos', '/cms/appeals', '/cms']
      .map(async (route) => {
        const response = await fixture.request(route, { auth: moderator });
        assert.equal(response.status, 200);
        return response.text();
      }));
    for (const html of listBodies) {
      assert.doesNotMatch(html, new RegExp(`/cms/cases/${reportedCase.id}(?:[?\"/]|$)`));
      assert.doesNotMatch(html, new RegExp(`/cms/videos/${reportedVideo.id}(?:[?\"/]|$)`));
      assert.doesNotMatch(html, new RegExp(`/cms/appeals/${reporterConflictAppeal.id}(?:[?\"/]|$)`));
      assert.doesNotMatch(html, /STAFF_REPORT_SECRET|STAFF_REPORT_ACTION_INTERNAL|STAFF_REPORT_RESOLUTION_INTERNAL/);
    }

    const accountReports = await fixture.request('/account/reports', { auth: moderator });
    assert.equal(accountReports.status, 200);
    const accountReportsHtml = await accountReports.text();
    assert.match(accountReportsHtml, /STAFF_REPORT_RESULT_PUBLIC/);
    assert.doesNotMatch(accountReportsHtml, /STAFF_REPORT_ACTION_INTERNAL|STAFF_REPORT_RESOLUTION_INTERNAL/);
  });

  await t.test('角色撤销后，同一已复核会话立即失去 CMS 权限', async () => {
    assert.equal((await fixture.request('/cms', { auth: moderator })).status, 200);
    const currentModerator = fixture.database.getUserById(moderator.user.id);
    const revoked = await fixture.request(`/cms/users/${moderator.user.id}/role`, {
      auth: admin,
      method: 'POST',
      form: {
        role: 'member',
        expectedVersion: currentModerator.governanceVersion,
        publicReason: '审核任务结束，撤销工作人员角色。',
        internalNote: '验证角色变化对既有后台会话即时生效。'
      }
    });
    expectRedirect(revoked, `/cms/users/${moderator.user.id}?saved=role`);
    assert.equal((await fixture.request('/cms', { auth: moderator })).status, 403);
  });
});
