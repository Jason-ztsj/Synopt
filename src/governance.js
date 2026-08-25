import { AppError, ValidationError } from './errors.js';

export const CMS_ROLES = Object.freeze(['moderator', 'administrator']);
export const USER_ROLES = Object.freeze(['member', 'moderator', 'administrator']);
export const REPORT_REASONS = Object.freeze({
  spam_fraud: '垃圾或欺诈',
  harassment_hate: '骚扰或仇恨',
  illegal_dangerous: '违法或危险',
  privacy_copyright: '隐私或版权',
  impersonation_metadata: '冒名或误导性元数据',
  other: '其他'
});

export function hasCmsRole(user) {
  return Boolean(user) && user.status === 'active' && CMS_ROLES.includes(user.role);
}

export function isAdministrator(user) {
  return Boolean(user) && user.status === 'active' && user.role === 'administrator';
}

function requiredText(value, name, min, max) {
  const text = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  const length = Array.from(text).length;
  if (length < min) {
    throw new ValidationError(`${name}至少需要 ${min} 个字符`);
  }
  if (length > max) {
    throw new ValidationError(`${name}不能超过 ${max} 个字符`);
  }
  if (text.includes('\0')) throw new ValidationError(`${name}包含非法字符`);
  return text;
}

function optionalText(value, name, max) {
  const text = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (Array.from(text).length > max) throw new ValidationError(`${name}不能超过 ${max} 个字符`);
  if (text.includes('\0')) throw new ValidationError(`${name}包含非法字符`);
  return text;
}

function integer(value, name, minimum = 0) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new ValidationError(`${name}无效`);
  return parsed;
}

function expectedVersion(value) {
  return integer(value, '页面版本', 0);
}

function nullableVersionToken(value, name) {
  if (value === '__null__') return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new ValidationError(`${name}无效`);
  }
  return value;
}

function nextIsoVersion(currentValue, proposedValue) {
  const currentMs = Date.parse(currentValue);
  const proposedMs = Date.parse(proposedValue);
  if (!Number.isFinite(currentMs) || !Number.isFinite(proposedMs) || proposedMs > currentMs) {
    return proposedValue;
  }
  return new Date(currentMs + 1).toISOString();
}

function sortOrder(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < -100000 || parsed > 100000) {
    throw new ValidationError('排序值无效');
  }
  return parsed;
}

function reasonCategory(value) {
  if (!Object.hasOwn(REPORT_REASONS, value)) throw new ValidationError('请选择有效的举报分类');
  return value;
}

function actorContext(context = {}) {
  const createdAt = typeof context.createdAt === 'string' && context.createdAt
    ? context.createdAt
    : new Date().toISOString();
  const requestId = typeof context.requestId === 'string' && context.requestId
    ? context.requestId.slice(0, 128)
    : 'internal-command';
  return {
    actorUserId: context.actorUserId ?? null,
    actorLabel: context.actorLabel ?? null,
    createdAt,
    requestId
  };
}

function safeGovernanceUser(row) {
  return {
    role: row.role,
    status: row.status,
    governanceVersion: row.governance_version
  };
}

function safeVideo(row) {
  return {
    moderationStatus: row.moderation_status,
    moderationVersion: row.moderation_version,
    visibility: row.visibility,
    withdrawnAt: row.withdrawn_at ?? null,
    deletedAt: row.deleted_at ?? null,
    validationStatus: row.validation_status
  };
}

function safeDiscussion(row) {
  return {
    moderationStatus: row.moderation_status,
    moderationVersion: row.moderation_version,
    deletedAt: row.deleted_at ?? null
  };
}

function assertCurrentActor(tx, context, { administrator = false } = {}) {
  if (!context.actorUserId) throw new AppError('需要工作人员身份', 403, 'CMS_FORBIDDEN');
  const actor = tx.getUser(context.actorUserId);
  if (!actor || actor.status !== 'active' || actor.deleted_at !== null) {
    throw new AppError('账号状态不允许执行后台操作', 403, 'CMS_ACCOUNT_INACTIVE');
  }
  const allowed = administrator
    ? actor.role === 'administrator'
    : CMS_ROLES.includes(actor.role);
  if (!allowed) throw new AppError('没有执行这项后台操作的权限', 403, 'CMS_FORBIDDEN');
  return actor;
}

function assertActiveMember(tx, userId) {
  const user = tx.getUser(userId);
  if (!user || user.status !== 'active' || user.deleted_at !== null) {
    throw new AppError('账号当前不能执行这项操作', 403, 'ACCOUNT_NOT_WRITABLE');
  }
  return user;
}

function audit(tx, context, values) {
  return tx.insertAudit({
    actorUserId: context.actorUserId,
    actorLabel: context.actorLabel,
    requestId: context.requestId,
    createdAt: context.createdAt,
    before: {},
    after: {},
    metadata: {},
    ...values
  });
}

function caseSnapshot(caseRecord) {
  return {
    status: caseRecord.status,
    assigneeUserId: caseRecord.assigneeUserId,
    resolution: caseRecord.resolution,
    version: caseRecord.version
  };
}

function assertCaseTargetIsIndependent(tx, caseRecord, actorUserId) {
  if (tx.hasTargetStake(actorUserId, caseRecord.videoId, caseRecord.discussionId)) {
    throw new AppError('不能处理涉及自己内容的案件', 403, 'SELF_REVIEW_FORBIDDEN');
  }
  if (tx.hasTargetReporterConflict(actorUserId, caseRecord.videoId, caseRecord.discussionId)) {
    throw new AppError('不能处理自己曾举报的目标', 403, 'SELF_REVIEW_FORBIDDEN');
  }
}

function assertAppealReviewerIsIndependent(tx, appeal, reviewer, accountOnly) {
  if (appeal.appellantUserId === reviewer.id) {
    throw new AppError('不能处理自己的申诉', 403, 'SELF_APPEAL_REVIEW_FORBIDDEN');
  }
  if (tx.hasTargetStake(reviewer.id, appeal.videoId, appeal.discussionId)) {
    throw new AppError('不能处理涉及自身利益的内容申诉', 403, 'SELF_APPEAL_REVIEW_FORBIDDEN');
  }
  if (tx.hasTargetReporterConflict(reviewer.id, appeal.videoId, appeal.discussionId)) {
    throw new AppError('不能处理源自自己举报的申诉', 403, 'SELF_APPEAL_REVIEW_FORBIDDEN');
  }
  if (appeal.targetUserId && tx.hasUserReporterConflict(reviewer.id, appeal.targetUserId)) {
    throw new AppError('不能处理涉及自己举报对象的账号申诉', 403, 'SELF_APPEAL_REVIEW_FORBIDDEN');
  }
  if (appeal.actionActorUserId !== reviewer.id) return false;
  if (tx.activeAlternativeReviewerCount(
    accountOnly,
    appeal.actionActorUserId,
    appeal.appellantUserId,
    appeal.videoId,
    appeal.discussionId,
    appeal.targetUserId
  ) > 0) {
    throw new AppError('应由非原操作者复核这项决定', 403, 'ORIGINAL_ACTOR_REVIEW_FORBIDDEN');
  }
  if (reviewer.role !== 'administrator' || tx.activeAdministratorCount() !== 1) {
    throw new AppError('当前不能由原操作者复核', 403, 'ORIGINAL_ACTOR_REVIEW_FORBIDDEN');
  }
  return true;
}

function sqliteConstraint(error) {
  const numericCode = Number(error?.errcode);
  return String(error?.code ?? '').startsWith('SQLITE_CONSTRAINT')
    || (Number.isInteger(numericCode) && (numericCode & 0xff) === 19)
    || (error?.code === 'ERR_SQLITE_ERROR' && /constraint|unique/i.test(String(error?.message ?? '')));
}

