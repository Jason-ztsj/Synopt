import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ejs from 'ejs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viewsRoot = path.join(projectRoot, 'views');
const timestamp = '2026-08-25T08:30:00.000Z';

const reportReasons = Object.freeze({
  spam_fraud: '垃圾内容或欺诈',
  harassment_hate: '骚扰或仇恨',
  illegal_dangerous: '违法或危险内容',
  privacy_copyright: '隐私或版权',
  impersonation_metadata: '冒名或误导性元数据',
  other: '其他'
});

const administrator = Object.freeze({
  id: 'admin-view-user',
  username: 'admin_view',
  displayName: '页面测试管理员',
  role: 'administrator',
  status: 'active'
});

const moderator = Object.freeze({
  id: 'moderator-view-user',
  username: 'moderator_view',
  displayName: '页面测试审核员',
  role: 'moderator',
  status: 'active'
});

const member = Object.freeze({
  id: 'member-view-user',
  username: 'member_view',
  displayName: '页面测试成员',
  role: 'member',
  status: 'active'
});

const pagination = Object.freeze({
  page: 1,
  total: 1,
  totalPages: 1,
  hasPrevious: false,
  hasNext: false
});

const commonLocals = Object.freeze({
  currentUser: administrator,
  currentPath: '/cms',
  cmsCurrentPath: '/cms',
  csrfToken: 'cms-render-csrf-token',
  flash: '',
  error: '',
  requestId: 'cms-render-request-id',
  reportReasons,
  userRoles: ['member', 'moderator', 'administrator'],
  notificationUnreadCount: 0,
  categoryTree: [],
  popularTags: [],
  categories: []
});

const moderationCase = Object.freeze({
  id: 31,
  source: 'report',
  reporterUserId: member.id,
  reporterUsername: member.username,
  videoId: 'private-video',
  videoTitle: '私密页面测试视频',
  targetAuthorUserId: member.id,
  reasonCategory: 'privacy_copyright',
  description: '这是一段足够完整的举报说明，用于验证案件页面不会泄露内部证据。',
  status: 'in_review',
  assigneeUserId: moderator.id,
  assigneeName: moderator.displayName,
  version: 2,
  createdAt: timestamp,
  updatedAt: timestamp
});

const video = Object.freeze({
  id: 'private-video',
  user_id: member.id,
  owner_username: member.username,
  owner_display_name: member.displayName,
  title: '私密页面测试视频',
  creator: '页面测试创作者',
  description: '用于 CMS 模板测试的视频说明。',
  category_name: '科学与技术',
  visibility: 'private',
  validation_status: 'ready_with_warnings',
  validation_warning_count: 1,
  moderation_status: 'visible',
  moderation_version: 4,
  media_type: 'video/mp4',
  storage_name: 'private-video.mp4',
  deleted_at: null,
  withdrawn_at: null,
  created_at: timestamp,
  tags: [{ slug: 'view-test', name: '页面测试' }]
});

const discussion = Object.freeze({
  id: 42,
  video_id: video.id,
  video_title: video.title,
  user_id: member.id,
  owner_username: member.username,
  owner_display_name: member.displayName,
  title: '页面测试讨论',
  body_markdown: '这是完整讨论正文，用于验证 CMS 会保留治理上下文。',
  parent_id: null,
  moderation_status: 'hidden',
  moderation_version: 3,
  deleted_at: null,
  upvote_count: 2,
  downvote_count: 0,
  created_at: timestamp,
  depth: 0
});

const moderationAction = Object.freeze({
  id: 51,
  caseId: moderationCase.id,
  actorUserId: moderator.id,
  actorName: moderator.displayName,
  affectedUserId: member.id,
  videoId: video.id,
  action: 'video_hide',
  publicReason: '该内容正在根据隐私规则接受审核，暂时不向公众显示。',
  internalNote: '页面测试内部审核备注。',
  before: { moderationStatus: 'visible', moderationVersion: 3 },
  after: { moderationStatus: 'hidden', moderationVersion: 4 },
  beforeVersion: 3,
  afterVersion: 4,
  createdAt: timestamp
});

