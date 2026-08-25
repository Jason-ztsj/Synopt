import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express from 'express';

import { verifyPassword } from './auth.js';
import { createCmsAuth, isCmsReauthenticationFresh } from './cms-auth.js';
import { AppError } from './errors.js';
import { REPORT_REASONS, USER_ROLES } from './governance.js';
import { DiscussionRateLimiter } from './rate-limit.js';

function integer(value, name = '编号') {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AppError(`${name}无效`, 404, 'NOT_FOUND');
  return parsed;
}

function pageNumber(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function pagination(result, page) {
  return {
    page,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / result.limit)),
    hasPrevious: page > 1,
    hasNext: page * result.limit < result.total
  };
}

function filterQueryString(query) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key === 'page' || typeof value !== 'string' || value === '') continue;
    parameters.set(key, value);
  }
  return parameters.toString();
}

function discussionContext(rows) {
  const children = new Map();
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    const parentId = row.parentId ?? row.parent_id ?? null;
    const key = parentId !== null && byId.has(parentId) ? parentId : null;
    const entries = children.get(key) ?? [];
    entries.push(row);
    children.set(key, entries);
  }
  const flattened = [];
  const append = (parentId, depth) => {
    for (const row of children.get(parentId) ?? []) {
      flattened.push({ ...row, depth });
      append(row.id, depth + 1);
    }
  };
  append(null, 0);
  return flattened;
}

function redactConflictedDiscussion(discussion) {
  return {
    ...discussion,
    nickname: '已隔离内容',
    userId: null,
    user_id: null,
    accountUsername: null,
    account_username: null,
    accountDisplayName: null,
    account_display_name: null,
    accountAvatarStorageName: null,
    account_avatar_storage_name: null,
    title: '利益冲突内容已隐藏',
    bodyMarkdown: '该讨论因工作人员利益冲突不可查看。',
    body_markdown: '该讨论因工作人员利益冲突不可查看。',
    upvoteCount: 0,
    downvoteCount: 0,
    viewerVote: 0,
    moderationStatus: 'conflict_redacted',
    moderation_status: 'conflict_redacted',
    governanceConflictRedacted: true
  };
}

function checked(value) {
  return value === true || value === '1' || value === 'on' || value === 'true';
}

function rangeForHeader(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return false;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}

function videoFilePath(config, storageName) {
  if (typeof storageName !== 'string' || path.basename(storageName) !== storageName) {
    throw new AppError('媒体存储记录无效', 500, 'INVALID_MEDIA_RECORD');
  }
  return path.join(config.videoStoragePath, storageName);
}