export function createGovernanceService(store, options = {}) {
  const appealWindowMs = options.appealWindowMs ?? 30 * 24 * 60 * 60 * 1000;
  const mediaGrantMs = options.mediaGrantMs ?? 15 * 60 * 1000;

  const service = {
    store,

    createReport(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const category = reasonCategory(input.reasonCategory);
      const description = requiredText(input.description, '举报说明', 20, 2000);
      const reporterUserId = input.reporterUserId ?? context.actorUserId;
      if (!context.actorUserId || reporterUserId !== context.actorUserId) {
        throw new AppError('不能以其他账号身份提交举报', 403, 'REPORTER_IDENTITY_MISMATCH');
      }
      try {
        return store.transaction((tx) => {
          assertActiveMember(tx, reporterUserId);
          let videoId = null;
          let discussionId = null;
          if (input.videoId) {
            const video = tx.getVideo(String(input.videoId));
            if (
              !video
              || video.deleted_at !== null
              || video.withdrawn_at !== null
              || video.visibility !== 'public'
              || video.moderation_status !== 'visible'
              || !['ready', 'ready_with_warnings'].includes(video.validation_status)
            ) throw new AppError('找不到可以举报的视频', 404, 'REPORT_TARGET_NOT_FOUND');
            if (video.user_id === reporterUserId) throw new AppError('不能举报自己的内容', 403, 'SELF_REPORT_FORBIDDEN');
            videoId = video.id;
          } else if (input.discussionId) {
            const discussion = tx.getDiscussion(integer(input.discussionId, '讨论编号', 1));
            if (
              !discussion
              || discussion.deleted_at !== null
              || discussion.moderation_status !== 'visible'
              || discussion.video_deleted_at !== null
              || discussion.video_withdrawn_at !== null
              || discussion.video_visibility !== 'public'
              || discussion.video_moderation_status !== 'visible'
              || !['ready', 'ready_with_warnings'].includes(discussion.video_validation_status)
            ) throw new AppError('找不到可以举报的讨论', 404, 'REPORT_TARGET_NOT_FOUND');
            if (discussion.user_id === reporterUserId) throw new AppError('不能举报自己的内容', 403, 'SELF_REPORT_FORBIDDEN');
            discussionId = discussion.id;
          } else {
            throw new ValidationError('举报目标无效');
          }
          const created = tx.createCase({
            source: 'report', reporterUserId, openedByUserId: reporterUserId,
            videoId, discussionId, reasonCategory: category, description,
            createdAt: context.createdAt
          });
          audit(tx, context, {
            action: 'report.created', objectType: 'moderation_case', objectId: created.id,
            after: { source: 'report', targetType: videoId ? 'video' : 'discussion', status: 'open' }
          });
          return created;
        });
      } catch (error) {
        if (sqliteConstraint(error) && /UNIQUE/i.test(String(error.message))) {
          throw new AppError('你已经对这项内容提交过尚未处理完的举报', 409, 'OPEN_REPORT_EXISTS');
        }
        throw error;
      }
    },

    createInvestigation(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const description = requiredText(input.description, '调查理由', 20, 2000);
      const category = reasonCategory(input.reasonCategory ?? 'other');
      return store.transaction((tx) => {
        assertCurrentActor(tx, context);
        let videoId = null;
        let discussionId = null;
        if (input.videoId) {
          const video = tx.getVideo(String(input.videoId));
          if (!video || video.deleted_at !== null) throw new AppError('找不到视频', 404, 'VIDEO_NOT_FOUND');
          if (video.user_id === context.actorUserId) {
            throw new AppError('不能对自己的视频建立主动调查', 403, 'SELF_REVIEW_FORBIDDEN');
          }
          if (tx.hasTargetReporterConflict(context.actorUserId, video.id, null)) {
            throw new AppError('不能对自己曾举报的视频建立主动调查', 403, 'SELF_REVIEW_FORBIDDEN');
          }
          videoId = video.id;
        } else if (input.discussionId) {
          const discussion = tx.getDiscussion(integer(input.discussionId, '讨论编号', 1));
          if (!discussion) throw new AppError('找不到讨论', 404, 'DISCUSSION_NOT_FOUND');
          if (tx.hasTargetStake(context.actorUserId, null, discussion.id)) {
            throw new AppError('不能对自己或自己视频下的讨论建立主动调查', 403, 'SELF_REVIEW_FORBIDDEN');
          }
          if (tx.hasTargetReporterConflict(context.actorUserId, null, discussion.id)) {
            throw new AppError('不能对自己曾举报的讨论建立主动调查', 403, 'SELF_REVIEW_FORBIDDEN');
          }
          discussionId = discussion.id;
        } else throw new ValidationError('调查目标无效');
        const created = tx.createCase({
          source: 'investigation', openedByUserId: context.actorUserId,
          videoId, discussionId, reasonCategory: category, description,
          createdAt: context.createdAt
        });
        audit(tx, context, {
          action: 'case.investigation_created', objectType: 'moderation_case', objectId: created.id,
          after: caseSnapshot(created), metadata: { reason: description }
        });
        return created;
      });
    },

    claimCase(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.caseId, '案件编号', 1);
      const version = expectedVersion(input.expectedVersion);
      const commandReason = requiredText(input.internalReason, '认领理由', 1, 1000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context);
        const current = tx.getCase(id);
        if (!current) throw new AppError('找不到案件', 404, 'CASE_NOT_FOUND');
        assertCaseTargetIsIndependent(tx, current, context.actorUserId);
        if (current.assigneeUserId && current.assigneeUserId !== context.actorUserId) {
          throw new AppError('案件已经被其他工作人员认领', 409, 'CASE_ALREADY_CLAIMED');
        }
        if (current.version !== version) {
          throw new AppError('案件状态已经变化，请刷新后重试', 409, 'CASE_VERSION_CONFLICT');
        }
        if (current.status !== 'open' || current.assigneeUserId !== null) {
          throw new AppError('案件已经认领或不再处于待处理状态', 409, 'CASE_STATE_CONFLICT');
        }
        const updated = tx.claimCase(id, version, context.actorUserId, context.createdAt);
        if (!updated) throw new AppError('案件状态已经变化，请刷新后重试', 409, 'CASE_VERSION_CONFLICT');
        tx.insertCaseNote(id, context.actorUserId, `认领：${commandReason}`, context.createdAt);
        audit(tx, context, {
          action: 'case.claimed', objectType: 'moderation_case', objectId: id,
          before: caseSnapshot(current), after: caseSnapshot(updated), metadata: { reason: commandReason }
        });
        return updated;
      });
    },

    transferCase(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.caseId, '案件编号', 1);
      const version = expectedVersion(input.expectedVersion);
      const assigneeUserId = String(input.assigneeUserId ?? '');
      const commandReason = requiredText(input.internalReason, '转交理由', 1, 1000);
      return store.transaction((tx) => {
        const actor = assertCurrentActor(tx, context);
        const assignee = tx.getUser(assigneeUserId);
        if (!assignee || assignee.status !== 'active' || !CMS_ROLES.includes(assignee.role)) {
          throw new ValidationError('请选择有效的工作人员');
        }
        const current = tx.getCase(id);
        if (!current) throw new AppError('找不到案件', 404, 'CASE_NOT_FOUND');
        assertCaseTargetIsIndependent(tx, current, context.actorUserId);
        if (tx.hasTargetStake(assigneeUserId, current.videoId, current.discussionId)) {
          throw new AppError('不能把案件转交给目标内容利益相关者', 403, 'SELF_REVIEW_FORBIDDEN');
        }
        if (tx.hasTargetReporterConflict(assigneeUserId, current.videoId, current.discussionId)) {
          throw new AppError('不能把案件转交给举报人', 403, 'SELF_REVIEW_FORBIDDEN');
        }
        if (current.version !== version) {
          throw new AppError('案件状态已经变化，请刷新后重试', 409, 'CASE_VERSION_CONFLICT');
        }
        if (current.status !== 'in_review' || current.assigneeUserId === null) {
          throw new AppError('只有已经认领的复核中案件可以转交', 409, 'CASE_STATE_CONFLICT');
        }
        if (current.assigneeUserId !== context.actorUserId && actor.role !== 'administrator') {
          throw new AppError('只有当前负责人或管理员可以转交案件', 403, 'CASE_ASSIGNMENT_FORBIDDEN');
        }
        if (current.assigneeUserId === assigneeUserId) {
          throw new AppError('新的负责人必须与当前负责人不同', 409, 'CASE_TRANSFER_NO_CHANGE');
        }
        const updated = tx.transferCase(id, version, assigneeUserId, context.createdAt);
        if (!updated) throw new AppError('案件状态已经变化，请刷新后重试', 409, 'CASE_VERSION_CONFLICT');
        tx.revokeCaseMediaGrants(id);
        tx.insertCaseNote(id, context.actorUserId, `转交：${commandReason}`, context.createdAt);
        audit(tx, context, {
          action: 'case.transferred', objectType: 'moderation_case', objectId: id,
          before: caseSnapshot(current), after: caseSnapshot(updated), metadata: { reason: commandReason }
        });
        return updated;
      });
    },

    addCaseNote(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.caseId, '案件编号', 1);
      const version = expectedVersion(input.expectedVersion);
      const body = requiredText(input.body, '内部备注', 1, 4000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context);
        const current = tx.getCase(id);
        if (!current) throw new AppError('找不到案件', 404, 'CASE_NOT_FOUND');
        assertCaseTargetIsIndependent(tx, current, context.actorUserId);
        if (current.version !== version) {
          throw new AppError('案件状态已经变化，请刷新后重试', 409, 'CASE_VERSION_CONFLICT');
        }
        if (current.status !== 'in_review') {
          throw new AppError('只能为复核中的案件追加备注', 409, 'CASE_STATE_CONFLICT');
        }
        if (current.assigneeUserId !== context.actorUserId) {
          throw new AppError('只有当前负责人可以追加案件备注', 403, 'CASE_ASSIGNMENT_FORBIDDEN');
        }
        const updated = tx.touchAssignedCase(id, version, context.actorUserId, context.createdAt);
        if (!updated) throw new AppError('案件状态已经变化，请刷新后重试', 409, 'CASE_VERSION_CONFLICT');
        const noteId = tx.insertCaseNote(id, context.actorUserId, body, context.createdAt);
        audit(tx, context, {
          action: 'case.note_added', objectType: 'moderation_case', objectId: id,
          before: caseSnapshot(current), after: caseSnapshot(updated),
          metadata: { noteId, reason: body }
        });
        return { id: noteId, caseId: id, caseVersion: updated.version };
      });
    },

    resolveCase(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.caseId, '案件编号', 1);
      const version = expectedVersion(input.expectedVersion);
      if (!['violation_confirmed', 'no_violation'].includes(input.resolution)) {
        throw new ValidationError('案件结论无效');
      }
      const publicExplanation = requiredText(input.publicExplanation, '公开说明', 1, 2000);
      const internalReason = requiredText(input.internalReason, '内部结案说明', 1, 4000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context);
        const current = tx.getCase(id);
        if (!current) throw new AppError('找不到案件', 404, 'CASE_NOT_FOUND');
        assertCaseTargetIsIndependent(tx, current, context.actorUserId);
        if (current.version !== version) {
          throw new AppError('案件状态已经变化，请刷新后重试', 409, 'CASE_VERSION_CONFLICT');
        }
        if (current.status !== 'in_review') {
          throw new AppError('只有复核中的案件可以结案', 409, 'CASE_STATE_CONFLICT');
        }
        if (current.assigneeUserId !== context.actorUserId) {
          throw new AppError('只有当前负责人可以结案', 403, 'CASE_ASSIGNMENT_FORBIDDEN');
        }
        if (input.resolution === 'no_violation') {
          const target = current.videoId
            ? tx.getVideo(current.videoId)
            : tx.getDiscussion(current.discussionId);
          if (!target || target.moderation_status !== 'visible') {
            throw new AppError('目标仍处于隐藏或移除状态，请先恢复再判定未违规', 409, 'CASE_TARGET_STILL_MODERATED');
          }
        }
        const updated = tx.resolveCase(id, version, input.resolution, publicExplanation, context.createdAt);
        if (!updated) throw new AppError('案件状态已经变化，请刷新后重试', 409, 'CASE_VERSION_CONFLICT');
        tx.revokeCaseMediaGrants(id);
        tx.insertCaseNote(id, context.actorUserId, `结案：${internalReason}`, context.createdAt);
        audit(tx, context, {
          action: 'case.resolved', objectType: 'moderation_case', objectId: id,
          before: caseSnapshot(current), after: caseSnapshot(updated), metadata: { reason: internalReason }
        });
        if (updated.reporterUserId) {
          tx.createMandatoryNotification(
            updated.reporterUserId,
            '你的举报已有处理结果',
            publicExplanation,
            '/account/reports',
            context.createdAt
          );
        }
        return updated;
      });
    },

    moderateVideo(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = String(input.videoId ?? '');
      const caseId = integer(input.caseId, '案件编号', 1);
      const version = expectedVersion(input.expectedVersion);
      const publicReason = requiredText(input.publicReason, '公开说明', 1, 2000);
      const internalNote = requiredText(input.internalNote, '内部说明', 1, 4000);
      const targetStatus = ({ hide: 'hidden', remove: 'removed', restore: 'visible' })[input.command];
      if (!targetStatus) throw new ValidationError('视频审核动作无效');
      return store.transaction((tx) => {
        assertCurrentActor(tx, context);
        const currentCase = tx.getCase(caseId);
        if (!currentCase || currentCase.videoId !== id) {
          throw new AppError('案件与视频不匹配', 409, 'CASE_TARGET_MISMATCH');
        }
        assertCaseTargetIsIndependent(tx, currentCase, context.actorUserId);
        if (currentCase.status !== 'in_review') {
          throw new AppError('必须先认领案件再审核视频', 409, 'CASE_STATE_CONFLICT');
        }
        if (currentCase.assigneeUserId !== context.actorUserId) {
          throw new AppError('必须先认领案件，且只有当前负责人可以审核视频', 403, 'CASE_ASSIGNMENT_FORBIDDEN');
        }
        const video = tx.getVideo(id);
        if (!video || video.deleted_at !== null) throw new AppError('找不到视频', 404, 'VIDEO_NOT_FOUND');
        const allowed = input.command === 'hide'
          ? video.moderation_status === 'visible'
          : input.command === 'remove'
            ? ['visible', 'hidden'].includes(video.moderation_status)
            : ['hidden', 'removed'].includes(video.moderation_status);
        if (!allowed || video.moderation_status === targetStatus) {
          throw new AppError('视频当前状态不允许这个动作', 409, 'VIDEO_MODERATION_STATE_CONFLICT');
        }
        if (tx.updateVideoModeration(id, version, targetStatus) !== 1) {
          throw new AppError('视频审核状态已经变化，请刷新后重试', 409, 'VIDEO_VERSION_CONFLICT');
        }
        const afterRow = tx.getVideo(id);
        const before = safeVideo(video);
        const after = safeVideo(afterRow);
        const action = tx.insertAction({
          caseId, actorUserId: context.actorUserId, affectedUserId: video.user_id,
          videoId: id, action: `video_${input.command}`, publicReason, internalNote,
          before, after, beforeVersion: version, afterVersion: version + 1, createdAt: context.createdAt
        });
        audit(tx, context, {
          action: `video.${input.command}`, objectType: 'video', objectId: id,
          before, after, metadata: { caseId, moderationActionId: action.id, reason: internalNote }
        });
        tx.createMandatoryNotification(
          video.user_id,
          input.command === 'restore' ? '你的视频审核决定已恢复' : '你的视频收到一项治理决定',
          publicReason,
          '/account/appeals',
          context.createdAt
        );
        return action;
      });
    },

    moderateDiscussion(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.discussionId, '讨论编号', 1);
      const caseId = integer(input.caseId, '案件编号', 1);
      const version = expectedVersion(input.expectedVersion);
      const publicReason = requiredText(input.publicReason, '公开说明', 1, 2000);
      const internalNote = requiredText(input.internalNote, '内部说明', 1, 4000);
      const targetStatus = ({ hide: 'hidden', remove: 'removed', restore: 'visible' })[input.command];
      if (!targetStatus) throw new ValidationError('讨论审核动作无效');
      return store.transaction((tx) => {
        assertCurrentActor(tx, context);
        const currentCase = tx.getCase(caseId);
        if (!currentCase || currentCase.discussionId !== id) {
          throw new AppError('案件与讨论不匹配', 409, 'CASE_TARGET_MISMATCH');
        }
        assertCaseTargetIsIndependent(tx, currentCase, context.actorUserId);
        if (currentCase.status !== 'in_review') {
          throw new AppError('必须先认领案件再审核讨论', 409, 'CASE_STATE_CONFLICT');
        }
        if (currentCase.assigneeUserId !== context.actorUserId) {
          throw new AppError('必须先认领案件，且只有当前负责人可以审核讨论', 403, 'CASE_ASSIGNMENT_FORBIDDEN');
        }
        const discussion = tx.getDiscussion(id);
        if (!discussion) throw new AppError('找不到讨论', 404, 'DISCUSSION_NOT_FOUND');
        if (discussion.deleted_at !== null) {
          throw new AppError('作者已删除的讨论不能由后台恢复或改写', 409, 'AUTHOR_DELETED_DISCUSSION');
        }
        const allowed = input.command === 'hide'
          ? discussion.moderation_status === 'visible'
          : input.command === 'remove'
            ? ['visible', 'hidden'].includes(discussion.moderation_status)
            : ['hidden', 'removed'].includes(discussion.moderation_status);
        if (!allowed || discussion.moderation_status === targetStatus) {
          throw new AppError('讨论当前状态不允许这个动作', 409, 'DISCUSSION_MODERATION_STATE_CONFLICT');
        }
        if (tx.updateDiscussionModeration(id, version, targetStatus) !== 1) {
          throw new AppError('讨论审核状态已经变化，请刷新后重试', 409, 'DISCUSSION_VERSION_CONFLICT');
        }
        const afterRow = tx.getDiscussion(id);
        const before = safeDiscussion(discussion);
        const after = safeDiscussion(afterRow);
        const action = tx.insertAction({
          caseId, actorUserId: context.actorUserId, affectedUserId: discussion.user_id,
          discussionId: id, action: `discussion_${input.command}`, publicReason, internalNote,
          before, after, beforeVersion: version, afterVersion: version + 1, createdAt: context.createdAt
        });
        audit(tx, context, {
          action: `discussion.${input.command}`, objectType: 'discussion', objectId: id,
          before, after, metadata: { caseId, moderationActionId: action.id, reason: internalNote }
        });
        tx.createMandatoryNotification(
          discussion.user_id,
          input.command === 'restore' ? '你的讨论审核决定已恢复' : '你的讨论收到一项治理决定',
          publicReason,
          '/account/appeals',
          context.createdAt
        );
        return action;
      });
    },

    changeUserStatus(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = String(input.userId ?? '');
      const version = expectedVersion(input.expectedVersion);
      const publicReason = requiredText(input.publicReason, '公开说明', 1, 2000);
      const internalNote = requiredText(input.internalNote, '内部说明', 1, 4000);
      const targetStatus = ({ suspend: 'suspended', restore: 'active' })[input.command];
      if (!targetStatus) throw new ValidationError('账号动作无效');
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        const user = tx.getUser(id);
        if (!user || user.deleted_at !== null || user.status === 'disabled') {
          throw new AppError('找不到可管理的账号', 404, 'USER_NOT_FOUND');
        }
        if (tx.hasUserReporterConflict(context.actorUserId, id)) {
          throw new AppError('不能治理自己曾举报内容的作者账号', 403, 'REPORTER_GOVERNANCE_CONFLICT');
        }
        if (id === context.actorUserId && input.command === 'suspend') {
          throw new AppError('不能暂停自己的账号', 403, 'SELF_GOVERNANCE_FORBIDDEN');
        }
        if (input.command === 'suspend' && user.role === 'administrator' && user.status === 'active' && tx.activeAdministratorCount() <= 1) {
          throw new AppError('不能暂停最后一名有效管理员', 409, 'LAST_ADMINISTRATOR');
        }
        if (user.status === targetStatus) throw new AppError('账号已经处于目标状态', 409, 'USER_STATE_CONFLICT');
        const before = safeGovernanceUser(user);
        tx.revokeUserCmsGrants(id);
        if (tx.updateUserStatus(id, version, targetStatus, context.createdAt) !== 1) {
          throw new AppError('账号状态已经变化，请刷新后重试', 409, 'USER_VERSION_CONFLICT');
        }
        if (input.command === 'suspend') tx.revokeUserSessions(id);
        const updated = tx.getUser(id);
        const after = safeGovernanceUser(updated);
        const action = tx.insertAction({
          actorUserId: context.actorUserId, affectedUserId: id, userId: id,
          action: `user_${input.command}`, publicReason, internalNote,
          before, after, beforeVersion: version, afterVersion: version + 1, createdAt: context.createdAt
        });
        audit(tx, context, {
          action: `user.${input.command}`, objectType: 'user', objectId: id,
          before, after, metadata: { moderationActionId: action.id, reason: internalNote }
        });
        tx.createMandatoryNotification(
          id,
          input.command === 'suspend' ? '你的账号已被暂停' : '你的账号已恢复',
          publicReason,
          '/account/appeals',
          context.createdAt
        );
        return action;
      });
    },

    setUserRole(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = String(input.userId ?? '');
      const version = expectedVersion(input.expectedVersion);
      const role = String(input.role ?? '');
      if (!USER_ROLES.includes(role)) throw new ValidationError('账号角色无效');
      const publicReason = requiredText(input.publicReason, '公开说明', 1, 2000);
      const internalNote = requiredText(input.internalNote, '内部说明', 1, 4000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        const user = tx.getUser(id);
        if (!user || user.deleted_at !== null || user.status === 'disabled') {
          throw new AppError('找不到可管理的账号', 404, 'USER_NOT_FOUND');
        }
        if (tx.hasUserReporterConflict(context.actorUserId, id)) {
          throw new AppError('不能治理自己曾举报内容的作者账号', 403, 'REPORTER_GOVERNANCE_CONFLICT');
        }
        if (id === context.actorUserId && role !== 'administrator') {
          throw new AppError('不能降低自己的管理员角色', 403, 'SELF_GOVERNANCE_FORBIDDEN');
        }
        if (user.role === 'administrator' && role !== 'administrator' && user.status === 'active' && tx.activeAdministratorCount() <= 1) {
          throw new AppError('不能降级最后一名有效管理员', 409, 'LAST_ADMINISTRATOR');
        }
        if (user.role === role) throw new AppError('账号已经拥有这个角色', 409, 'USER_ROLE_CONFLICT');
        const before = safeGovernanceUser(user);
        if (tx.updateUserRole(id, version, role, context.createdAt) !== 1) {
          throw new AppError('账号角色已经变化，请刷新后重试', 409, 'USER_VERSION_CONFLICT');
        }
        tx.clearUserCmsVerification(id);
        if (!CMS_ROLES.includes(role)) tx.revokeUserCmsGrants(id);
        const updated = tx.getUser(id);
        const after = safeGovernanceUser(updated);
        const action = tx.insertAction({
          actorUserId: context.actorUserId, affectedUserId: id, userId: id,
          action: 'user_role', publicReason, internalNote,
          before, after, beforeVersion: version, afterVersion: version + 1, createdAt: context.createdAt
        });
        audit(tx, context, {
          action: 'user.role_changed', objectType: 'user', objectId: id,
          before, after, metadata: { moderationActionId: action.id, reason: internalNote }
        });
        tx.createMandatoryNotification(id, '你的平台角色已变更', publicReason, '/account/appeals', context.createdAt);
        return action;
      });
    },

    grantAdministratorByUsername(username, rawContext = {}) {
      const context = actorContext({ ...rawContext, actorUserId: null, actorLabel: 'system-cli' });
      const normalized = typeof username === 'string' ? username.trim().toLowerCase() : '';
      if (!normalized) throw new ValidationError('请提供用户名');
      return store.transaction((tx) => {
        const user = tx.findUserByUsername(normalized);
        if (!user || user.deleted_at !== null || user.status === 'disabled') {
          throw new AppError('找不到可授权的账号', 404, 'USER_NOT_FOUND');
        }
        if (user.role === 'administrator') return user;
        const before = safeGovernanceUser(user);
        if (tx.updateUserRole(user.id, user.governance_version, 'administrator', context.createdAt) !== 1) {
          throw new AppError('账号状态已经变化，请重试', 409, 'USER_VERSION_CONFLICT');
        }
        tx.clearUserCmsVerification(user.id);
        const updated = tx.getUser(user.id);
        const after = safeGovernanceUser(updated);
        tx.insertAction({
          actorLabel: 'system-cli', affectedUserId: user.id, userId: user.id,
          action: 'user_role', publicReason: '由本地管理员命令授予管理员角色',
          internalNote: '首位或后续管理员的明确本地授权', before, after,
          beforeVersion: user.governance_version, afterVersion: user.governance_version + 1,
          createdAt: context.createdAt
        });
        audit(tx, context, {
          action: 'user.role_changed', objectType: 'user', objectId: user.id,
          before, after, metadata: { source: 'admin:grant' }
        });
        tx.createMandatoryNotification(user.id, '你已被授予管理员角色', '本地系统管理员已明确授予你管理后台权限。', '/cms', context.createdAt);
        return updated;
      });
    },

    revokeUserSessions(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = String(input.userId ?? '');
      const version = expectedVersion(input.expectedVersion);
      const internalReason = requiredText(input.internalReason, '撤销理由', 1, 4000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        const user = tx.getUser(id);
        if (!user || user.deleted_at !== null) throw new AppError('找不到账号', 404, 'USER_NOT_FOUND');
        if (tx.hasUserReporterConflict(context.actorUserId, id)) {
          throw new AppError('不能治理自己曾举报内容的作者账号', 403, 'REPORTER_GOVERNANCE_CONFLICT');
        }
        const before = safeGovernanceUser(user);
        tx.revokeUserCmsGrants(id);
        const revoked = tx.revokeUserSessions(id);
        if (tx.touchUserGovernance(id, version, context.createdAt) !== 1) {
          throw new AppError('账号状态已经变化，请刷新后重试', 409, 'USER_VERSION_CONFLICT');
        }
        const after = safeGovernanceUser(tx.getUser(id));
        tx.insertAction({
          actorUserId: context.actorUserId, affectedUserId: id, userId: id,
          action: 'user_sessions_revoke', publicReason: '为保护账号安全，现有登录会话已撤销。',
          internalNote: internalReason, before, after,
          beforeVersion: version, afterVersion: version + 1, createdAt: context.createdAt
        });
        audit(tx, context, {
          action: 'user.sessions_revoked', objectType: 'user', objectId: id,
          before, after, metadata: { revokedSessions: revoked, reason: internalReason }
        });
        return { revoked, version: version + 1 };
      });
    },

    submitAppeal(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const actionId = integer(input.moderationActionId, '审核动作编号', 1);
      const reason = requiredText(input.reason, '申诉理由', 20, 2000);
      const appellantUserId = input.appellantUserId ?? context.actorUserId;
      if (!context.actorUserId || appellantUserId !== context.actorUserId) {
        throw new AppError('不能以其他账号身份提交申诉', 403, 'APPELLANT_IDENTITY_MISMATCH');
      }
      try {
        return store.transaction((tx) => {
          const user = tx.getUser(appellantUserId);
          if (!user || !['active', 'suspended'].includes(user.status) || user.deleted_at !== null) {
            throw new AppError('账号当前不能申诉', 403, 'APPEAL_FORBIDDEN');
          }
          const action = tx.getAction(actionId);
          if (!action || action.affectedUserId !== appellantUserId) {
            throw new AppError('找不到可以申诉的决定', 404, 'ACTION_NOT_APPEALABLE');
          }
          if (!['video_hide', 'video_remove', 'discussion_hide', 'discussion_remove', 'user_suspend'].includes(action.action)) {
            throw new AppError('这项决定不能申诉', 409, 'ACTION_NOT_APPEALABLE');
          }
          const appealDelayMs = Date.parse(context.createdAt) - Date.parse(action.createdAt);
          if (!Number.isFinite(appealDelayMs) || appealDelayMs < 0 || appealDelayMs > appealWindowMs) {
            throw new AppError('这项决定已经超过申诉期限', 409, 'APPEAL_WINDOW_EXPIRED');
          }
          const appeal = tx.createAppeal({
            moderationActionId: actionId, appellantUserId, reason, createdAt: context.createdAt
          });
          audit(tx, context, {
            action: 'appeal.submitted', objectType: 'appeal', objectId: appeal.id,
            after: { status: appeal.status, version: appeal.version }, metadata: { moderationActionId: actionId }
          });
          return appeal;
        });
      } catch (error) {
        if (sqliteConstraint(error) && /UNIQUE/i.test(String(error.message))) {
          throw new AppError('这项决定已经提交过申诉', 409, 'APPEAL_EXISTS');
        }
        throw error;
      }
    },

    claimAppeal(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.appealId, '申诉编号', 1);
      const version = expectedVersion(input.expectedVersion);
      const commandReason = requiredText(input.internalReason, '认领理由', 1, 1000);
      return store.transaction((tx) => {
        const appeal = tx.getAppeal(id);
        if (!appeal) throw new AppError('找不到申诉', 404, 'APPEAL_NOT_FOUND');
        const accountOnly = appeal.action === 'user_suspend';
        const reviewer = assertCurrentActor(tx, context, { administrator: accountOnly });
        const exceptionalSelfReview = assertAppealReviewerIsIndependent(
          tx, appeal, reviewer, accountOnly
        );
        const claimed = tx.claimAppeal(id, version, context.actorUserId, context.createdAt);
        if (!claimed) throw new AppError('申诉已经被认领或状态发生变化', 409, 'APPEAL_VERSION_CONFLICT');
        audit(tx, context, {
          action: exceptionalSelfReview ? 'appeal.self_review_claim_exception' : 'appeal.claimed',
          objectType: 'appeal', objectId: id,
          before: { status: appeal.status, reviewerUserId: appeal.reviewerUserId, version: appeal.version },
          after: { status: claimed.status, reviewerUserId: claimed.reviewerUserId, version: claimed.version },
          metadata: { reason: commandReason, exceptionalSelfReview }
        });
        return claimed;
      });
    },

    transferAppeal(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.appealId, '申诉编号', 1);
      const version = expectedVersion(input.expectedVersion);
      const reviewerUserId = String(input.reviewerUserId ?? '');
      const internalReason = requiredText(input.internalReason, '转交理由', 1, 1000);
      return store.transaction((tx) => {
        const appeal = tx.getAppeal(id);
        if (!appeal) throw new AppError('找不到申诉', 404, 'APPEAL_NOT_FOUND');
        const accountOnly = appeal.action === 'user_suspend';
        const actor = assertCurrentActor(tx, context, { administrator: accountOnly });
        if (appeal.appellantUserId === context.actorUserId) {
          throw new AppError('不能转交自己的申诉', 403, 'SELF_APPEAL_REVIEW_FORBIDDEN');
        }
        if (tx.hasTargetStake(context.actorUserId, appeal.videoId, appeal.discussionId)) {
          throw new AppError('不能转交涉及自身利益的内容申诉', 403, 'SELF_APPEAL_REVIEW_FORBIDDEN');
        }
        if (tx.hasTargetReporterConflict(
          context.actorUserId,
          appeal.videoId,
          appeal.discussionId
        )) {
          throw new AppError('不能转交源自自己举报的申诉', 403, 'SELF_APPEAL_REVIEW_FORBIDDEN');
        }
        if (appeal.targetUserId && tx.hasUserReporterConflict(
          context.actorUserId,
          appeal.targetUserId
        )) {
          throw new AppError('不能转交涉及自己举报对象的账号申诉', 403, 'SELF_APPEAL_REVIEW_FORBIDDEN');
        }
        if (appeal.version !== version) {
          throw new AppError('申诉状态已经变化，请刷新后重试', 409, 'APPEAL_VERSION_CONFLICT');
        }
        if (appeal.status !== 'in_review' || appeal.reviewerUserId === null) {
          throw new AppError('只能转交已认领的申诉', 409, 'APPEAL_NOT_CLAIMED');
        }
        if (appeal.reviewerUserId !== context.actorUserId && actor.role !== 'administrator') {
          throw new AppError('只有当前复核人或管理员可以转交申诉', 403, 'APPEAL_TRANSFER_FORBIDDEN');
        }
        if (appeal.reviewerUserId === reviewerUserId) {
          throw new AppError('新复核人必须与当前复核人不同', 409, 'APPEAL_TRANSFER_NO_CHANGE');
        }
        const nextReviewer = tx.getUser(reviewerUserId);
        const eligible = nextReviewer
          && nextReviewer.status === 'active'
          && nextReviewer.deleted_at === null
          && (accountOnly ? nextReviewer.role === 'administrator' : CMS_ROLES.includes(nextReviewer.role));
        if (!eligible) throw new ValidationError('请选择有效的复核人');
        const exceptionalSelfReview = assertAppealReviewerIsIndependent(
          tx, appeal, nextReviewer, accountOnly
        );
        const transferred = tx.transferAppeal(id, version, reviewerUserId, context.createdAt);
        if (!transferred) {
          throw new AppError('申诉状态已经变化，请刷新后重试', 409, 'APPEAL_VERSION_CONFLICT');
        }
        audit(tx, context, {
          action: exceptionalSelfReview ? 'appeal.self_review_transfer_exception' : 'appeal.transferred',
          objectType: 'appeal', objectId: id,
          before: {
            status: appeal.status, reviewerUserId: appeal.reviewerUserId, version: appeal.version
          },
          after: {
            status: transferred.status,
            reviewerUserId: transferred.reviewerUserId,
            version: transferred.version
          },
          metadata: { reason: internalReason, exceptionalSelfReview }
        });
        return transferred;
      });
    },

    reviewAppeal(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.appealId, '申诉编号', 1);
      const version = expectedVersion(input.expectedVersion);
      if (!['upheld', 'overturned'].includes(input.result)) throw new ValidationError('复核结果无效');
      const publicExplanation = requiredText(input.publicExplanation, '公开说明', 1, 2000);
      const internalNote = requiredText(input.internalNote, '内部说明', 1, 4000);
      return store.transaction((tx) => {
        const appeal = tx.getAppeal(id);
        if (!appeal) throw new AppError('找不到申诉', 404, 'APPEAL_NOT_FOUND');
        const accountOnly = appeal.action === 'user_suspend';
        const reviewer = assertCurrentActor(tx, context, { administrator: accountOnly });
        if (appeal.status === 'resolved') throw new AppError('申诉已经处理', 409, 'APPEAL_RESOLVED');
        if (appeal.status !== 'in_review' || appeal.reviewerUserId === null) {
          throw new AppError('请先认领申诉再提交复核结论', 409, 'APPEAL_NOT_CLAIMED');
        }
        if (appeal.reviewerUserId !== context.actorUserId) {
          throw new AppError('申诉已经由其他工作人员认领', 409, 'APPEAL_ALREADY_CLAIMED');
        }
        const exceptionalSelfReview = assertAppealReviewerIsIndependent(
          tx, appeal, reviewer, accountOnly
        );
        if (appeal.hasStateConflict && input.result === 'overturned') {
          throw new AppError(
            '该申诉已发现后续状态变化，请使用人工冲突处理',
            409,
            'APPEAL_MANUAL_RESOLUTION_REQUIRED'
          );
        }
        if (input.result === 'upheld') {
          const resolved = tx.resolveAppeal(id, version, {
            status: 'resolved', result: 'upheld', reviewerUserId: context.actorUserId,
            publicExplanation, hasStateConflict: false,
            updatedAt: context.createdAt, resolvedAt: context.createdAt
          });
          if (!resolved) throw new AppError('申诉状态已经变化，请刷新后重试', 409, 'APPEAL_VERSION_CONFLICT');
          audit(tx, context, {
            action: exceptionalSelfReview ? 'appeal.self_review_exception' : 'appeal.upheld',
            objectType: 'appeal', objectId: id,
            before: { status: appeal.status, version: appeal.version },
            after: { status: 'resolved', result: 'upheld', version: version + 1 },
            metadata: { reason: internalNote, exceptionalSelfReview }
          });
          tx.createMandatoryNotification(appeal.appellantUserId, '你的申诉已完成复核', publicExplanation, '/account/appeals', context.createdAt);
          return { appeal: resolved, conflict: false };
        }

        const originalAction = tx.getAction(appeal.moderationActionId);
        let current;
        let targetType;
        let targetId;
        let currentVersion;
        let currentStatus;
        if (originalAction.videoId) {
          current = tx.getVideo(originalAction.videoId);
          targetType = 'video'; targetId = originalAction.videoId;
          currentVersion = current?.moderation_version; currentStatus = current?.moderation_status;
        } else if (originalAction.discussionId) {
          current = tx.getDiscussion(originalAction.discussionId);
          targetType = 'discussion'; targetId = originalAction.discussionId;
          currentVersion = current?.moderation_version; currentStatus = current?.moderation_status;
          if (current?.deleted_at !== null) current = null;
        } else {
          current = tx.getUser(originalAction.userId);
          targetType = 'user'; targetId = originalAction.userId;
          currentVersion = current?.governance_version; currentStatus = current?.status;
        }
        const expectedAfterStatus = originalAction.after.moderationStatus ?? originalAction.after.status;
        if (!current || currentVersion !== originalAction.afterVersion || currentStatus !== expectedAfterStatus) {
          const conflicted = tx.resolveAppeal(id, version, {
            status: 'in_review', result: null, reviewerUserId: context.actorUserId,
            publicExplanation: null, hasStateConflict: true,
            updatedAt: context.createdAt, resolvedAt: null
          });
          if (!conflicted) throw new AppError('申诉状态已经变化，请刷新后重试', 409, 'APPEAL_VERSION_CONFLICT');
          audit(tx, context, {
            action: 'appeal.overturn_conflict', objectType: 'appeal', objectId: id,
            before: { status: appeal.status, version: appeal.version },
            after: { status: 'in_review', hasStateConflict: true, version: version + 1 },
            metadata: { targetType, targetId, currentVersion, expectedVersion: originalAction.afterVersion, reason: internalNote }
          });
          return { appeal: conflicted, conflict: true };
        }

        const restoreStatus = originalAction.before.moderationStatus ?? originalAction.before.status;
        let changed = 0;
        if (targetType === 'video') changed = tx.updateVideoModeration(targetId, currentVersion, restoreStatus);
        else if (targetType === 'discussion') changed = tx.updateDiscussionModeration(targetId, currentVersion, restoreStatus);
        else changed = tx.updateUserStatus(targetId, currentVersion, restoreStatus, context.createdAt);
        if (changed !== 1) throw new AppError('目标状态已经变化，请刷新后重试', 409, 'APPEAL_TARGET_CONFLICT');
        const reversalBefore = targetType === 'video'
          ? safeVideo(current)
          : targetType === 'discussion' ? safeDiscussion(current) : safeGovernanceUser(current);
        const updatedTarget = targetType === 'video'
          ? tx.getVideo(targetId)
          : targetType === 'discussion' ? tx.getDiscussion(targetId) : tx.getUser(targetId);
        const reversalAfter = targetType === 'video'
          ? safeVideo(updatedTarget)
          : targetType === 'discussion' ? safeDiscussion(updatedTarget) : safeGovernanceUser(updatedTarget);
        const reversalAction = tx.insertAction({
          caseId: originalAction.caseId,
          actorUserId: context.actorUserId,
          affectedUserId: originalAction.affectedUserId,
          videoId: targetType === 'video' ? targetId : null,
          discussionId: targetType === 'discussion' ? targetId : null,
          userId: targetType === 'user' ? targetId : null,
          action: 'appeal_overturn', publicReason: publicExplanation, internalNote,
          before: reversalBefore, after: reversalAfter,
          beforeVersion: currentVersion, afterVersion: currentVersion + 1,
          reversesActionId: originalAction.id, createdAt: context.createdAt
        });
        const resolved = tx.resolveAppeal(id, version, {
          status: 'resolved', result: 'overturned', reviewerUserId: context.actorUserId,
          publicExplanation, hasStateConflict: false,
          updatedAt: context.createdAt, resolvedAt: context.createdAt
        });
        if (!resolved) throw new AppError('申诉状态已经变化，请刷新后重试', 409, 'APPEAL_VERSION_CONFLICT');
        audit(tx, context, {
          action: exceptionalSelfReview ? 'appeal.self_review_exception' : 'appeal.overturned',
          objectType: 'appeal', objectId: id,
          before: { status: appeal.status, version: appeal.version },
          after: { status: 'resolved', result: 'overturned', version: version + 1 },
          metadata: { targetType, targetId, reversalActionId: reversalAction.id, reason: internalNote, exceptionalSelfReview }
        });
        tx.createMandatoryNotification(appeal.appellantUserId, '你的申诉已撤销原决定', publicExplanation, '/account/appeals', context.createdAt);
        return { appeal: resolved, conflict: false, reversalAction };
      });
    },

    resolveAppealConflict(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.appealId, '申诉编号', 1);
      const version = expectedVersion(input.expectedVersion);
      const targetVersion = integer(input.expectedTargetVersion, '目标页面版本', 0);
      const targetStatus = String(input.targetStatus ?? '');
      const publicExplanation = requiredText(input.publicExplanation, '公开说明', 1, 2000);
      const internalNote = requiredText(input.internalNote, '内部说明', 1, 4000);
      return store.transaction((tx) => {
        const appeal = tx.getAppeal(id);
        if (!appeal) throw new AppError('找不到申诉', 404, 'APPEAL_NOT_FOUND');
        const accountOnly = appeal.action === 'user_suspend';
        const reviewer = assertCurrentActor(tx, context, { administrator: accountOnly });
        if (appeal.version !== version) {
          throw new AppError('申诉状态已经变化，请刷新后重试', 409, 'APPEAL_VERSION_CONFLICT');
        }
        if (
          appeal.status !== 'in_review'
          || appeal.reviewerUserId === null
          || !appeal.hasStateConflict
        ) {
          throw new AppError('该申诉当前不需要人工冲突处理', 409, 'APPEAL_CONFLICT_NOT_FOUND');
        }
        if (appeal.reviewerUserId !== context.actorUserId) {
          throw new AppError('只有当前复核人可以处理这项冲突', 403, 'APPEAL_ALREADY_CLAIMED');
        }
        const exceptionalSelfReview = assertAppealReviewerIsIndependent(
          tx, appeal, reviewer, accountOnly
        );
        const originalAction = tx.getAction(appeal.moderationActionId);
        if (!originalAction) throw new AppError('找不到原审核动作', 404, 'ACTION_NOT_FOUND');

        let current;
        let targetType;
        let targetId;
        let currentVersion;
        let currentStatus;
        let unavailableForRestore = false;
        if (originalAction.videoId) {
          targetType = 'video'; targetId = originalAction.videoId;
          current = tx.getVideo(targetId);
          currentVersion = current?.moderation_version;
          currentStatus = current?.moderation_status;
          unavailableForRestore = current?.deleted_at !== null;
        } else if (originalAction.discussionId) {
          targetType = 'discussion'; targetId = originalAction.discussionId;
          current = tx.getDiscussion(targetId);
          currentVersion = current?.moderation_version;
          currentStatus = current?.moderation_status;
          unavailableForRestore = current?.deleted_at !== null;
        } else {
          targetType = 'user'; targetId = originalAction.userId;
          current = tx.getUser(targetId);
          currentVersion = current?.governance_version;
          currentStatus = current?.status;
          unavailableForRestore = current?.deleted_at !== null || current?.status === 'disabled';
        }
        if (!current) throw new AppError('申诉目标已不存在', 409, 'APPEAL_TARGET_UNAVAILABLE');
        if (currentVersion !== targetVersion) {
          throw new AppError('目标状态已经变化，请刷新后重试', 409, 'APPEAL_TARGET_CONFLICT');
        }

        const restoreStatus = originalAction.before.moderationStatus ?? originalAction.before.status;
        const validRestoreStatuses = targetType === 'user'
          ? ['active', 'suspended']
          : ['visible', 'hidden', 'removed'];
        if (!validRestoreStatuses.includes(restoreStatus)) {
          throw new AppError('原决定缺少可恢复的状态快照', 409, 'APPEAL_SNAPSHOT_INVALID');
        }
        if (targetStatus !== restoreStatus && targetStatus !== currentStatus) {
          throw new ValidationError('人工处理只能恢复原状态或保留当前状态');
        }

        const keepCurrent = targetStatus === currentStatus;
        if (!keepCurrent && unavailableForRestore) {
          throw new AppError(
            '目标已由作者删除或账号已停用，只能保留当前状态',
            409,
            'APPEAL_TARGET_UNAVAILABLE'
          );
        }

        const reversalBefore = targetType === 'video'
          ? safeVideo(current)
          : targetType === 'discussion' ? safeDiscussion(current) : safeGovernanceUser(current);
        let afterVersion = currentVersion;
        let updatedTarget = current;
        if (!keepCurrent) {
          let changed = 0;
          if (targetType === 'video') {
            changed = tx.updateVideoModeration(targetId, currentVersion, restoreStatus);
          } else if (targetType === 'discussion') {
            changed = tx.updateDiscussionModeration(targetId, currentVersion, restoreStatus);
          } else {
            changed = tx.updateUserStatus(targetId, currentVersion, restoreStatus, context.createdAt);
          }
          if (changed !== 1) {
            throw new AppError('目标状态已经变化，请刷新后重试', 409, 'APPEAL_TARGET_CONFLICT');
          }
          afterVersion += 1;
          updatedTarget = targetType === 'video'
            ? tx.getVideo(targetId)
            : targetType === 'discussion' ? tx.getDiscussion(targetId) : tx.getUser(targetId);
        }
        const reversalAfter = targetType === 'video'
          ? safeVideo(updatedTarget)
          : targetType === 'discussion' ? safeDiscussion(updatedTarget) : safeGovernanceUser(updatedTarget);
        const reversalAction = tx.insertAction({
          caseId: originalAction.caseId,
          actorUserId: context.actorUserId,
          affectedUserId: originalAction.affectedUserId,
          videoId: targetType === 'video' ? targetId : null,
          discussionId: targetType === 'discussion' ? targetId : null,
          userId: targetType === 'user' ? targetId : null,
          action: 'appeal_overturn', publicReason: publicExplanation, internalNote,
          before: reversalBefore, after: reversalAfter,
          beforeVersion: currentVersion, afterVersion,
          reversesActionId: originalAction.id, createdAt: context.createdAt
        });
        const resolved = tx.resolveAppeal(id, version, {
          status: 'resolved', result: 'overturned', reviewerUserId: context.actorUserId,
          publicExplanation, hasStateConflict: false,
          updatedAt: context.createdAt, resolvedAt: context.createdAt
        });
        if (!resolved) {
          throw new AppError('申诉状态已经变化，请刷新后重试', 409, 'APPEAL_VERSION_CONFLICT');
        }
        const resolutionMode = keepCurrent ? 'keep_current' : 'apply_original_before';
        audit(tx, context, {
          action: exceptionalSelfReview
            ? 'appeal.self_review_conflict_resolution_exception'
            : 'appeal.conflict_resolved',
          objectType: 'appeal', objectId: id,
          before: { status: appeal.status, hasStateConflict: true, version: appeal.version },
          after: { status: 'resolved', result: 'overturned', version: version + 1 },
          metadata: {
            targetType, targetId, targetVersion, targetStatus,
            resolutionMode, reversalActionId: reversalAction.id,
            reason: internalNote, exceptionalSelfReview
          }
        });
        tx.createMandatoryNotification(
          appeal.appellantUserId,
          '你的申诉已完成人工复核',
          publicExplanation,
          '/account/appeals',
          context.createdAt
        );
        return { appeal: resolved, conflict: false, resolutionMode, reversalAction };
      });
    },

    markCmsReauthenticated(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const tokenHash = String(input.sessionTokenHash ?? '');
      return store.transaction((tx) => {
        assertCurrentActor(tx, context);
        if (tx.updateSessionCmsVerifiedAt(tokenHash, context.actorUserId, context.createdAt) !== 1) {
          throw new AppError('当前会话已经失效', 401, 'SESSION_EXPIRED');
        }
        audit(tx, context, {
          action: 'cms.reauthenticated', objectType: 'session', objectId: tokenHash.slice(0, 12),
          after: { cmsVerifiedAt: context.createdAt }
        });
        return context.createdAt;
      });
    },

    grantPrivateMedia(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const caseId = integer(input.caseId, '案件编号', 1);
      const caseVersion = expectedVersion(input.expectedVersion);
      const videoId = String(input.videoId ?? '');
      const reason = requiredText(input.reason, '授权理由', 1, 1000);
      const sessionTokenHash = String(input.sessionTokenHash ?? '');
      return store.transaction((tx) => {
        assertCurrentActor(tx, context);
        const currentCase = tx.getCase(caseId);
        if (!currentCase || currentCase.videoId !== videoId) {
          throw new AppError('案件与视频不匹配', 409, 'CASE_TARGET_MISMATCH');
        }
        assertCaseTargetIsIndependent(tx, currentCase, context.actorUserId);
        if (currentCase.version !== caseVersion) {
          throw new AppError('案件状态已经变化，请刷新后重试', 409, 'CASE_VERSION_CONFLICT');
        }
        if (currentCase.status !== 'in_review') {
          throw new AppError('必须先认领案件再申请私密媒体访问', 409, 'CASE_STATE_CONFLICT');
        }
        if (currentCase.assigneeUserId !== context.actorUserId) {
          throw new AppError('只有当前案件负责人可以申请私密媒体访问', 403, 'CASE_ASSIGNMENT_FORBIDDEN');
        }
        const video = tx.getVideo(videoId);
        if (!video || video.deleted_at !== null) throw new AppError('找不到视频', 404, 'VIDEO_NOT_FOUND');
        if (!tx.sessionBelongsToUser(sessionTokenHash, context.actorUserId, context.createdAt)) {
          throw new AppError('当前会话已经失效', 401, 'SESSION_EXPIRED');
        }
        const expiresAt = new Date(Date.parse(context.createdAt) + mediaGrantMs).toISOString();
        const grant = tx.upsertMediaGrant({
          sessionTokenHash, caseId, videoId, grantedByUserId: context.actorUserId,
          reason, grantedAt: context.createdAt, expiresAt
        });
        audit(tx, context, {
          action: 'media.private_access_granted', objectType: 'video', objectId: videoId,
          after: { caseId, expiresAt }, metadata: { reason }
        });
        return grant;
      });
    },

    createCategory(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) throw new ValidationError('分类 slug 格式无效');
      const name = requiredText(input.name, '分类名称', 1, 40);
      const description = optionalText(input.description, '分类说明', 240);
      const parentId = input.parentId ? integer(input.parentId, '父分类', 1) : null;
      const categorySortOrder = sortOrder(input.sortOrder ?? 0);
      const commandReason = requiredText(input.internalReason, '变更理由', 1, 1000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        if (tx.getCategoryBySlug(slug)) throw new AppError('分类 slug 已存在', 409, 'CATEGORY_SLUG_EXISTS');
        if (tx.getCategoryByName(name)) throw new AppError('分类名称已存在', 409, 'CATEGORY_NAME_EXISTS');
        if (parentId) {
          const parent = tx.getCategory(parentId);
          if (!parent || parent.parent_id !== null) throw new ValidationError('分类目前最多两级');
          if (parent.is_active !== 1) throw new ValidationError('不能在已停用的父分类下创建分类');
        }
        const created = tx.insertCategory({ slug, name, description, parentId, sortOrder: categorySortOrder, createdAt: context.createdAt });
        audit(tx, context, {
          action: 'taxonomy.category_created', objectType: 'category', objectId: created.id,
          after: { slug, name, parentId, sortOrder: categorySortOrder, isActive: true }, metadata: { reason: commandReason }
        });
        return created;
      });
    },

    updateCategory(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.categoryId, '分类编号', 1);
      const expectedUpdatedAt = String(input.expectedUpdatedAt ?? '');
      const name = requiredText(input.name, '分类名称', 1, 40);
      const description = optionalText(input.description, '分类说明', 240);
      const parentId = input.parentId ? integer(input.parentId, '父分类', 1) : null;
      const categorySortOrder = sortOrder(input.sortOrder ?? 0);
      const isActive = input.isActive === true || input.isActive === '1' || input.isActive === 'on';
      const commandReason = requiredText(input.internalReason, '变更理由', 1, 1000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        const current = tx.getCategory(id);
        if (!current) throw new AppError('找不到分类', 404, 'CATEGORY_NOT_FOUND');
        const sameName = tx.getCategoryByName(name);
        if (sameName && sameName.id !== id) {
          throw new AppError('分类名称已存在', 409, 'CATEGORY_NAME_EXISTS');
        }
        if (parentId === id) throw new ValidationError('分类不能成为自己的父级');
        if (parentId) {
          const parent = tx.getCategory(parentId);
          if (!parent || parent.parent_id !== null) throw new ValidationError('分类目前最多两级');
          if (isActive && parent.is_active !== 1) throw new ValidationError('有效分类不能隶属于已停用父分类');
          const hasChildren = tx.listAllCategories().some((entry) => entry.parent_id === id);
          if (hasChildren) throw new ValidationError('已有子分类的分类不能移动到第二级');
        }
        if (!isActive && tx.listAllCategories().some((entry) => entry.parent_id === id && entry.is_active === 1)) {
          throw new ValidationError('请先停用该分类的有效子分类');
        }
        const updatedAt = nextIsoVersion(current.updated_at, context.createdAt);
        const updated = tx.updateCategory(id, expectedUpdatedAt, {
          name, description, parentId, sortOrder: categorySortOrder, isActive, updatedAt
        });
        if (!updated) throw new AppError('分类已经被其他管理员修改', 409, 'CATEGORY_VERSION_CONFLICT');
        audit(tx, context, {
          action: 'taxonomy.category_updated', objectType: 'category', objectId: id,
          before: { slug: current.slug, name: current.name, parentId: current.parent_id, sortOrder: current.sort_order, isActive: current.is_active === 1 },
          after: { slug: current.slug, name, parentId, sortOrder: categorySortOrder, isActive }, metadata: { reason: commandReason }
        });
        return updated;
      });
    },

    createTag(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) throw new ValidationError('标签 slug 格式无效');
      const name = requiredText(input.name, '标签名称', 1, 32);
      const commandReason = requiredText(input.internalReason, '变更理由', 1, 1000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        const existing = tx.listAllTags().find((tag) => tag.slug.toLowerCase() === slug);
        if (existing) throw new AppError('标签 slug 已存在；停用标签不能重新创建', 409, 'TAG_SLUG_EXISTS');
        const created = tx.insertTag({ slug, name, createdBy: context.actorUserId, createdAt: context.createdAt });
        audit(tx, context, {
          action: 'taxonomy.tag_created', objectType: 'tag', objectId: created.id,
          after: { slug, name, isActive: true }, metadata: { reason: commandReason }
        });
        return created;
      });
    },

    updateTag(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.tagId, '标签编号', 1);
      const expectedUpdatedAt = String(input.expectedUpdatedAt ?? '');
      const name = requiredText(input.name, '标签名称', 1, 32);
      const isActive = input.isActive === true || input.isActive === '1' || input.isActive === 'on';
      const commandReason = requiredText(input.internalReason, '变更理由', 1, 1000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        const current = tx.getTag(id);
        if (!current) throw new AppError('找不到标签', 404, 'TAG_NOT_FOUND');
        if (current.merged_into_id !== null) throw new AppError('已合并标签不能再次修改', 409, 'TAG_ALREADY_MERGED');
        const updatedAt = nextIsoVersion(current.updated_at, context.createdAt);
        const updated = tx.updateTag(id, expectedUpdatedAt, { name, isActive, updatedAt });
        if (!updated) throw new AppError('标签已经被其他管理员修改', 409, 'TAG_VERSION_CONFLICT');
        audit(tx, context, {
          action: 'taxonomy.tag_updated', objectType: 'tag', objectId: id,
          before: { slug: current.slug, name: current.name, isActive: current.is_active === 1 },
          after: { slug: current.slug, name, isActive }, metadata: { reason: commandReason }
        });
        return updated;
      });
    },

    mergeTag(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const sourceId = integer(input.sourceTagId, '源标签编号', 1);
      const targetId = integer(input.targetTagId, '目标标签编号', 1);
      const expectedUpdatedAt = String(input.expectedUpdatedAt ?? '');
      const commandReason = requiredText(input.internalReason, '合并理由', 1, 1000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        const source = tx.getTag(sourceId);
        const target = tx.getTag(targetId);
        if (!source || !target) throw new AppError('找不到标签', 404, 'TAG_NOT_FOUND');
        if (sourceId === targetId) throw new ValidationError('标签不能合并到自己');
        if (source.merged_into_id !== null || target.merged_into_id !== null || target.is_active !== 1) {
          throw new AppError('标签必须合并到有效的规范标签', 409, 'TAG_MERGE_TARGET_INVALID');
        }
        const updatedAt = nextIsoVersion(source.updated_at, context.createdAt);
        if (tx.mergeTag(sourceId, targetId, expectedUpdatedAt, updatedAt) !== 1) {
          throw new AppError('标签已经被其他管理员修改', 409, 'TAG_VERSION_CONFLICT');
        }
        audit(tx, context, {
          action: 'taxonomy.tag_merged', objectType: 'tag', objectId: sourceId,
          before: { slug: source.slug, isActive: source.is_active === 1, mergedIntoId: null },
          after: { slug: source.slug, isActive: false, mergedIntoId: targetId },
          metadata: { targetSlug: target.slug, reason: commandReason }
        });
        return tx.getTag(sourceId);
      });
    },

    retryVideoValidation(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = String(input.videoId ?? '');
      const expectedValidatedAt = nullableVersionToken(input.expectedValidatedAt, '验证完成时间版本');
      const expectedValidationStartedAt = nullableVersionToken(
        input.expectedValidationStartedAt,
        '验证开始时间版本'
      );
      const commandReason = requiredText(input.internalReason, '重试理由', 1, 1000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        const video = tx.getVideo(id);
        if (!video) throw new AppError('找不到视频', 404, 'VIDEO_NOT_FOUND');
        if (tx.retryVideoValidation(id, expectedValidatedAt, expectedValidationStartedAt) !== 1) {
          throw new AppError('只有 validation_failed 视频可以安全重试', 409, 'VALIDATION_RETRY_CONFLICT');
        }
        audit(tx, context, {
          action: 'task.video_validation_retried', objectType: 'video', objectId: id,
          before: {
            validationStatus: video.validation_status,
            validatedAt: video.validated_at,
            validationStartedAt: video.validation_started_at
          },
          after: {
            validationStatus: 'pending',
            validatedAt: video.validated_at,
            validationStartedAt: null
          },
          metadata: { reason: commandReason }
        });
        return tx.getVideo(id);
      });
    },

    retryDeletion(input, rawContext = {}) {
      const context = actorContext(rawContext);
      const id = integer(input.deletionId, '删除任务编号', 1);
      const expectedUpdatedAt = String(input.expectedUpdatedAt ?? '');
      if (!expectedUpdatedAt) throw new ValidationError('页面版本无效');
      const commandReason = requiredText(input.internalReason, '重试理由', 1, 1000);
      return store.transaction((tx) => {
        assertCurrentActor(tx, context, { administrator: true });
        const current = tx.getDeletionTask(id);
        if (!current) throw new AppError('找不到删除任务', 404, 'DELETION_TASK_NOT_FOUND');
        const updatedAt = nextIsoVersion(current.updated_at, context.createdAt);
        if (tx.retryDeletion(id, expectedUpdatedAt, updatedAt) !== 1) {
          throw new AppError('删除任务已经变化，或尚未失败', 409, 'DELETION_RETRY_CONFLICT');
        }
        audit(tx, context, {
          action: 'task.file_deletion_retried', objectType: 'file_deletion', objectId: id,
          before: { attemptCount: current.attempt_count, nextAttemptAt: current.next_attempt_at },
          after: { attemptCount: current.attempt_count, nextAttemptAt: updatedAt },
          metadata: { kind: current.kind, reason: commandReason }
        });
        return tx.getDeletionTask(id);
      });
    }
  };

  return service;
}