const appeal = Object.freeze({
  id: 61,
  moderationActionId: moderationAction.id,
  appellantUserId: member.id,
  appellantUsername: member.username,
  reason: '这是足够完整的申诉理由，请另一名工作人员复核原有治理决定。',
  status: 'pending',
  result: null,
  outcome: null,
  version: 0,
  createdAt: timestamp,
  action: moderationAction.action,
  actionActorUserId: moderator.id,
  actionPublicReason: moderationAction.publicReason,
  actionCreatedAt: timestamp,
  videoId: video.id,
  discussionId: null,
  targetUserId: null,
  stateConflict: false
});

const governedAccount = Object.freeze({
  id: member.id,
  username: member.username,
  display_name: member.displayName,
  bio: '用于账号治理页面的成员资料。',
  role: 'member',
  status: 'active',
  governance_version: 2,
  video_count: 1,
  discussion_count: 1,
  deleted_at: null,
  created_at: timestamp
});

async function render(view, locals = {}) {
  return ejs.renderFile(path.join(viewsRoot, `${view}.ejs`), {
    ...commonLocals,
    ...locals
  });
}

test('所有 CMS 路由页面都能用控制器实际形状的 locals 完整渲染', async () => {
  const routeViews = [
    ['cms/reauth', { nextPath: '/cms' }],
    ['cms/dashboard', { dashboard: { cases: [moderationCase], videos: [video], actions: [moderationAction] } }],
    ['cms/cases', { cases: [moderationCase], filters: {}, pagination }],
    ['cms/case-detail', {
      caseRecord: moderationCase,
      target: video,
      notes: [],
      actions: [moderationAction],
      staff: [moderator, administrator],
      mediaGrant: null
    }],
    ['cms/videos', { videos: [video], filters: {}, pagination }],
    ['cms/video-detail', { video, cases: [moderationCase], actions: [moderationAction] }],
    ['cms/discussions', { discussions: [discussion], filters: {}, pagination }],
    ['cms/discussion-detail', {
      discussion,
      contextDiscussions: [discussion],
      cases: [{ ...moderationCase, videoId: null, discussionId: discussion.id }],
      actions: []
    }],
    ['cms/appeals', { appeals: [appeal], filters: {}, pagination }],
    ['cms/appeal-detail', { appeal, originalAction: moderationAction }],
    ['cms/users', { users: [governedAccount], filters: {}, pagination }],
    ['cms/user-detail', {
      account: governedAccount,
      videos: [video],
      discussions: [discussion],
      actions: [],
      sessions: []
    }],
    ['cms/taxonomy', {
      categories: [{ id: 1, slug: 'science', name: '科学', sort_order: 0, is_active: 1, updated_at: timestamp }],
      tags: [{ id: 1, slug: 'test', name: '测试', is_active: 1, updated_at: timestamp }]
    }],
    ['cms/tasks', { tasks: { videos: [], deletions: [] } }],
    ['cms/audit', { events: [], filters: {}, pagination }],
    ['cms/error', { status: 409, message: '并发状态冲突', requestId: 'route-render-409' }]
  ];

  for (const [view, locals] of routeViews) {
    const html = await render(view, locals);
    assert.match(html, /<!doctype html>/i, `${view} 应输出完整 HTML 文档`);
    assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/, `${view} 应禁止索引`);
    assert.match(html, /<main\b/, `${view} 应包含主要内容区域`);
  }
});