export function createCmsRouter(options) {
  const {
    database,
    service,
    config,
    assertCsrf,
    now = () => Date.now(),
    reauthLimiter = new DiscussionRateLimiter({ cooldownSeconds: config.authCooldownSeconds, now }),
    getClientKey = (request) => request.ip
  } = options;
  const router = express.Router();
  const auth = createCmsAuth({ config, now });
  const context = (request) => ({
    actorUserId: request.currentUser.id,
    requestId: request.requestId,
    createdAt: new Date(now()).toISOString()
  });
  const flashMessages = {
    claimed: '已认领。', transferred: '已转交。', note: '内部备注已追加。', resolved: '结论已提交。',
    hidden: '内容已隐藏。', hide: '内容已隐藏。', removed: '内容已移除。', remove: '内容已移除。',
    visible: '内容已恢复。', restore: '内容已恢复。', upheld: '申诉决定已维持。',
    overturned: '原决定已撤销。', conflict: '检测到后续治理动作，未覆盖当前状态。',
    'appeal-transferred': '申诉已转交。', 'conflict-resolved': '申诉状态冲突已人工解决。',
    'media-granted': '已授予本会话短时媒体访问。', 'category-created': '分类已创建。',
    'category-updated': '分类已更新。', 'tag-created': '标签已创建。', 'tag-updated': '标签已更新。',
    'tag-merged': '标签已合并，旧链接将重定向。', 'video-retry': '视频已重新排入验证队列。',
    'deletion-retry': '删除任务已安排立即重试。', role: '账号角色已更新。',
    suspend: '账号已暂停且旧会话已撤销。', sessions: '账号会话已撤销。'
  };
  const baseLocals = (request, extra = {}) => {
    const currentPath = request.originalUrl.split('?')[0];
    const saved = typeof request.query.saved === 'string' ? request.query.saved : '';
    return {
    currentPath,
    cmsCurrentPath: currentPath,
    reportReasons: REPORT_REASONS,
    userRoles: USER_ROLES,
    flash: flashMessages[saved] ?? (saved ? '操作已完成。' : ''),
    error: '',
    ...extra
  };
  };

  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    response.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  router.use(auth.requireCmsRole);

  router.get('/reauth', (request, response) => {
    const nextPath = auth.safeNext(request.query.next);
    if (isCmsReauthenticationFresh(request.authSession, now(), config.cmsReauthMs)) {
      response.redirect(303, nextPath);
      return;
    }
    response.render('cms/reauth', baseLocals(request, {
      pageTitle: '后台密码复核', nextPath, reauthMinutes: config.cmsReauthMinutes
    }));
  });

  router.post('/reauth', async (request, response, next) => {
    const nextPath = auth.safeNext(request.body?.next);
    try {
      assertCsrf(request);
      const limiterKeys = [
        `cms-reauth:user:${request.currentUser.id}`,
        `cms-reauth:ip:${getClientKey(request)}`
      ];
      const limits = limiterKeys.map((key) => reauthLimiter.check(key));
      if (limits.some((limit) => !limit.allowed)) {
        const retryAfterSeconds = Math.max(...limits.map((limit) => limit.retryAfterSeconds));
        response.set('Retry-After', String(retryAfterSeconds));
        response.status(429).render('cms/reauth', baseLocals(request, {
          pageTitle: '后台密码复核', nextPath, reauthMinutes: config.cmsReauthMinutes,
          error: `操作得有点快，请在 ${retryAfterSeconds} 秒后再试。`
        }));
        return;
      }
      for (const key of limiterKeys) reauthLimiter.consume(key);
      const account = database.getUserById(request.currentUser.id);
      if (!account || !await verifyPassword(request.body?.password, account.passwordHash)) {
        response.status(401).render('cms/reauth', baseLocals(request, {
          pageTitle: '后台密码复核', nextPath, reauthMinutes: config.cmsReauthMinutes,
          error: '密码不正确'
        }));
        return;
      }
      service.markCmsReauthenticated({ sessionTokenHash: request.authSession.tokenHash }, context(request));
      response.redirect(303, nextPath);
    } catch (error) {
      next(error);
    }
  });

  router.use(auth.requireCmsReauthentication);

  router.get('/', (request, response, next) => {
    try {
      response.render('cms/dashboard', baseLocals(request, {
        pageTitle: '治理工作台',
        dashboard: service.store.dashboard({
          includeAdministrative: request.currentUser.role === 'administrator',
          viewerUserId: request.currentUser.id
        })
      }));
    } catch (error) { next(error); }
  });

  router.get('/cases', (request, response, next) => {
    try {
      const page = pageNumber(request.query.page);
      const result = service.store.listCases({
        status: request.query.status,
        target: request.query.target,
        assigneeUserId: request.query.mine === '1' ? request.currentUser.id : null,
        excludeTargetAuthorUserId: request.currentUser.id,
        excludeReporterUserId: request.currentUser.id,
        limit: 25,
        offset: (page - 1) * 25
      });
      response.render('cms/cases', baseLocals(request, {
        pageTitle: '案件', cases: result.items, pagination: pagination(result, page),
        paginationQuery: filterQueryString(request.query),
        filters: { status: request.query.status ?? '', target: request.query.target ?? '', mine: request.query.mine === '1' }
      }));
    } catch (error) { next(error); }
  });

  router.get('/cases/:id', (request, response, next) => {
    try {
      const caseRecord = service.store.getCase(integer(request.params.id, '案件编号'));
      if (!caseRecord) throw new AppError('找不到案件', 404, 'CASE_NOT_FOUND');
      if (
        service.store.hasTargetStake(
          request.currentUser.id,
          caseRecord.videoId,
          caseRecord.discussionId
        )
        || service.store.hasTargetReporterConflict(
          request.currentUser.id,
          caseRecord.videoId,
          caseRecord.discussionId
        )
      ) {
        throw new AppError('找不到案件', 404, 'CASE_NOT_FOUND');
      }
      const target = caseRecord.videoId
        ? service.store.getVideo(caseRecord.videoId)
        : service.store.getDiscussion(caseRecord.discussionId);
      const grant = caseRecord.videoId
        ? service.store.getMediaGrant(
          request.authSession.tokenHash,
          caseRecord.id,
          caseRecord.videoId,
          new Date(now()).toISOString()
        )
        : null;
      response.render('cms/case-detail', baseLocals(request, {
        pageTitle: `案件 #${caseRecord.id}`,
        caseRecord,
        target,
        notes: service.store.listCaseNotes(caseRecord.id),
        actions: service.store.listActionsForCase(caseRecord.id),
        staff: service.store.listStaff().filter((person) => (
          !service.store.hasTargetStake(person.id, caseRecord.videoId, caseRecord.discussionId)
          && !service.store.hasTargetReporterConflict(
            person.id,
            caseRecord.videoId,
            caseRecord.discussionId
          )
        )),
        mediaGrant: grant
      }));
    } catch (error) { next(error); }
  });

  router.post('/cases/investigations', (request, response, next) => {
    try {
      assertCsrf(request);
      const created = service.createInvestigation({
        videoId: request.body?.videoId,
        discussionId: request.body?.discussionId,
        reasonCategory: request.body?.reasonCategory,
        description: request.body?.description
      }, context(request));
      response.redirect(303, `/cms/cases/${created.id}`);
    } catch (error) { next(error); }
  });

  router.post('/cases/:id/claim', (request, response, next) => {
    try {
      assertCsrf(request);
      service.claimCase({
        caseId: request.params.id, expectedVersion: request.body?.expectedVersion,
        internalReason: request.body?.internalReason
      }, context(request));
      response.redirect(303, `/cms/cases/${request.params.id}?saved=claimed`);
    } catch (error) { next(error); }
  });

  router.post('/cases/:id/transfer', (request, response, next) => {
    try {
      assertCsrf(request);
      service.transferCase({
        caseId: request.params.id, expectedVersion: request.body?.expectedVersion,
        assigneeUserId: request.body?.assigneeUserId, internalReason: request.body?.internalReason
      }, context(request));
      response.redirect(303, `/cms/cases/${request.params.id}?saved=transferred`);
    } catch (error) { next(error); }
  });

  router.post('/cases/:id/notes', (request, response, next) => {
    try {
      assertCsrf(request);
      service.addCaseNote({
        caseId: request.params.id,
        expectedVersion: request.body?.expectedVersion,
        body: request.body?.body
      }, context(request));
      response.redirect(303, `/cms/cases/${request.params.id}?saved=note`);
    } catch (error) { next(error); }
  });

  router.post('/cases/:id/resolve', (request, response, next) => {
    try {
      assertCsrf(request);
      service.resolveCase({
        caseId: request.params.id, expectedVersion: request.body?.expectedVersion,
        resolution: request.body?.resolution, publicExplanation: request.body?.publicExplanation,
        internalReason: request.body?.internalReason
      }, context(request));
      response.redirect(303, `/cms/cases/${request.params.id}?saved=resolved`);
    } catch (error) { next(error); }
  });

  router.post('/cases/:id/media-grants', (request, response, next) => {
    try {
      assertCsrf(request);
      const grant = service.grantPrivateMedia({
        caseId: request.params.id, expectedVersion: request.body?.expectedVersion,
        videoId: request.body?.videoId,
        sessionTokenHash: request.authSession.tokenHash, reason: request.body?.reason
      }, context(request));
      response.redirect(303, `/cms/cases/${request.params.id}?saved=media-granted&expires=${encodeURIComponent(grant.expiresAt)}`);
    } catch (error) { next(error); }
  });

  router.get('/videos', (request, response, next) => {
    try {
      const page = pageNumber(request.query.page);
      const result = service.store.listVideos({
        validationStatus: request.query.validationStatus ?? request.query.validation,
        visibility: request.query.visibility,
        moderationStatus: request.query.moderationStatus ?? request.query.moderation,
        excludeReportedByUserId: request.currentUser.id,
        query: request.query.q,
        limit: 25, offset: (page - 1) * 25
      });
      response.render('cms/videos', baseLocals(request, {
        pageTitle: '视频治理', videos: result.items, pagination: pagination(result, page),
        paginationQuery: filterQueryString(request.query),
        filters: request.query
      }));
    } catch (error) { next(error); }
  });

  router.get('/videos/:id', (request, response, next) => {
    try {
      const storedVideo = service.store.getVideo(request.params.id);
      if (!storedVideo) throw new AppError('找不到视频', 404, 'VIDEO_NOT_FOUND');
      if (service.store.hasTargetStake(request.currentUser.id, storedVideo.id, null)) {
        throw new AppError('找不到视频', 404, 'VIDEO_NOT_FOUND');
      }
      if (service.store.hasTargetReporterConflict(request.currentUser.id, storedVideo.id, null)) {
        throw new AppError('找不到视频', 404, 'VIDEO_NOT_FOUND');
      }
      const video = { ...storedVideo, ...database.getVideo(storedVideo.id) };
      const cases = service.store.listCases({ videoId: video.id, limit: 100 }).items;
      response.render('cms/video-detail', baseLocals(request, {
        pageTitle: video.title, video, cases,
        actions: service.store.listActionsForTarget('video', video.id)
      }));
    } catch (error) { next(error); }
  });

  for (const command of ['hide', 'remove', 'restore']) {
    router.post(`/videos/:id/${command}`, (request, response, next) => {
      try {
        assertCsrf(request);
        service.moderateVideo({
          videoId: request.params.id, command, caseId: request.body?.caseId,
          expectedVersion: request.body?.expectedVersion,
          publicReason: request.body?.publicReason, internalNote: request.body?.internalNote
        }, context(request));
        response.redirect(303, `/cms/videos/${request.params.id}?saved=${command}`);
      } catch (error) { next(error); }
    });
  }

  const servePrivateMedia = async (request, response, next) => {
    try {
      const caseId = integer(request.query.caseId, '案件编号');
      const nowIso = new Date(now()).toISOString();
      const grant = service.store.getMediaGrant(request.authSession.tokenHash, caseId, request.params.id, nowIso);
      if (!grant) throw new AppError('找不到已授权的媒体', 404, 'CMS_MEDIA_GRANT_NOT_FOUND');
      const video = service.store.getVideo(request.params.id);
      if (!video || video.deleted_at !== null) throw new AppError('找不到媒体', 404, 'MEDIA_NOT_FOUND');
      if (!['ready', 'ready_with_warnings'].includes(video.validation_status)) {
        throw new AppError('媒体尚未通过技术验证', 409, 'MEDIA_NOT_READY');
      }
      const filePath = videoFilePath(config, video.storage_name);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new AppError('媒体文件不可用', 404, 'MEDIA_NOT_FOUND');
      const requestedRange = rangeForHeader(request.get('range'), fileStat.size);
      response.set({
        'Accept-Ranges': 'bytes', 'Content-Type': video.media_type,
        'Cache-Control': 'private, no-store'
      });
      if (requestedRange === false) {
        response.status(416).set({ 'Content-Range': `bytes */${fileStat.size}`, 'Content-Length': '0' }).end();
        return;
      }
      if (requestedRange) {
        response.status(206).set({
          'Content-Range': `bytes ${requestedRange.start}-${requestedRange.end}/${fileStat.size}`,
          'Content-Length': String(requestedRange.length)
        });
        if (request.method === 'HEAD') { response.end(); return; }
        await pipeline(createReadStream(filePath, { start: requestedRange.start, end: requestedRange.end }), response);
        return;
      }
      response.status(200).set('Content-Length', String(fileStat.size));
      if (request.method === 'HEAD') { response.end(); return; }
      await pipeline(createReadStream(filePath), response);
    } catch (error) {
      if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE' && (request.aborted || response.destroyed)) return;
      if (error?.code === 'ENOENT') next(new AppError('媒体文件不可用', 404, 'MEDIA_NOT_FOUND'));
      else next(error);
    }
  };
  router.route('/videos/:id/media').get(servePrivateMedia).head(servePrivateMedia);

  router.get('/discussions', (request, response, next) => {
    try {
      const page = pageNumber(request.query.page);
      const result = service.store.listDiscussions({
        moderationStatus: request.query.moderationStatus ?? request.query.moderation,
        kind: request.query.kind,
        excludeReportedByUserId: request.currentUser.id,
        excludeStakeholderUserId: request.currentUser.id,
        query: request.query.q,
        limit: 25, offset: (page - 1) * 25
      });
      response.render('cms/discussions', baseLocals(request, {
        pageTitle: '讨论治理', discussions: result.items,
        pagination: pagination(result, page), paginationQuery: filterQueryString(request.query),
        filters: request.query
      }));
    } catch (error) { next(error); }
  });

  router.get('/discussions/:id', (request, response, next) => {
    try {
      const id = integer(request.params.id, '讨论编号');
      const storedDiscussion = service.store.getDiscussion(id);
      if (!storedDiscussion) throw new AppError('找不到讨论', 404, 'DISCUSSION_NOT_FOUND');
      if (service.store.hasTargetStake(request.currentUser.id, null, id)) {
        throw new AppError('找不到讨论', 404, 'DISCUSSION_NOT_FOUND');
      }
      if (service.store.hasTargetReporterConflict(request.currentUser.id, null, id)) {
        throw new AppError('找不到讨论', 404, 'DISCUSSION_NOT_FOUND');
      }
      const discussion = { ...storedDiscussion, ...database.getDiscussion(id) };
      const cases = service.store.listCases({ discussionId: id, limit: 100 }).items;
      const conflictedIds = new Set(service.store.listDiscussionConflictIds(
        storedDiscussion.video_id,
        request.currentUser.id
      ));
      const contextRows = database.listDiscussions(storedDiscussion.video_id)
        .map((row) => conflictedIds.has(row.id) ? redactConflictedDiscussion(row) : row);
      response.render('cms/discussion-detail', baseLocals(request, {
        pageTitle: `讨论 #${id}`, discussion,
        contextDiscussions: discussionContext(contextRows), cases,
        actions: service.store.listActionsForTarget('discussion', id)
      }));
    } catch (error) { next(error); }
  });

  for (const command of ['hide', 'remove', 'restore']) {
    router.post(`/discussions/:id/${command}`, (request, response, next) => {
      try {
        assertCsrf(request);
        service.moderateDiscussion({
          discussionId: request.params.id, command, caseId: request.body?.caseId,
          expectedVersion: request.body?.expectedVersion,
          publicReason: request.body?.publicReason, internalNote: request.body?.internalNote
        }, context(request));
        response.redirect(303, `/cms/discussions/${request.params.id}?saved=${command}`);
      } catch (error) { next(error); }
    });
  }

  router.get('/appeals', (request, response, next) => {
    try {
      const page = pageNumber(request.query.page);
      const result = service.store.listAppeals({
        status: request.query.status,
        target: request.query.target,
        assignment: request.query.assignment,
        reviewerUserId: request.currentUser.id,
        includeAccountActions: request.currentUser.role === 'administrator',
        excludeAppellantUserId: request.currentUser.id,
        excludeTargetStakeUserId: request.currentUser.id,
        excludeActionCaseReporterUserId: request.currentUser.id,
        excludeAffectedReporterUserId: request.currentUser.id,
        query: request.query.q,
        limit: 25, offset: (page - 1) * 25
      });
      response.render('cms/appeals', baseLocals(request, {
        pageTitle: '申诉复核', appeals: result.items,
        pagination: pagination(result, page), paginationQuery: filterQueryString(request.query),
        filters: request.query
      }));
    } catch (error) { next(error); }
  });

  router.get('/appeals/:id', (request, response, next) => {
    try {
      const appeal = service.store.getAppeal(integer(request.params.id, '申诉编号'));
      if (!appeal) throw new AppError('找不到申诉', 404, 'APPEAL_NOT_FOUND');
      if (
        String(appeal.appellantUserId || '') === String(request.currentUser.id)
        || service.store.hasTargetStake(
          request.currentUser.id,
          appeal.videoId,
          appeal.discussionId
        )
        || service.store.hasTargetReporterConflict(
          request.currentUser.id,
          appeal.videoId,
          appeal.discussionId
        )
        || (appeal.targetUserId && service.store.hasUserReporterConflict(
          request.currentUser.id,
          appeal.targetUserId
        ))
      ) {
        throw new AppError('找不到申诉', 404, 'APPEAL_NOT_FOUND');
      }
      const moderationAction = service.store.getAction(appeal.moderationActionId);
      if (!moderationAction) throw new AppError('找不到原审核动作', 404, 'ACTION_NOT_FOUND');
      if (moderationAction.action === 'user_suspend' && request.currentUser.role !== 'administrator') {
        throw new AppError('账号治理申诉仅限管理员查看', 403, 'ADMINISTRATOR_REQUIRED');
      }
      const target = moderationAction.videoId
        ? service.store.getVideo(moderationAction.videoId)
        : moderationAction.discussionId
          ? service.store.getDiscussion(moderationAction.discussionId)
          : service.store.getUser(moderationAction.userId);
      const accountOnly = moderationAction.action === 'user_suspend';
      const selfInterestConflict = appeal.appellantUserId === request.currentUser.id;
      const originalActorConflict = moderationAction.actorUserId === request.currentUser.id;
      const reviewConflict = selfInterestConflict || originalActorConflict;
      const uniqueAdministratorException = originalActorConflict
        && !selfInterestConflict
        && request.currentUser.role === 'administrator'
        && service.store.activeAdministratorCount() === 1
        && service.store.activeAlternativeReviewerCount(
          accountOnly,
          moderationAction.actorUserId,
          appeal.appellantUserId,
          appeal.videoId,
          appeal.discussionId,
          appeal.targetUserId
        ) === 0;
      response.render('cms/appeal-detail', baseLocals(request, {
        pageTitle: `申诉 #${appeal.id}`, appeal,
        moderationAction, originalAction: moderationAction, target,
        staff: service.store.listStaff().filter((person) => person.status === 'active'
          && !service.store.hasTargetStake(person.id, appeal.videoId, appeal.discussionId)
          && !service.store.hasTargetReporterConflict(person.id, appeal.videoId, appeal.discussionId)
          && !(appeal.targetUserId && service.store.hasUserReporterConflict(
            person.id,
            appeal.targetUserId
          ))),
        reviewConflict, selfInterestConflict, uniqueAdministratorException,
        stateConflict: appeal.hasStateConflict,
        appealWindowDays: config.appealWindowDays
      }));
    } catch (error) { next(error); }
  });

  router.post('/appeals/:id/claim', (request, response, next) => {
    try {
      assertCsrf(request);
      service.claimAppeal({
        appealId: request.params.id,
        expectedVersion: request.body?.expectedVersion,
        internalReason: request.body?.internalReason ?? request.body?.reason
      }, context(request));
      response.redirect(303, `/cms/appeals/${request.params.id}?saved=claimed`);
    } catch (error) { next(error); }
  });

  router.post('/appeals/:id/transfer', (request, response, next) => {
    try {
      assertCsrf(request);
      service.transferAppeal({
        appealId: request.params.id,
        expectedVersion: request.body?.expectedVersion,
        reviewerUserId: request.body?.assigneeUserId,
        internalReason: request.body?.internalReason
      }, context(request));
      response.redirect(303, `/cms/appeals/${request.params.id}?saved=appeal-transferred`);
    } catch (error) { next(error); }
  });

  router.post('/appeals/:id/resolve-conflict', (request, response, next) => {
    try {
      assertCsrf(request);
      service.resolveAppealConflict({
        appealId: request.params.id,
        expectedVersion: request.body?.expectedVersion,
        expectedTargetVersion: request.body?.expectedTargetVersion,
        targetStatus: request.body?.targetStatus,
        publicExplanation: request.body?.publicExplanation,
        internalNote: request.body?.internalNote
      }, context(request));
      response.redirect(303, `/cms/appeals/${request.params.id}?saved=conflict-resolved`);
    } catch (error) { next(error); }
  });

  const reviewAppeal = (request, response, next) => {
    try {
      assertCsrf(request);
      const result = service.reviewAppeal({
        appealId: request.params.id, expectedVersion: request.body?.expectedVersion,
        result: request.body?.result ?? request.body?.outcome,
        publicExplanation: request.body?.publicExplanation ?? request.body?.publicReason,
        internalNote: request.body?.internalNote
      }, context(request));
      const suffix = result.conflict ? 'conflict' : result.appeal.result;
      response.redirect(303, `/cms/appeals/${request.params.id}?saved=${suffix}`);
    } catch (error) { next(error); }
  };

  router.post('/appeals/:id/review', reviewAppeal);
  router.post('/appeals/:id/resolve', reviewAppeal);

  router.get('/users', auth.requireAdministrator, (request, response, next) => {
    try {
      const page = pageNumber(request.query.page);
      const result = service.store.listUsers({
        role: request.query.role, status: request.query.status, query: request.query.q,
        excludeReporterConflictUserId: request.currentUser.id,
        limit: 25, offset: (page - 1) * 25
      });
      response.render('cms/users', baseLocals(request, {
        pageTitle: '账号治理', users: result.items,
        pagination: pagination(result, page), paginationQuery: filterQueryString(request.query),
        filters: request.query
      }));
    } catch (error) { next(error); }
  });

  router.get('/users/:id', auth.requireAdministrator, (request, response, next) => {
    try {
      const account = service.store.getUser(request.params.id);
      if (!account || account.deleted_at !== null) throw new AppError('找不到账号', 404, 'USER_NOT_FOUND');
      if (String(account.id) === String(request.currentUser.id)) {
        throw new AppError('找不到账号', 404, 'USER_NOT_FOUND');
      }
      if (service.store.hasUserReporterConflict(request.currentUser.id, account.id)) {
        throw new AppError('找不到账号', 404, 'USER_NOT_FOUND');
      }
      const videos = database.listUserVideos(account.id, { limit: 20 });
      const discussions = database.listUserDiscussions(account.id, { limit: 20 });
      response.render('cms/user-detail', baseLocals(request, {
        pageTitle: `账号 @${account.username}`, account,
        videos: videos.items,
        videoTotal: videos.total,
        discussions: discussions.items,
        discussionTotal: discussions.total,
        actions: service.store.listUserGovernanceHistory(account.id),
        sessions: service.store.listSessionsForUser(account.id, new Date(now()).toISOString()),
        isSelf: account.id === request.currentUser.id,
        isLastAdministrator: account.role === 'administrator'
          && account.status === 'active'
          && service.store.activeAdministratorCount() === 1
      }));
    } catch (error) { next(error); }
  });

  for (const command of ['suspend', 'restore']) {
    router.post(`/users/:id/${command}`, auth.requireAdministrator, (request, response, next) => {
      try {
        assertCsrf(request);
        service.changeUserStatus({
          userId: request.params.id, command, expectedVersion: request.body?.expectedVersion,
          publicReason: request.body?.publicReason, internalNote: request.body?.internalNote
        }, context(request));
        response.redirect(303, `/cms/users/${request.params.id}?saved=${command}`);
      } catch (error) { next(error); }
    });
  }

  router.post('/users/:id/role', auth.requireAdministrator, (request, response, next) => {
    try {
      assertCsrf(request);
      service.setUserRole({
        userId: request.params.id, role: request.body?.role,
        expectedVersion: request.body?.expectedVersion,
        publicReason: request.body?.publicReason ?? request.body?.reason,
        internalNote: request.body?.internalNote ?? request.body?.reason
      }, context(request));
      response.redirect(303, `/cms/users/${request.params.id}?saved=role`);
    } catch (error) { next(error); }
  });

  router.post('/users/:id/sessions/revoke', auth.requireAdministrator, (request, response, next) => {
    try {
      assertCsrf(request);
      service.revokeUserSessions({
        userId: request.params.id, expectedVersion: request.body?.expectedVersion,
        internalReason: request.body?.internalReason ?? request.body?.reason
      }, context(request));
      response.redirect(303, `/cms/users/${request.params.id}?saved=sessions`);
    } catch (error) { next(error); }
  });

  router.get('/taxonomy', auth.requireAdministrator, (request, response, next) => {
    try {
      response.render('cms/taxonomy', baseLocals(request, {
        pageTitle: '分类与标签', categories: service.store.listAllCategories(),
        tags: service.store.listAllTags()
      }));
    } catch (error) { next(error); }
  });

  router.post(['/taxonomy/categories', '/taxonomy/categories/create'], auth.requireAdministrator, (request, response, next) => {
    try {
      assertCsrf(request);
      service.createCategory({
        ...request.body, parentId: request.body?.parentId || null,
        internalReason: request.body?.internalReason ?? request.body?.reason
      }, context(request));
      response.redirect(303, '/cms/taxonomy?saved=category-created');
    } catch (error) { next(error); }
  });

  router.post(['/taxonomy/categories/:id', '/taxonomy/categories/:id/update'], auth.requireAdministrator, (request, response, next) => {
    try {
      assertCsrf(request);
      const current = service.store.getCategory(integer(request.params.id, '分类编号'));
      if (!current) throw new AppError('找不到分类', 404, 'CATEGORY_NOT_FOUND');
      service.updateCategory({
        ...request.body, categoryId: request.params.id,
        parentId: request.body?.parentId || null,
        isActive: request.body?.isActive === undefined ? current.is_active === 1 : checked(request.body?.isActive),
        internalReason: request.body?.internalReason ?? request.body?.reason
      }, context(request));
      response.redirect(303, '/cms/taxonomy?saved=category-updated');
    } catch (error) { next(error); }
  });

  for (const [command, isActive] of [['activate', true], ['deactivate', false]]) {
    router.post(`/taxonomy/categories/:id/${command}`, auth.requireAdministrator, (request, response, next) => {
      try {
        assertCsrf(request);
        const current = service.store.getCategory(integer(request.params.id, '分类编号'));
        if (!current) throw new AppError('找不到分类', 404, 'CATEGORY_NOT_FOUND');
        service.updateCategory({
          categoryId: current.id,
          expectedUpdatedAt: request.body?.expectedUpdatedAt,
          name: current.name,
          description: current.description ?? '',
          parentId: current.parent_id,
          sortOrder: current.sort_order,
          isActive,
          internalReason: request.body?.internalReason ?? request.body?.reason
        }, context(request));
        response.redirect(303, `/cms/taxonomy?saved=category-${command}d`);
      } catch (error) { next(error); }
    });
  }

  router.post(['/taxonomy/tags', '/taxonomy/tags/create'], auth.requireAdministrator, (request, response, next) => {
    try {
      assertCsrf(request);
      service.createTag({
        ...request.body,
        internalReason: request.body?.internalReason ?? request.body?.reason
      }, context(request));
      response.redirect(303, '/cms/taxonomy?saved=tag-created');
    } catch (error) { next(error); }
  });

  router.post(['/taxonomy/tags/:id', '/taxonomy/tags/:id/update'], auth.requireAdministrator, (request, response, next) => {
    try {
      assertCsrf(request);
      const current = service.store.getTag(integer(request.params.id, '标签编号'));
      if (!current) throw new AppError('找不到标签', 404, 'TAG_NOT_FOUND');
      service.updateTag({
        ...request.body,
        tagId: request.params.id,
        isActive: request.body?.isActive === undefined ? current.is_active === 1 : checked(request.body?.isActive),
        internalReason: request.body?.internalReason ?? request.body?.reason
      }, context(request));
      response.redirect(303, '/cms/taxonomy?saved=tag-updated');
    } catch (error) { next(error); }
  });

  for (const [command, isActive] of [['activate', true], ['deactivate', false]]) {
    router.post(`/taxonomy/tags/:id/${command}`, auth.requireAdministrator, (request, response, next) => {
      try {
        assertCsrf(request);
        const current = service.store.getTag(integer(request.params.id, '标签编号'));
        if (!current) throw new AppError('找不到标签', 404, 'TAG_NOT_FOUND');
        service.updateTag({
          tagId: current.id,
          expectedUpdatedAt: request.body?.expectedUpdatedAt,
          name: current.name,
          isActive,
          internalReason: request.body?.internalReason ?? request.body?.reason
        }, context(request));
        response.redirect(303, `/cms/taxonomy?saved=tag-${command}d`);
      } catch (error) { next(error); }
    });
  }

  router.post('/taxonomy/tags/:id/merge', auth.requireAdministrator, (request, response, next) => {
    try {
      assertCsrf(request);
      service.mergeTag({
        sourceTagId: request.params.id, targetTagId: request.body?.targetTagId,
        expectedUpdatedAt: request.body?.expectedUpdatedAt,
        internalReason: request.body?.internalReason ?? request.body?.reason
      }, context(request));
      response.redirect(303, '/cms/taxonomy?saved=tag-merged');
    } catch (error) { next(error); }
  });

  router.get('/tasks', auth.requireAdministrator, (request, response, next) => {
    try {
      const tasks = service.store.listTasks();
      response.render('cms/tasks', baseLocals(request, {
        pageTitle: '系统任务', tasks,
        validationTasks: tasks.videos,
        deletionTasks: tasks.deletions
      }));
    } catch (error) { next(error); }
  });

  router.post('/tasks/videos/:id/retry', auth.requireAdministrator, (request, response, next) => {
    try {
      assertCsrf(request);
      service.retryVideoValidation({
        videoId: request.params.id,
        expectedValidatedAt: request.body?.expectedValidatedAt,
        expectedValidationStartedAt: request.body?.expectedValidationStartedAt,
        internalReason: request.body?.internalReason ?? request.body?.reason
      }, context(request));
      response.redirect(303, '/cms/tasks?saved=video-retry');
    } catch (error) { next(error); }
  });

  router.post('/tasks/deletions/:id/retry', auth.requireAdministrator, (request, response, next) => {
    try {
      assertCsrf(request);
      service.retryDeletion({
        deletionId: request.params.id,
        expectedUpdatedAt: request.body?.expectedUpdatedAt,
        internalReason: request.body?.internalReason ?? request.body?.reason
      }, context(request));
      response.redirect(303, '/cms/tasks?saved=deletion-retry');
    } catch (error) { next(error); }
  });

  router.get('/audit', auth.requireAdministrator, (request, response, next) => {
    try {
      const page = pageNumber(request.query.page);
      const result = service.store.listAudit({
        excludeRelatedUserId: request.currentUser.id,
        actorUserId: request.query.actorUserId,
        actor: request.query.actor,
        action: request.query.action,
        objectType: request.query.objectType,
        objectId: request.query.objectId,
        from: request.query.from ? `${request.query.from}T00:00:00.000Z` : null,
        to: request.query.to ? `${request.query.to}T23:59:59.999Z` : null,
        limit: 50, offset: (page - 1) * 50
      });
      response.render('cms/audit', baseLocals(request, {
        pageTitle: '审计日志', events: result.items,
        pagination: pagination(result, page), paginationQuery: filterQueryString(request.query),
        filters: request.query, staff: service.store.listStaff()
      }));
    } catch (error) { next(error); }
  });

  router.use((error, request, response, next) => {
    if (response.headersSent) { next(error); return; }
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    response.status(status).render('cms/error', baseLocals(request, {
      pageTitle: '后台操作未完成', status,
      message: status < 500 ? error.message : '服务暂时无法完成这个请求，请稍后再试。',
      requestId: request.requestId
    }));
  });

  return router;
}
