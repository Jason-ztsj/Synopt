import express from 'express';

import { AppError } from './errors.js';
import { REPORT_REASONS } from './governance.js';

function positivePage(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function pagination(result, currentPage) {
  return {
    page: currentPage,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / result.limit)),
    hasPrevious: currentPage > 1,
    hasNext: currentPage * result.limit < result.total
  };
}

export function createGovernanceRouter(options) {
  const {
    database,
    service,
    config,
    now = () => Date.now(),
    assertCsrf,
    requireAuthentication,
    reportLimiter,
    getClientKey,
    catalogLocals = () => ({})
  } = options;
  const router = express.Router();
  const context = (request) => ({
    actorUserId: request.currentUser.id,
    requestId: request.requestId,
    createdAt: new Date(now()).toISOString()
  });

  const submitReport = (targetType) => (request, response, next) => {
    try {
      assertCsrf(request);
      const userKey = `report:user:${request.currentUser.id}`;
      const ipKey = `report:ip:${getClientKey(request)}`;
      const limits = [reportLimiter.check(userKey), reportLimiter.check(ipKey)];
      const retryAfterSeconds = Math.max(...limits.map((entry) => entry.retryAfterSeconds));
      if (limits.some((entry) => !entry.allowed)) {
        response.set('Retry-After', String(retryAfterSeconds));
        throw new AppError(`举报提交得有点快，请在 ${retryAfterSeconds} 秒后重试`, 429, 'REPORT_RATE_LIMITED');
      }
      const report = service.createReport({
        reporterUserId: request.currentUser.id,
        videoId: targetType === 'video' ? request.params.id : null,
        discussionId: targetType === 'discussion' ? request.params.id : null,
        reasonCategory: request.body?.reasonCategory,
        description: request.body?.description
      }, context(request));
      reportLimiter.consume(userKey);
      reportLimiter.consume(ipKey);
      response.redirect(303, `/account/reports?created=${report.id}`);
    } catch (error) {
      next(error);
    }
  };

  router.post('/videos/:id/reports', requireAuthentication, submitReport('video'));
  router.post('/discussions/:id/reports', requireAuthentication, submitReport('discussion'));

  router.get('/account/reports', requireAuthentication, (request, response, next) => {
    try {
      const currentPage = positivePage(request.query.page);
      const result = service.store.listUserReports(request.currentUser.id, {
        limit: 20,
        offset: (currentPage - 1) * 20
      });
      response.render('account-reports', {
        reports: result.items,
        pagination: pagination(result, currentPage),
        reportReasons: REPORT_REASONS,
        currentPath: request.path,
        createdId: Number(request.query.created) || null,
        ...catalogLocals()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/account/appeals', requireAuthentication, (request, response, next) => {
    try {
      const currentPage = positivePage(request.query.page);
      const result = service.store.listUserAppeals(request.currentUser.id, {
        limit: 20,
        offset: (currentPage - 1) * 20
      });
      const cutoff = new Date(now() - config.appealWindowMs).toISOString();
      response.render('account-appeals', {
        appeals: result.items,
        decisions: service.store.listUserDecisions(request.currentUser.id, { limit: 100 }).items,
        appealableActions: service.store.listAppealableActions(request.currentUser.id, cutoff),
        pagination: pagination(result, currentPage),
        appealWindowDays: config.appealWindowDays,
        currentPath: request.path,
        createdId: Number(request.query.created) || null,
        ...catalogLocals()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/account/appeals', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const appeal = service.submitAppeal({
        appellantUserId: request.currentUser.id,
        moderationActionId: request.body?.moderationActionId,
        reason: request.body?.reason
      }, context(request));
      response.redirect(303, `/account/appeals?created=${appeal.id}`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