test('CMS 概览、列表、再认证和错误页可按真实路由 locals 渲染', async () => {
  const dashboard = await render('cms/dashboard', {
    dashboard: {
      openCaseCount: 1,
      pendingAppealCount: 1,
      validationFailedCount: 1,
      deletionFailedCount: 1,
      pendingCases: [moderationCase],
      failedValidations: [{ ...video, validation_status: 'validation_failed', validationError: 'validator unavailable' }],
      failedDeletions: [{ id: 81, kind: 'video', storageName: 'queued-video.mp4', attemptCount: 2, lastError: 'busy' }],
      recentContent: [video, { ...discussion, type: 'discussion' }],
      recentActions: [moderationAction]
    }
  });
  assert.match(dashboard, /技术验证和规则审核始终保持为两条独立状态线/);
  assert.match(dashboard, /href="\/cms\/audit"/);
  assert.match(dashboard, /validator unavailable/);

  const cases = await render('cms/cases', {
    cases: [moderationCase],
    filters: { status: 'in_review', target: 'video', mine: true },
    pagination
  });
  assert.match(cases, /href="\/cms\/cases\/31"/);
  assert.match(cases, /只看由我处理/);

  const videos = await render('cms/videos', {
    videos: [video],
    filters: { validationStatus: 'ready_with_warnings', visibility: 'private', moderationStatus: 'visible' },
    pagination
  });
  assert.match(videos, /私密页面测试视频/);
  assert.match(videos, /CMS 不能把技术验证直接改为通过/);

  const discussions = await render('cms/discussions', {
    discussions: [discussion],
    filters: { moderationStatus: 'hidden', kind: 'topic' },
    pagination
  });
  assert.match(discussions, /作者主动删除与平台治理是两种不可互换的状态/);
  assert.match(discussions, /href="\/cms\/discussions\/42"/);

  const appeals = await render('cms/appeals', {
    appeals: [appeal],
    filters: { status: 'pending' },
    pagination
  });
  assert.match(appeals, /href="\/cms\/appeals\/61"/);
  assert.match(appeals, /动作 #51/);
  assert.match(appeals, /private-video/);

  const users = await render('cms/users', {
    users: [governedAccount, { ...administrator, created_at: timestamp, video_count: 0, discussion_count: 0 }],
    filters: { status: 'active', role: 'member', q: member.username },
    pagination
  });
  assert.match(users, /CMS V1 不提供将账号设为 disabled 的动作/);
  assert.match(users, /href="\/cms\/users\/member-view-user"/);
  assert.doesNotMatch(users, /href="\/cms\/users\/admin-view-user"/);
  assert.match(users, /href="\/account\/settings">账号设置/);

  const audit = await render('cms/audit', {
    events: [{
      id: 91,
      actorName: administrator.displayName,
      actorUsername: administrator.username,
      actorUserId: administrator.id,
      action: 'video.hide',
      objectType: 'video',
      objectId: video.id,
      requestId: 'request-audit-91',
      before: { moderationStatus: 'visible' },
      after: { moderationStatus: 'hidden' },
      metadata: { reason: '审计页面真实字段测试' },
      createdAt: timestamp
    }],
    filters: { actor: administrator.username, action: 'video.hide', objectType: 'video', objectId: video.id },
    pagination
  });
  assert.match(audit, /后台没有删除审计事件的入口/);
  assert.match(audit, /request-audit-91/);
  assert.match(audit, /页面测试管理员/);
  assert.match(audit, /审计页面真实字段测试/);
  assert.match(audit, /&#34;moderationStatus&#34;: &#34;hidden&#34;/);
  assert.doesNotMatch(audit, /action="[^\"]*(?:delete|remove)[^\"]*"/i);

  const reauth = await render('cms/reauth', { nextPath: '/cms/cases/31' });
  assert.match(reauth, /action="\/cms\/reauth"/);
  assert.match(reauth, /name="password"[^>]*autocomplete="current-password"/);
  assert.match(reauth, /name="next" value="\/cms\/cases\/31"/);

  const error = await render('cms/error', {
    status: 409,
    title: '状态冲突',
    message: '记录已被另一名工作人员更新。',
    requestId: 'request-conflict-409'
  });
  assert.match(error, /请求编号：<code>request-conflict-409<\/code>/);
  assert.match(error, /状态冲突/);
});

test('案件详情与视频详情保留版本、理由和私密媒体授权边界', async () => {
  const reporterStaff = {
    id: 'reporter-staff-user', username: 'reporter_staff', displayName: '工作人员举报人',
    role: 'moderator', status: 'active'
  };
  const caseHtml = await render('cms/case-detail', {
    currentUser: moderator,
    caseRecord: { ...moderationCase, reporterUserId: reporterStaff.id },
    target: video,
    notes: [{ id: 1, authorName: moderator.displayName, body: '只追加的案件内部备注。', createdAt: timestamp }],
    actions: [moderationAction],
    staff: [moderator, administrator, reporterStaff, { ...member, role: 'moderator' }],
    mediaGrant: null
  });
  assert.match(caseHtml, /未取得当前案件短时授权前只显示必要元数据/);
  assert.match(caseHtml, /action="\/cms\/cases\/31\/media-grants"/);
  assert.match(caseHtml, /name="expectedVersion" value="2"/);
  assert.match(caseHtml, /name="publicExplanation"[^>]*minlength="20"/);
  assert.match(caseHtml, /备注只追加，不会展示给举报人、作者或公众/);
  assert.doesNotMatch(caseHtml, /<option value="member-view-user"/);
  assert.doesNotMatch(caseHtml, /<option value="reporter-staff-user"/);
  assert.doesNotMatch(caseHtml, /\/videos\/private-video\/media/);

  const videoHtml = await render('cms/video-detail', {
    currentUser: moderator,
    video,
    cases: [moderationCase],
    actions: [moderationAction]
  });
  assert.match(videoHtml, /私密媒体已遮蔽/);
  assert.match(videoHtml, /已有未结案件/);
  assert.doesNotMatch(videoHtml, /action="\/cms\/cases\/investigations"/);
  assert.match(videoHtml, /name="expectedVersion" value="4"/);
  assert.match(videoHtml, /name="caseId"[^>]*required/);
  assert.doesNotMatch(videoHtml, /<source src="\/videos\/private-video\/media"/);
  assert.doesNotMatch(videoHtml, /href="\/cms\/users\/member-view-user"/);
  assert.doesNotMatch(videoHtml, /href="\/cms\/tasks/);
  assert.doesNotMatch(videoHtml, /action="[^\"]*(?:validation|ready|delete)[^\"]*"/i);

  const investigationHtml = await render('cms/video-detail', {
    currentUser: moderator,
    video,
    cases: [],
    actions: []
  });
  assert.match(investigationHtml, /action="\/cms\/cases\/investigations"/);
  assert.match(investigationHtml, /隐私或版权/);

  const hiddenPublicVideo = { ...video, visibility: 'public', moderation_status: 'hidden' };
  const hiddenCaseHtml = await render('cms/case-detail', {
    currentUser: moderator,
    caseRecord: { ...moderationCase, targetVisibility: 'public', targetModerationStatus: 'hidden' },
    target: hiddenPublicVideo,
    notes: [],
    actions: [moderationAction],
    staff: [moderator, administrator],
    mediaGrant: null
  });
  assert.match(hiddenCaseHtml, /action="\/cms\/cases\/31\/media-grants"/);
  assert.doesNotMatch(hiddenCaseHtml, /<source src="\/videos\/private-video\/media"/);

  const hiddenVideoHtml = await render('cms/video-detail', {
    currentUser: moderator,
    video: hiddenPublicVideo,
    cases: [moderationCase],
    actions: [moderationAction]
  });
  assert.match(hiddenVideoHtml, /私密媒体已遮蔽/);
  assert.doesNotMatch(hiddenVideoHtml, /<source src="\/videos\/private-video\/media"/);
});

test('讨论详情显示上下文，作者墓碑没有恢复或治理写入口', async () => {
  const html = await render('cms/discussion-detail', {
    currentUser: moderator,
    discussion,
    contextDiscussions: [discussion, {
      ...discussion,
      id: 43,
      parent_id: discussion.id,
      user_id: moderator.id,
      body_markdown: '上下文中的回复。',
      depth: 1,
      moderation_status: 'visible'
    }],
    cases: [{ ...moderationCase, videoId: null, discussionId: discussion.id }],
    actions: [{ ...moderationAction, videoId: null, discussionId: discussion.id, action: 'discussion_hide' }]
  });
  assert.match(html, /完整上下文/);
  assert.match(html, /action="\/cms\/discussions\/42\/restore"/);
  assert.match(html, /name="expectedVersion" value="3"/);
  assert.doesNotMatch(html, /href="\/cms\/users\/member-view-user"/);
  assert.match(html, /#43 · 本人内容回避/);
  assert.doesNotMatch(html, /href="\/cms\/discussions\/43"/);

  const tombstone = await render('cms/discussion-detail', {
    discussion: {
      ...discussion,
      user_id: null,
      owner_username: null,
      owner_display_name: null,
      title: null,
      body_markdown: '',
      deleted_at: timestamp
    },
    contextDiscussions: [],
    cases: [],
    actions: []
  });
  assert.match(tombstone, /作者删除不可逆/);
  assert.match(tombstone, /CMS 不提供恢复入口/);
  assert.doesNotMatch(tombstone, /action="\/cms\/discussions\/42\/(?:hide|remove|restore)"/);
});

test('申诉详情先认领，再由指定复核人使用统一复核命令', async () => {
  const pendingHtml = await render('cms/appeal-detail', {
    appeal,
    originalAction: moderationAction,
    target: { ...video, moderation_status: 'hidden', moderation_version: 4 },
    reviewConflict: false,
    uniqueAdministratorException: false,
    stateConflict: false,
    appealWindowDays: 30
  });
  assert.match(pendingHtml, /动作 #51/);
  assert.match(pendingHtml, /该内容正在根据隐私规则接受审核/);
  assert.match(pendingHtml, /href="\/cms\/videos\/private-video"/);
  assert.match(pendingHtml, /action="\/cms\/appeals\/61\/claim"/);
  assert.match(pendingHtml, /name="internalReason"[^>]*minlength="5"/);
  assert.doesNotMatch(pendingHtml, /action="\/cms\/appeals\/61\/review"/);

  const reviewHtml = await render('cms/appeal-detail', {
    appeal: {
      ...appeal,
      status: 'in_review',
      reviewerUserId: administrator.id,
      reviewerName: administrator.displayName,
      version: 1
    },
    originalAction: moderationAction,
    target: { ...video, moderation_status: 'hidden', moderation_version: 4 },
    staff: [moderator, administrator],
    reviewConflict: false,
    uniqueAdministratorException: false,
    stateConflict: false,
    appealWindowDays: 30
  });
  assert.match(reviewHtml, /action="\/cms\/appeals\/61\/review"/);
  assert.match(reviewHtml, /name="result" value="upheld"/);
  assert.match(reviewHtml, /name="result" value="overturned"/);
  assert.match(reviewHtml, /name="publicExplanation"[^>]*minlength="20"/);
  assert.match(reviewHtml, /name="expectedVersion" value="1"/);
  assert.doesNotMatch(reviewHtml, /name="expectedTargetVersion"/);
});

test('申诉冲突只能人工选择原状态或当前状态，并可安全转交', async () => {
  const otherModerator = {
    id: 'other-reviewer', username: 'other_reviewer', displayName: '另一名审核员',
    role: 'moderator', status: 'active'
  };
  const conflicted = {
    ...appeal,
    status: 'in_review',
    reviewerUserId: administrator.id,
    reviewerName: administrator.displayName,
    version: 2,
    hasStateConflict: true,
    stateConflict: true
  };
  const html = await render('cms/appeal-detail', {
    appeal: conflicted,
    originalAction: moderationAction,
    target: { ...video, moderation_status: 'removed', moderation_version: 5 },
    staff: [administrator, moderator, otherModerator],
    reviewConflict: false,
    selfInterestConflict: false,
    uniqueAdministratorException: false,
    stateConflict: true,
    appealWindowDays: 30
  });
  assert.match(html, /action="\/cms\/appeals\/61\/resolve-conflict"/);
  assert.match(html, /name="expectedTargetVersion" value="5"/);
  assert.match(html, /name="targetStatus" value="removed"/);
  assert.match(html, /name="targetStatus" value="visible"/);
  assert.doesNotMatch(html, /name="targetStatus" value="hidden"/);
  assert.match(html, /action="\/cms\/appeals\/61\/review"/);
  assert.match(html, /name="result" value="upheld"/);
  assert.doesNotMatch(html, /name="result" value="overturned"/);
  assert.match(html, /action="\/cms\/appeals\/61\/transfer"/);
  assert.match(html, /value="other-reviewer"/);
  assert.doesNotMatch(html, /value="moderator-view-user"/);

  const deletedTargetHtml = await render('cms/appeal-detail', {
    appeal: conflicted,
    originalAction: moderationAction,
    target: { ...video, moderation_status: 'removed', moderation_version: 5, deleted_at: timestamp },
    staff: [administrator, otherModerator],
    reviewConflict: false,
    selfInterestConflict: false,
    uniqueAdministratorException: false,
    stateConflict: true,
    appealWindowDays: 30
  });
  assert.match(deletedTargetHtml, /只能保留当前状态，不能伪造恢复/);
  assert.match(deletedTargetHtml, /name="targetStatus" value="removed"/);
  assert.doesNotMatch(deletedTargetHtml, /name="targetStatus" value="visible"/);
});

test('工作人员不能认领自己的申诉，唯一管理员例外也不适用', async () => {
  const html = await render('cms/appeal-detail', {
    currentUser: moderator,
    appeal: { ...appeal, appellantUserId: moderator.id, appellantUsername: moderator.username },
    originalAction: { ...moderationAction, actorUserId: administrator.id, actorName: administrator.displayName },
    target: { ...video, moderation_status: 'hidden', moderation_version: 4 },
    reviewConflict: true,
    selfInterestConflict: true,
    uniqueAdministratorException: false,
    stateConflict: false,
    appealWindowDays: 30
  });
  assert.match(html, /不能复核自己的申诉/);
  assert.match(html, /唯一管理员例外不适用于本人申诉/);
  assert.match(html, /type="submit" disabled aria-disabled="true">认领复核/);
  assert.doesNotMatch(html, /action="\/cms\/appeals\/61\/review"/);
});

test('账号详情保护当前管理员并使用领域命令字段', async () => {
  const account = {
    ...administrator,
    governance_version: 7,
    bio: '当前登录的管理员。',
    created_at: timestamp,
    deleted_at: null
  };
  const html = await render('cms/user-detail', {
    account,
    videos: [video],
    discussions: [discussion],
    actions: [{ ...moderationAction, videoId: null, userId: administrator.id, action: 'user_role_change' }],
    sessions: [{ id: 1, createdAt: timestamp, expiresAt: '2026-09-25T08:30:00.000Z', cmsVerifiedAt: timestamp }],
    isSelf: true,
    isLastAdministrator: true
  });
  assert.match(html, /不能暂停或降级当前登录的自己/);
  assert.match(html, /action="\/cms\/users\/admin-view-user\/suspend"/);
  assert.match(html, /name="expectedVersion" value="7"/);
  assert.match(html, /action="\/cms\/users\/admin-view-user\/role"/);
  assert.match(html, /name="publicReason"[^>]*minlength="20"/);
  assert.match(html, /name="internalNote"[^>]*minlength="5"/);
  assert.match(html, /action="\/cms\/users\/admin-view-user\/sessions\/revoke"/);
  assert.match(html, /name="internalReason"[^>]*minlength="10"/);
  assert.match(html, /type="submit" disabled aria-disabled="true">暂停并撤销全部会话/);
});

test('任务页仅为安全重试提供表单，且不包含直接通过或物理删除入口', async () => {
  const html = await render('cms/tasks', {
    tasks: {
      videos: [{
        ...video,
        user_id: administrator.id,
        validation_status: 'validation_failed',
        validation_started_at: '2026-08-25T08:20:00.000Z',
        validated_at: timestamp,
        validation_error: 'worker failed'
      }],
      deletions: [{
        id: 81,
        kind: 'video',
        storage_name: 'queued-video.mp4',
        attempt_count: 3,
        next_attempt_at: timestamp,
        updated_at: timestamp,
        last_error: 'worker failed'
      }]
    }
  });
  assert.match(html, /action="\/cms\/tasks\/videos\/private-video\/retry"/);
  assert.match(html, /name="expectedValidatedAt" value="2026-08-25T08:30:00.000Z"/);
  assert.match(html, /name="expectedValidationStartedAt" value="2026-08-25T08:20:00.000Z"/);
  assert.doesNotMatch(html, /href="\/cms\/videos\/private-video"/);
  assert.match(html, /本人内容回避/);
  assert.match(html, /action="\/cms\/tasks\/deletions\/81\/retry"/);
  assert.match(html, /name="expectedUpdatedAt" value="2026-08-25T08:30:00.000Z"/);
  assert.equal((html.match(/name="internalReason"/g) || []).length, 2);
  assert.match(html, /不能将视频直接标记为 ready/);
  assert.match(html, /不能在 Web 请求中物理删除媒体文件/);
  assert.doesNotMatch(html, /action="[^\"]*(?:mark-ready|physical-delete|delete-file)[^\"]*"/i);
});

test('分类与标签页可渲染且合并、停用均保留审计理由', async () => {
  const html = await render('cms/taxonomy', {
    categories: [{
      id: 1,
      parent_id: null,
      slug: 'science',
      name: '科学与技术',
      description: '科学分类',
      sort_order: 10,
      is_active: 1,
      updated_at: timestamp
    }],
    tags: [{
      id: 11,
      slug: 'view-test',
      name: '页面测试',
      is_active: 1,
      merged_into_id: null,
      updated_at: timestamp
    }, {
      id: 12,
      slug: 'canonical-test',
      name: '规范标签',
      is_active: 1,
      merged_into_id: null,
      updated_at: timestamp
    }]
  });
  assert.match(html, /slug（不可修改）/);
  assert.match(html, /action="\/cms\/taxonomy\/categories"/);
  assert.match(html, /action="\/cms\/taxonomy\/tags\/11\/merge"/);
  assert.match(html, /name="expectedUpdatedAt" value="2026-08-25T08:30:00.000Z"/);
  assert.match(html, /name="internalReason"/);
});

test('审核员导航不会渲染管理员专属入口', async () => {
  const html = await render('cms/dashboard', {
    currentUser: moderator,
    dashboard: {
      pendingCases: [],
      failedValidations: [{ ...video, user_id: moderator.id, validation_status: 'validation_failed' }],
      failedDeletions: [],
      recentContent: [
        { ...video, user_id: moderator.id },
        { ...discussion, user_id: moderator.id, type: 'discussion' }
      ],
      recentActions: []
    }
  });
  const navigation = html.match(/<aside class="cms-sidebar"[\s\S]*?<\/aside>/)?.[0] || '';
  assert.match(navigation, /href="\/cms\/cases"/);
  assert.match(navigation, /href="\/cms\/appeals"/);
  assert.doesNotMatch(navigation, /href="\/cms\/(?:users|taxonomy|tasks|audit)"/);
  assert.match(html, /本人内容回避/);
  assert.doesNotMatch(html, /href="\/cms\/videos\/private-video"/);
  assert.doesNotMatch(html, /href="\/cms\/discussions\/42"/);
});

test('账号举报和申诉页只展示公开结果，并使用受限写入表单', async () => {
  const accountLocals = {
    currentUser: member,
    currentPath: '/account/reports',
    account: member,
    reportReasons,
    pagination,
    createdId: 31
  };
  const reports = await render('account-reports', {
    ...accountLocals,
    reports: [{
      ...moderationCase,
      resolution: 'violation_confirmed',
      publicExplanation: '平台确认内容违反隐私规则，已采取必要措施。'
    }]
  });
  assert.match(reports, /内部备注、工作人员身份与敏感证据不会公开/);
  assert.match(reports, /隐私或版权/);
  assert.match(reports, /平台确认内容违反隐私规则/);
  assert.doesNotMatch(reports, /页面测试内部审核备注/);

  const appeals = await render('account-appeals', {
    ...accountLocals,
    currentPath: '/account/appeals',
    appealWindowDays: 30,
    decisions: [{
      id: 61,
      action: 'user_role',
      publicReason: '你的平台角色已经变更；这里展示完整公开说明。',
      createdAt: timestamp,
      targetTitle: null,
      appealId: null
    }],
    appealableActions: [moderationAction],
    appeals: [{ ...appeal, publicExplanation: null }]
  });
  assert.match(appeals, /审核动作发生后 30 天内可以申诉/);
  assert.match(appeals, /涉及我的治理决定/);
  assert.match(appeals, /你的平台角色已经变更；这里展示完整公开说明/);
  assert.doesNotMatch(appeals, /页面测试内部审核备注/);
  assert.match(appeals, /action="\/account\/appeals"/);
  assert.match(appeals, /name="moderationActionId" value="51"/);
  assert.match(appeals, /name="reason" minlength="20" maxlength="2000" required/);
});
