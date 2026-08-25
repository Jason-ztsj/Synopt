import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCmsRouter } from '../../src/cms.js';
import { openDatabase } from '../../src/database.js';
import { createGovernanceService } from '../../src/governance.js';

const T0 = '2026-08-25T00:00:00.000Z';
const DESCRIPTION = '这是一段足够详细的治理调查说明，用于验证后台安全边界。';
const APPEAL_REASON = '我认为这项治理决定遗漏了重要上下文，希望由独立工作人员重新复核。';

async function withDatabase(prefix, action) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  let database;
  try {
    database = openDatabase(path.join(directory, 'test.sqlite'));
    return await action(database, createGovernanceService(database.governance));
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function seedUser(database, id, role = 'member', status = 'active') {
  database.createUser({
    id,
    username: id.replaceAll('-', '_'),
    displayName: `用户 ${id}`,
    passwordHash: `scrypt-test-${id}`,
    createdAt: T0
  });
  database.raw.prepare('UPDATE users SET role = ?, status = ? WHERE id = ?')
    .run(role, status, id);
  return database.governance.getUser(id);
}

function seedVideo(database, id, userId) {
  return database.insertVideo({
    id,
    title: `视频 ${id}`,
    creator: `创作者 ${id}`,
    description: '安全回归测试视频',
    licenseCode: 'CC-BY-4.0',
    storageName: `${id}.mp4`,
    originalFilename: `${id}.mp4`,
    mediaType: 'video/mp4',
    byteSize: 128,
    validationStatus: 'ready',
    userId,
    visibility: 'public',
    moderationStatus: 'visible',
    createdAt: '2026-08-25T00:10:00.000Z'
  });
}

function seedDiscussion(database, videoId, userId, suffix) {
  return database.insertDiscussion({
    videoId,
    userId,
    nickname: `讨论者 ${suffix}`,
    title: `讨论 ${suffix}`,
    bodyMarkdown: `讨论正文 ${suffix}`,
    createdAt: '2026-08-25T00:15:00.000Z'
  });
}

function context(actorUserId, suffix, createdAt = '2026-08-25T01:00:00.000Z') {
  return { actorUserId, requestId: `cms-security-${suffix}`, createdAt };
}

function appError(code, status) {
  return (error) => error?.code === code && error?.status === status;
}

function statusError(status) {
  return (error) => error?.status === status;
}

function cmsRouter(database, service) {
  return createCmsRouter({
    database,
    service,
    config: {
      authCooldownSeconds: 1,
      cmsReauthMs: 30 * 60 * 1000,
      cmsReauthMinutes: 30,
      cmsPrivateMediaGrantMs: 15 * 60 * 1000,
      appealWindowDays: 30,
      videoStoragePath: tmpdir()
    },
    assertCsrf() {},
    now: () => Date.parse('2026-08-25T12:00:00.000Z')
  });
}

function invokeCmsRoute(router, routePath, method, request = {}) {
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods?.[method]
  ));
  assert.ok(layer, `应注册 ${method.toUpperCase()} ${routePath}`);
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const capture = { rendered: null, redirected: null, headers: new Map() };
  const response = {
    set(name, value) { capture.headers.set(name, value); return this; },
    render(view, locals) { capture.rendered = { view, locals }; finish?.(); },
    redirect(status, location) { capture.redirected = { status, location }; finish?.(); }
  };
  const normalizedRequest = {
    method: method.toUpperCase(),
    originalUrl: routePath,
    params: {},
    query: {},
    body: {},
    requestId: 'cms-security-route-request',
    ...request
  };
  let finish;
  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      resolve(capture);
    };
    finish = complete;
    const dispatch = (index) => {
      if (settled) return;
      if (index >= handlers.length) {
        complete();
        return;
      }
      try {
        const returned = handlers[index](normalizedRequest, response, (error) => {
          if (settled) return;
          if (error) {
            settled = true;
            reject(error);
            return;
          }
          dispatch(index + 1);
        });
        if (returned && typeof returned.then === 'function') {
          returned.catch((error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      } catch (error) {
        settled = true;
        reject(error);
      }
    };
    dispatch(0);
  });
}

function createClaimedVideoCase(service, actorUserId, videoId, suffix, startHour = 1) {
  const moderationCase = service.createInvestigation({
    videoId,
    reasonCategory: 'other',
    description: DESCRIPTION
  }, context(actorUserId, `${suffix}-create`, `2026-08-25T${String(startHour).padStart(2, '0')}:00:00.000Z`));
  return service.claimCase({
    caseId: moderationCase.id,
    expectedVersion: moderationCase.version,
    internalReason: '认领案件以进行独立审核'
  }, context(actorUserId, `${suffix}-claim`, `2026-08-25T${String(startHour).padStart(2, '0')}:10:00.000Z`));
}

function moderateVideo(service, actorUserId, videoId, caseId, expectedVersion, command, suffix, createdAt) {
  return service.moderateVideo({
    videoId,
    caseId,
    expectedVersion,
    command,
    publicReason: `视频 ${command} 的公开治理说明`,
    internalNote: `视频 ${command} 的内部治理说明`
  }, context(actorUserId, suffix, createdAt));
}

function createConflictedAppeal(database, service, suffix, hourOffset = 1) {
  const owner = seedUser(database, `${suffix}-owner`);
  const originalActor = seedUser(database, `${suffix}-original`, 'moderator');
  const reviewer = seedUser(database, `${suffix}-reviewer`, 'moderator');
  const videoId = `${suffix}-video`;
  seedVideo(database, videoId, owner.id);
  const hour = (offset) => `2026-08-2${hourOffset}T${String(offset).padStart(2, '0')}:00:00.000Z`;
  const claimedCase = createClaimedVideoCase(service, originalActor.id, videoId, suffix, 1);
  const originalAction = moderateVideo(
    service,
    originalActor.id,
    videoId,
    claimedCase.id,
    0,
    'hide',
    `${suffix}-hide`,
    hour(2)
  );
  const appeal = service.submitAppeal({
    moderationActionId: originalAction.id,
    reason: APPEAL_REASON
  }, context(owner.id, `${suffix}-appeal`, hour(3)));
  const claimedAppeal = service.claimAppeal({
    appealId: appeal.id,
    expectedVersion: appeal.version,
    internalReason: '由非原操作者认领申诉'
  }, context(reviewer.id, `${suffix}-appeal-claim`, hour(4)));
  moderateVideo(
    service,
    originalActor.id,
    videoId,
    claimedCase.id,
    1,
    'remove',
    `${suffix}-remove`,
    hour(5)
  );
  const conflict = service.reviewAppeal({
    appealId: appeal.id,
    expectedVersion: claimedAppeal.version,
    result: 'overturned',
    publicExplanation: '复核认为原决定应撤销，但目标已有后续治理状态。',
    internalNote: '检测到后续治理动作，进入显式人工冲突处理。'
  }, context(reviewer.id, `${suffix}-detect-conflict`, hour(6)));
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.appeal.status, 'in_review');
  assert.equal(conflict.appeal.hasStateConflict, true);
  return {
    owner,
    originalActor,
    reviewer,
    videoId,
    caseId: claimedCase.id,
    appealId: appeal.id,
    appealVersion: conflict.appeal.version
  };
}

test('双重身份工作人员不能认领、转交本人内容案件，也不能管理本人申诉', async () => {
  await withDatabase('tongjian-cms-self-interest-', (database, service) => {
    const ownerAdministrator = seedUser(database, 'self-owner-admin', 'administrator');
    const moderatorA = seedUser(database, 'self-moderator-a', 'moderator');
    const moderatorB = seedUser(database, 'self-moderator-b', 'moderator');
    seedVideo(database, 'self-owned-video', ownerAdministrator.id);

    assert.throws(() => service.createInvestigation({
      videoId: 'self-owned-video',
      reasonCategory: 'other',
      description: DESCRIPTION
    }, context(ownerAdministrator.id, 'self-investigation')), appError('SELF_REVIEW_FORBIDDEN', 403));

    const claimedCase = createClaimedVideoCase(
      service,
      moderatorA.id,
      'self-owned-video',
      'self-owned-case'
    );
    assert.throws(() => service.claimCase({
      caseId: claimedCase.id,
      expectedVersion: claimedCase.version,
      internalReason: '本人不能接手涉及自己内容的案件'
    }, context(ownerAdministrator.id, 'self-claim')), appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.transferCase({
      caseId: claimedCase.id,
      expectedVersion: claimedCase.version,
      assigneeUserId: moderatorB.id,
      internalReason: '内容作者不能利用管理员身份转交本人案件'
    }, context(ownerAdministrator.id, 'self-transfer')), appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.equal(service.store.getCase(claimedCase.id).assigneeUserId, moderatorA.id);

    const originalAction = moderateVideo(
      service,
      moderatorA.id,
      'self-owned-video',
      claimedCase.id,
      0,
      'hide',
      'self-owned-hide',
      '2026-08-25T02:00:00.000Z'
    );
    const appeal = service.submitAppeal({
      moderationActionId: originalAction.id,
      reason: APPEAL_REASON
    }, context(ownerAdministrator.id, 'self-appeal-submit', '2026-08-25T03:00:00.000Z'));
    assert.throws(() => service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: '本人不能认领自己的申诉'
    }, context(ownerAdministrator.id, 'self-appeal-claim')), appError('SELF_APPEAL_REVIEW_FORBIDDEN', 403));
    const claimedAppeal = service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: '独立工作人员认领申诉'
    }, context(moderatorB.id, 'self-appeal-claim', '2026-08-25T04:00:00.000Z'));

    assert.throws(() => service.transferAppeal({
      appealId: appeal.id,
      expectedVersion: claimedAppeal.version,
      reviewerUserId: moderatorA.id,
      internalReason: '申诉人不能利用管理员身份控制复核人分配'
    }, context(ownerAdministrator.id, 'self-appeal-transfer')), statusError(403));
    assert.throws(() => service.reviewAppeal({
      appealId: appeal.id,
      expectedVersion: claimedAppeal.version,
      result: 'upheld',
      publicExplanation: '不应由申诉人本人提交复核结论。',
      internalNote: '本人申诉必须回避。'
    }, context(ownerAdministrator.id, 'self-appeal-review')), appError('APPEAL_ALREADY_CLAIMED', 409));

    const storedAppeal = service.store.getAppeal(appeal.id);
    assert.equal(storedAppeal.status, 'in_review');
    assert.equal(storedAppeal.reviewerUserId, moderatorB.id);
    assert.equal(storedAppeal.version, claimedAppeal.version);
  });
});

test('工作人员举报后不能处理该案件或申诉，CMS 查询也不泄露相关内部信息', async () => {
  await withDatabase('tongjian-cms-staff-reporter-', (database, service) => {
    const owner = seedUser(database, 'staff-report-owner');
    const otherOwner = seedUser(database, 'staff-report-other-owner');
    const staffReporter = seedUser(database, 'staff-reporter', 'moderator');
    const caseHandler = seedUser(database, 'staff-report-handler', 'moderator');
    const appealReviewer = seedUser(database, 'staff-report-appeal-reviewer', 'moderator');
    const administrator = seedUser(database, 'staff-report-admin', 'administrator');
    seedVideo(database, 'staff-reported-video', owner.id);
    seedVideo(database, 'staff-report-unrelated-video', otherOwner.id);
    const reportedDiscussion = seedDiscussion(
      database,
      'staff-report-unrelated-video',
      owner.id,
      'staff-reported-discussion'
    );

    const reportedCase = service.createReport({
      videoId: 'staff-reported-video',
      reasonCategory: 'privacy_copyright',
      description: '举报人不应以工作人员身份参与这个案件的内部处理。'
    }, context(staffReporter.id, 'staff-reporter-create', '2026-08-25T00:20:00.000Z'));
    const unrelatedCase = service.createInvestigation({
      videoId: 'staff-report-unrelated-video',
      reasonCategory: 'other',
      description: 'UNRELATED_AUDIT_SENTINEL：这条无关调查应保留在管理员审计结果中。'
    }, context(caseHandler.id, 'staff-reporter-unrelated', '2026-08-25T00:25:00.000Z'));

    assert.throws(() => service.claimCase({
      caseId: reportedCase.id,
      expectedVersion: reportedCase.version,
      internalReason: '举报人不能认领自己提交的案件'
    }, context(staffReporter.id, 'staff-reporter-claim')), appError('SELF_REVIEW_FORBIDDEN', 403));
    const claimed = service.claimCase({
      caseId: reportedCase.id,
      expectedVersion: reportedCase.version,
      internalReason: '由独立工作人员认领举报案件'
    }, context(caseHandler.id, 'staff-reporter-independent-claim'));
    const auditCountBeforeForbiddenCaseCommands = database.raw
      .prepare('SELECT count(*) AS count FROM audit_events').get().count;
    const noteCountBeforeForbiddenCaseCommands = database.raw
      .prepare('SELECT count(*) AS count FROM case_notes').get().count;

    assert.throws(() => service.transferCase({
      caseId: reportedCase.id,
      expectedVersion: claimed.version,
      assigneeUserId: administrator.id,
      internalReason: '举报人不能利用工作人员权限转交案件'
    }, context(staffReporter.id, 'staff-reporter-transfer')), appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.transferCase({
      caseId: reportedCase.id,
      expectedVersion: claimed.version,
      assigneeUserId: staffReporter.id,
      internalReason: '管理员也不能把案件分配给举报人'
    }, context(administrator.id, 'staff-reporter-admin-transfer')), appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.addCaseNote({
      caseId: reportedCase.id,
      expectedVersion: claimed.version,
      body: '举报人不得向案件追加内部备注'
    }, context(staffReporter.id, 'staff-reporter-note')), appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.resolveCase({
      caseId: reportedCase.id,
      expectedVersion: claimed.version,
      resolution: 'no_violation',
      publicExplanation: '举报人不得以工作人员身份给出案件结论。',
      internalReason: '这个无效命令不应产生备注或审计副作用。'
    }, context(staffReporter.id, 'staff-reporter-resolve')), appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => moderateVideo(
      service,
      staffReporter.id,
      'staff-reported-video',
      reportedCase.id,
      0,
      'hide',
      'staff-reporter-moderate',
      '2026-08-25T01:30:00.000Z'
    ), appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.equal(service.store.getCase(reportedCase.id).assigneeUserId, caseHandler.id);
    assert.equal(service.store.getCase(reportedCase.id).version, claimed.version);
    assert.equal(
      database.raw.prepare('SELECT count(*) AS count FROM audit_events').get().count,
      auditCountBeforeForbiddenCaseCommands
    );
    assert.equal(
      database.raw.prepare('SELECT count(*) AS count FROM case_notes').get().count,
      noteCountBeforeForbiddenCaseCommands
    );

    const discussionCase = service.createReport({
      discussionId: reportedDiscussion.id,
      reasonCategory: 'harassment_hate',
      description: '同一工作人员举报的讨论也必须由独立人员处理。'
    }, context(staffReporter.id, 'staff-reporter-discussion-create', '2026-08-25T01:40:00.000Z'));
    service.claimCase({
      caseId: discussionCase.id,
      expectedVersion: discussionCase.version,
      internalReason: '独立认领举报人提交的讨论案件'
    }, context(caseHandler.id, 'staff-reporter-discussion-claim', '2026-08-25T01:45:00.000Z'));
    assert.throws(() => service.moderateDiscussion({
      discussionId: reportedDiscussion.id,
      caseId: discussionCase.id,
      expectedVersion: 0,
      command: 'hide',
      publicReason: '举报人不得直接处理自己举报的讨论。',
      internalNote: '无效讨论审核命令不应留下副作用。'
    }, context(staffReporter.id, 'staff-reporter-discussion-moderate', '2026-08-25T01:50:00.000Z')),
    appError('SELF_REVIEW_FORBIDDEN', 403));
    service.moderateDiscussion({
      discussionId: reportedDiscussion.id,
      caseId: discussionCase.id,
      expectedVersion: 0,
      command: 'hide',
      publicReason: '独立处理后决定暂时隐藏该讨论。',
      internalNote: 'STAFF_REPORT_DISCUSSION_SENTINEL：举报人不得从审计日志读取。'
    }, context(caseHandler.id, 'staff-reporter-independent-discussion-action', '2026-08-25T01:55:00.000Z'));

    const action = service.moderateVideo({
      videoId: 'staff-reported-video',
      caseId: reportedCase.id,
      expectedVersion: 0,
      command: 'hide',
      publicReason: '独立处理后决定暂时隐藏该视频。',
      internalNote: 'STAFF_REPORT_INTERNAL_SENTINEL：不应通过审计日志泄露给举报人。'
    }, context(caseHandler.id, 'staff-reporter-independent-action', '2026-08-25T02:00:00.000Z'));
    const appeal = service.submitAppeal({
      moderationActionId: action.id,
      reason: APPEAL_REASON
    }, context(owner.id, 'staff-reporter-appeal', '2026-08-25T03:00:00.000Z'));
    assert.throws(() => service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: '原案件举报人不能认领后续申诉'
    }, context(staffReporter.id, 'staff-reporter-appeal-claim')),
    appError('SELF_APPEAL_REVIEW_FORBIDDEN', 403));
    const claimedAppeal = service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: 'APPEAL_INTERNAL_SENTINEL：由独立人员复核申诉。'
    }, context(appealReviewer.id, 'staff-reporter-independent-appeal-claim'));
    const auditCountBeforeForbiddenAppealTransfers = database.raw
      .prepare('SELECT count(*) AS count FROM audit_events').get().count;
    assert.throws(() => service.transferAppeal({
      appealId: appeal.id,
      expectedVersion: claimedAppeal.version,
      reviewerUserId: administrator.id,
      internalReason: '原举报人不能转交该申诉'
    }, context(staffReporter.id, 'staff-reporter-appeal-transfer')),
    appError('SELF_APPEAL_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.transferAppeal({
      appealId: appeal.id,
      expectedVersion: claimedAppeal.version,
      reviewerUserId: staffReporter.id,
      internalReason: '管理员不能把申诉转交给原案件举报人'
    }, context(administrator.id, 'staff-reporter-admin-appeal-transfer')),
    appError('SELF_APPEAL_REVIEW_FORBIDDEN', 403));
    assert.equal(service.store.getAppeal(appeal.id).reviewerUserId, appealReviewer.id);
    assert.equal(service.store.getAppeal(appeal.id).version, claimedAppeal.version);
    assert.equal(
      database.raw.prepare('SELECT count(*) AS count FROM audit_events').get().count,
      auditCountBeforeForbiddenAppealTransfers
    );

    const cases = service.store.listCases({
      excludeReporterUserId: staffReporter.id,
      limit: 100
    });
    assert.deepEqual(cases.items.map((item) => item.id), [unrelatedCase.id]);
    assert.equal(cases.total, 1);
    const videos = service.store.listVideos({
      excludeReportedByUserId: staffReporter.id,
      limit: 100
    });
    assert.deepEqual(videos.items.map((item) => item.id), ['staff-report-unrelated-video']);
    assert.equal(videos.total, 1);
    const discussions = service.store.listDiscussions({
      excludeReportedByUserId: staffReporter.id,
      limit: 100
    });
    assert.deepEqual(discussions.items, []);
    assert.equal(discussions.total, 0);
    const appeals = service.store.listAppeals({
      status: 'unresolved',
      excludeActionCaseReporterUserId: staffReporter.id,
      limit: 100
    });
    assert.deepEqual(appeals.items, []);
    assert.equal(appeals.total, 0);
    assert.deepEqual(service.store.listRecentActions(100, {
      excludeCaseReporterUserId: staffReporter.id
    }), []);

    const dashboard = service.store.dashboard({
      viewerUserId: staffReporter.id,
      includeAdministrative: false
    });
    assert.equal(dashboard.openCaseCount, 1);
    assert.deepEqual(dashboard.pendingCases.map((item) => item.id), [unrelatedCase.id]);
    assert.equal(dashboard.pendingAppealCount, 0);
    assert.deepEqual(dashboard.recentActions, []);
    assert.deepEqual(
      dashboard.recentContent.map((item) => item.id),
      ['staff-report-unrelated-video']
    );

    const audit = service.store.listAudit({
      excludeRelatedUserId: staffReporter.id,
      limit: 100
    });
    assert.equal(audit.total, audit.items.length);
    assert.ok(audit.items.some((event) => (
      event.objectType === 'moderation_case' && event.objectId === String(unrelatedCase.id)
    )), '无关审计仍应可见');
    const serializedAudit = JSON.stringify(audit.items);
    assert.ok(serializedAudit.includes('UNRELATED_AUDIT_SENTINEL'));
    assert.ok(!serializedAudit.includes('STAFF_REPORT_INTERNAL_SENTINEL'));
    assert.ok(!serializedAudit.includes('STAFF_REPORT_DISCUSSION_SENTINEL'));
    assert.ok(!serializedAudit.includes('APPEAL_INTERNAL_SENTINEL'));
    assert.ok(!audit.items.some((event) => (
      event.objectType === 'video' && event.objectId === 'staff-reported-video'
    )));
    assert.ok(!audit.items.some((event) => (
      event.objectType === 'appeal' && event.objectId === String(appeal.id)
    )));
    assert.ok(!audit.items.some((event) => (
      event.objectType === 'discussion' && event.objectId === String(reportedDiscussion.id)
    )));
  });
});

test('原操作者唯一管理员例外不会把原案件举报人误算为可用复核人', async () => {
  await withDatabase('tongjian-cms-reporter-reviewer-count-', (database, service) => {
    const owner = seedUser(database, 'reviewer-count-owner');
    const staffReporter = seedUser(database, 'reviewer-count-reporter', 'moderator');
    const soleAdministrator = seedUser(database, 'reviewer-count-admin', 'administrator');
    seedVideo(database, 'reviewer-count-video', owner.id);

    const reportedCase = service.createReport({
      videoId: 'reviewer-count-video',
      reasonCategory: 'other',
      description: '此场景只有原操作者管理员和有利益冲突的举报人。'
    }, context(staffReporter.id, 'reviewer-count-report', '2026-08-25T00:20:00.000Z'));
    const claimed = service.claimCase({
      caseId: reportedCase.id,
      expectedVersion: reportedCase.version,
      internalReason: '由唯一管理员独立处理案件'
    }, context(soleAdministrator.id, 'reviewer-count-case-claim'));
    const action = moderateVideo(
      service,
      soleAdministrator.id,
      'reviewer-count-video',
      claimed.id,
      0,
      'hide',
      'reviewer-count-hide',
      '2026-08-25T02:00:00.000Z'
    );
    const appeal = service.submitAppeal({
      moderationActionId: action.id,
      reason: APPEAL_REASON
    }, context(owner.id, 'reviewer-count-appeal', '2026-08-25T03:00:00.000Z'));

    assert.equal(service.store.activeAlternativeReviewerCount(
      false,
      soleAdministrator.id,
      owner.id,
      'reviewer-count-video',
      null
    ), 0);
    assert.throws(() => service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: '举报人不能成为该案件申诉的复核人'
    }, context(staffReporter.id, 'reviewer-count-reporter-claim')),
    appError('SELF_APPEAL_REVIEW_FORBIDDEN', 403));

    const claimedAppeal = service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: '无独立复核人时使用唯一有效管理员例外'
    }, context(soleAdministrator.id, 'reviewer-count-unique-admin-claim'));
    assert.equal(claimedAppeal.reviewerUserId, soleAdministrator.id);
    assert.equal(claimedAppeal.status, 'in_review');
    assert.equal(
      database.raw.prepare(`
        SELECT count(*) AS count FROM audit_events
        WHERE action = 'appeal.self_review_claim_exception' AND object_id = ?
      `).get(String(appeal.id)).count,
      1
    );
  });
});

test('管理员可从失活复核人恢复申诉，但转交仍执行回避规则和版本 CAS', async () => {
  await withDatabase('tongjian-cms-appeal-transfer-', (database, service) => {
    const appellant = seedUser(database, 'transfer-appellant', 'moderator');
    const originalActor = seedUser(database, 'transfer-original', 'moderator');
    const inactiveReviewer = seedUser(database, 'transfer-inactive', 'moderator');
    const nextReviewer = seedUser(database, 'transfer-next', 'moderator');
    const administrator = seedUser(database, 'transfer-admin', 'administrator');
    seedVideo(database, 'transfer-video', appellant.id);

    const claimedCase = createClaimedVideoCase(
      service,
      originalActor.id,
      'transfer-video',
      'transfer-case'
    );
    const action = moderateVideo(
      service,
      originalActor.id,
      'transfer-video',
      claimedCase.id,
      0,
      'hide',
      'transfer-hide',
      '2026-08-25T02:00:00.000Z'
    );
    const appeal = service.submitAppeal({
      moderationActionId: action.id,
      reason: APPEAL_REASON
    }, context(appellant.id, 'transfer-submit', '2026-08-25T03:00:00.000Z'));
    const claimed = service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: '先由第一名独立复核人认领'
    }, context(inactiveReviewer.id, 'transfer-claim', '2026-08-25T04:00:00.000Z'));
    database.raw.prepare("UPDATE users SET status = 'suspended' WHERE id = ?")
      .run(inactiveReviewer.id);

    const transferred = service.transferAppeal({
      appealId: appeal.id,
      expectedVersion: claimed.version,
      reviewerUserId: nextReviewer.id,
      internalReason: '原复核人已失活，由管理员恢复案件流转'
    }, context(administrator.id, 'transfer-recover', '2026-08-25T05:00:00.000Z'));
    assert.equal(transferred.status, 'in_review');
    assert.equal(transferred.reviewerUserId, nextReviewer.id);
    assert.equal(transferred.version, claimed.version + 1);

    assert.throws(() => service.transferAppeal({
      appealId: appeal.id,
      expectedVersion: claimed.version,
      reviewerUserId: administrator.id,
      internalReason: '过期页面不能覆盖新的复核人'
    }, context(administrator.id, 'transfer-stale', '2026-08-25T05:01:00.000Z')), appError('APPEAL_VERSION_CONFLICT', 409));
    assert.equal(service.store.getAppeal(appeal.id).reviewerUserId, nextReviewer.id);

    assert.throws(() => service.transferAppeal({
      appealId: appeal.id,
      expectedVersion: transferred.version,
      reviewerUserId: originalActor.id,
      internalReason: '仍有独立复核人时不能转回原操作者'
    }, context(administrator.id, 'transfer-original-actor', '2026-08-25T05:02:00.000Z')),
    appError('ORIGINAL_ACTOR_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.transferAppeal({
      appealId: appeal.id,
      expectedVersion: transferred.version,
      reviewerUserId: appellant.id,
      internalReason: '申诉人永远不能成为自己的复核人'
    }, context(administrator.id, 'transfer-appellant', '2026-08-25T05:03:00.000Z')),
    appError('SELF_APPEAL_REVIEW_FORBIDDEN', 403));

    const stored = service.store.getAppeal(appeal.id);
    assert.equal(stored.reviewerUserId, nextReviewer.id);
    assert.equal(stored.version, transferred.version);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'appeal.transferred'").get().count, 1);
  });
});

test('申诉状态冲突可按原快照恢复，目标与申诉在同一事务内完成', async () => {
  await withDatabase('tongjian-cms-conflict-apply-', (database, service) => {
    const fixture = createConflictedAppeal(database, service, 'conflict-apply', 5);
    const before = service.store.getVideo(fixture.videoId);
    assert.deepEqual(
      [before.moderation_status, before.moderation_version],
      ['removed', 2]
    );

    const result = service.resolveAppealConflict({
      appealId: fixture.appealId,
      expectedVersion: fixture.appealVersion,
      expectedTargetVersion: before.moderation_version,
      targetStatus: 'visible',
      publicExplanation: '人工复核决定撤销原隐藏决定，并恢复原治理状态。',
      internalNote: '已核对后续动作，明确选择应用原动作之前的状态。'
    }, context(fixture.reviewer.id, 'conflict-apply-resolve', '2026-08-25T07:00:00.000Z'));

    assert.equal(result.resolutionMode, 'apply_original_before');
    assert.equal(result.appeal.status, 'resolved');
    assert.equal(result.appeal.result, 'overturned');
    assert.equal(result.reversalAction.action, 'appeal_overturn');
    assert.deepEqual(
      [service.store.getVideo(fixture.videoId).moderation_status,
        service.store.getVideo(fixture.videoId).moderation_version],
      ['visible', 3]
    );
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'appeal.conflict_resolved'").get().count, 1);
  });
});

test('申诉状态冲突可显式保留当前状态，且不会伪造目标版本递增', async () => {
  await withDatabase('tongjian-cms-conflict-keep-', (database, service) => {
    const fixture = createConflictedAppeal(database, service, 'conflict-keep', 6);
    const before = service.store.getVideo(fixture.videoId);
    const result = service.resolveAppealConflict({
      appealId: fixture.appealId,
      expectedVersion: fixture.appealVersion,
      expectedTargetVersion: before.moderation_version,
      targetStatus: before.moderation_status,
      publicExplanation: '原决定被撤销，但后续独立治理决定仍然有效，因此保留当前状态。',
      internalNote: '人工核对后选择保留后续治理动作形成的当前状态。'
    }, context(fixture.reviewer.id, 'conflict-keep-resolve', '2026-08-25T07:00:00.000Z'));

    assert.equal(result.resolutionMode, 'keep_current');
    assert.equal(result.appeal.result, 'overturned');
    assert.equal(result.reversalAction.beforeVersion, before.moderation_version);
    assert.equal(result.reversalAction.afterVersion, before.moderation_version);
    assert.deepEqual(
      [service.store.getVideo(fixture.videoId).moderation_status,
        service.store.getVideo(fixture.videoId).moderation_version],
      [before.moderation_status, before.moderation_version]
    );
  });
});

test('人工冲突处理拒绝篡改状态，并在目标版本过期时保持原子性', async () => {
  await withDatabase('tongjian-cms-conflict-stale-', (database, service) => {
    const fixture = createConflictedAppeal(database, service, 'conflict-stale', 7);
    const before = service.store.getVideo(fixture.videoId);
    const appealBefore = service.store.getAppeal(fixture.appealId);
    const actionCount = database.raw.prepare('SELECT count(*) AS count FROM moderation_actions').get().count;
    const auditCount = database.raw.prepare('SELECT count(*) AS count FROM audit_events').get().count;
    const notificationCount = database.raw.prepare('SELECT count(*) AS count FROM notifications').get().count;

    assert.throws(() => service.resolveAppealConflict({
      appealId: fixture.appealId,
      expectedVersion: fixture.appealVersion,
      expectedTargetVersion: before.moderation_version,
      targetStatus: 'hidden',
      publicExplanation: '客户端不能提交原快照和当前状态之外的第三种状态。',
      internalNote: '这是篡改状态字段的安全回归测试。'
    }, context(fixture.reviewer.id, 'conflict-tamper', '2026-08-25T07:00:00.000Z')),
    appError('VALIDATION_ERROR', 400));
    assert.deepEqual(service.store.getAppeal(fixture.appealId), appealBefore);
    assert.deepEqual(
      [service.store.getVideo(fixture.videoId).moderation_status,
        service.store.getVideo(fixture.videoId).moderation_version],
      [before.moderation_status, before.moderation_version]
    );

    moderateVideo(
      service,
      fixture.originalActor.id,
      fixture.videoId,
      fixture.caseId,
      before.moderation_version,
      'restore',
      'conflict-stale-new-action',
      '2026-08-25T07:10:00.000Z'
    );
    const countsAfterNewAction = {
      actions: database.raw.prepare('SELECT count(*) AS count FROM moderation_actions').get().count,
      audits: database.raw.prepare('SELECT count(*) AS count FROM audit_events').get().count,
      notifications: database.raw.prepare('SELECT count(*) AS count FROM notifications').get().count
    };
    assert.equal(countsAfterNewAction.actions, actionCount + 1);
    assert.equal(countsAfterNewAction.audits, auditCount + 1);
    assert.equal(countsAfterNewAction.notifications, notificationCount + 1);

    assert.throws(() => service.resolveAppealConflict({
      appealId: fixture.appealId,
      expectedVersion: fixture.appealVersion,
      expectedTargetVersion: before.moderation_version,
      targetStatus: 'visible',
      publicExplanation: '旧目标版本不能覆盖刚刚发生的新治理动作。',
      internalNote: '目标 CAS 冲突必须使整个人工处理命令无副作用。'
    }, context(fixture.reviewer.id, 'conflict-stale-target', '2026-08-25T07:20:00.000Z')),
    appError('APPEAL_TARGET_CONFLICT', 409));

    const storedAppeal = service.store.getAppeal(fixture.appealId);
    assert.equal(storedAppeal.status, 'in_review');
    assert.equal(storedAppeal.hasStateConflict, true);
    assert.equal(storedAppeal.version, fixture.appealVersion);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM moderation_actions').get().count, countsAfterNewAction.actions);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM audit_events').get().count, countsAfterNewAction.audits);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM notifications').get().count, countsAfterNewAction.notifications);
  });
});

test('CMS 列表、计数、仪表盘和近期动作均排除双重身份查看者自己的案件数据', async () => {
  await withDatabase('tongjian-cms-dual-role-list-', (database, service) => {
    const viewer = seedUser(database, 'dual-role-viewer', 'moderator');
    const otherOwner = seedUser(database, 'dual-role-other-owner');
    const reporter = seedUser(database, 'dual-role-reporter');
    const originalActor = seedUser(database, 'dual-role-original', 'moderator');
    seedUser(database, 'dual-role-admin', 'administrator');
    seedVideo(database, 'dual-role-own-video', viewer.id);
    seedVideo(database, 'dual-role-other-video', otherOwner.id);

    const reportedOwnCase = service.createReport({
      videoId: 'dual-role-own-video',
      reasonCategory: 'privacy_copyright',
      description: '举报人说明：这条只应由无利益冲突的工作人员查看和处理。'
    }, context(reporter.id, 'dual-role-report-own', '2026-08-25T00:20:00.000Z'));
    const claimedReportedOwnCase = service.claimCase({
      caseId: reportedOwnCase.id,
      expectedVersion: reportedOwnCase.version,
      internalReason: '认领被举报的双重身份工作人员内容'
    }, context(originalActor.id, 'dual-role-report-claim', '2026-08-25T00:30:00.000Z'));
    service.addCaseNote({
      caseId: reportedOwnCase.id,
      expectedVersion: claimedReportedOwnCase.version,
      body: 'SELF_RELATED_INTERNAL_SENTINEL：不能泄露给目标作者。'
    }, context(originalActor.id, 'dual-role-report-note', '2026-08-25T00:40:00.000Z'));

    const ownCase = createClaimedVideoCase(
      service,
      originalActor.id,
      'dual-role-own-video',
      'dual-role-own',
      1
    );
    const otherCase = createClaimedVideoCase(
      service,
      originalActor.id,
      'dual-role-other-video',
      'dual-role-other',
      2
    );
    const ownAction = moderateVideo(
      service,
      originalActor.id,
      'dual-role-own-video',
      ownCase.id,
      0,
      'hide',
      'dual-role-own-hide',
      '2026-08-25T03:00:00.000Z'
    );
    const otherAction = moderateVideo(
      service,
      originalActor.id,
      'dual-role-other-video',
      otherCase.id,
      0,
      'hide',
      'dual-role-other-hide',
      '2026-08-25T03:10:00.000Z'
    );
    const ownAppeal = service.submitAppeal({
      moderationActionId: ownAction.id,
      reason: APPEAL_REASON
    }, context(viewer.id, 'dual-role-own-appeal', '2026-08-25T04:00:00.000Z'));
    const otherAppeal = service.submitAppeal({
      moderationActionId: otherAction.id,
      reason: APPEAL_REASON
    }, context(otherOwner.id, 'dual-role-other-appeal', '2026-08-25T04:10:00.000Z'));

    const cases = service.store.listCases({
      status: 'pending',
      excludeTargetAuthorUserId: viewer.id,
      limit: 25
    });
    assert.deepEqual(cases.items.map((item) => item.id), [otherCase.id]);
    assert.equal(cases.total, 1);

    const appeals = service.store.listAppeals({
      status: 'unresolved',
      excludeAppellantUserId: viewer.id,
      limit: 25
    });
    assert.deepEqual(appeals.items.map((item) => item.id), [otherAppeal.id]);
    assert.equal(appeals.total, 1);
    assert.ok(!appeals.items.some((item) => item.id === ownAppeal.id));

    const recentActions = service.store.listRecentActions(20, {
      excludeAffectedUserId: viewer.id
    });
    assert.deepEqual(recentActions.map((item) => item.id), [otherAction.id]);
    assert.ok(recentActions.every((item) => item.affectedUserId !== viewer.id));

    const dashboard = service.store.dashboard({
      viewerUserId: viewer.id,
      includeAdministrative: false
    });
    assert.equal(dashboard.openCaseCount, 1);
    assert.deepEqual(dashboard.pendingCases.map((item) => item.id), [otherCase.id]);
    assert.equal(dashboard.pendingAppealCount, 1);
    assert.deepEqual(dashboard.recentActions.map((item) => item.id), [otherAction.id]);
    assert.ok(!dashboard.cases.some((item) => item.id === ownCase.id));
    assert.ok(!dashboard.actions.some((item) => item.affectedUserId === viewer.id));

    const audit = service.store.listAudit({
      excludeRelatedUserId: viewer.id,
      limit: 100
    });
    assert.equal(audit.total, audit.items.length);
    assert.ok(audit.total > 0, '无关审计仍应对管理员可见');
    assert.ok(audit.items.some((event) => (
      event.objectType === 'video' && event.objectId === 'dual-role-other-video'
    )), '其他账号内容的治理审计应保留');
    assert.ok(!audit.items.some((event) => event.actorUserId === reporter.id));
    assert.ok(!JSON.stringify(audit.items).includes('SELF_RELATED_INTERNAL_SENTINEL'));

    const reporterFilteredAudit = service.store.listAudit({
      excludeRelatedUserId: viewer.id,
      actorUserId: reporter.id,
      limit: 100
    });
    assert.deepEqual(reporterFilteredAudit.items, []);
    assert.equal(reporterFilteredAudit.total, 0);
  });
});

test('治理目标删除后保留内部作者关联，同时公开映射与 CMS 查询仍执行匿名和回避', async () => {
  await withDatabase('tongjian-cms-deleted-target-link-', (database, service) => {
    const owner = seedUser(database, 'deleted-target-owner', 'moderator');
    const reviewer = seedUser(database, 'deleted-target-reviewer', 'moderator');
    const admin = seedUser(database, 'deleted-target-admin', 'administrator');
    seedVideo(database, 'deleted-governed-video', owner.id);
    seedVideo(database, 'deleted-discussion-video', admin.id);
    const discussion = seedDiscussion(
      database,
      'deleted-discussion-video',
      owner.id,
      'deleted-governed-discussion'
    );

    const videoCase = createClaimedVideoCase(
      service,
      reviewer.id,
      'deleted-governed-video',
      'deleted-video-case',
      1
    );
    service.resolveCase({
      caseId: videoCase.id,
      expectedVersion: videoCase.version,
      resolution: 'no_violation',
      publicExplanation: '复核后未发现违反平台规则的事实，案件正常结案。',
      internalReason: '结案后仍保留案件关系，用于验证删除后的回避过滤。'
    }, context(reviewer.id, 'deleted-video-resolve', '2026-08-25T02:00:00.000Z'));

    const discussionCase = service.createInvestigation({
      discussionId: discussion.id,
      reasonCategory: 'other',
      description: DESCRIPTION
    }, context(reviewer.id, 'deleted-discussion-case', '2026-08-25T03:00:00.000Z'));
    const claimedDiscussionCase = service.claimCase({
      caseId: discussionCase.id,
      expectedVersion: discussionCase.version,
      internalReason: '认领讨论案件以验证删除后的作者关联'
    }, context(reviewer.id, 'deleted-discussion-claim', '2026-08-25T03:10:00.000Z'));
    service.resolveCase({
      caseId: discussionCase.id,
      expectedVersion: claimedDiscussionCase.version,
      resolution: 'no_violation',
      publicExplanation: '讨论复核后未发现违反平台规则的事实，案件正常结案。',
      internalReason: '讨论墓碑仍需保留内部作者关系以执行利益冲突过滤。'
    }, context(reviewer.id, 'deleted-discussion-resolve', '2026-08-25T04:00:00.000Z'));

    assert.ok(database.withdrawVideo(
      'deleted-governed-video',
      owner.id,
      '2026-09-25T00:00:00.000Z'
    ));
    assert.ok(database.markVideoPermanentlyDeleted(
      'deleted-governed-video',
      owner.id,
      '2026-09-25T00:01:00.000Z',
      '2026-08-26T00:00:00.000Z'
    ));
    assert.deepEqual(database.deleteDiscussion(
      discussion.id,
      owner.id,
      '2026-09-25T00:02:00.000Z',
      '2026-08-26T00:00:00.000Z'
    ), { id: discussion.id, mode: 'tombstoned' });

    assert.equal(
      database.raw.prepare('SELECT user_id FROM videos WHERE id = ?').get('deleted-governed-video').user_id,
      owner.id,
      '治理过滤所需的作者关联应只保留在内部原始行'
    );
    assert.equal(
      database.raw.prepare('SELECT user_id FROM discussions WHERE id = ?').get(discussion.id).user_id,
      owner.id,
      '治理讨论墓碑应在内部保留作者关联'
    );

    const publicVideo = database.getVideo('deleted-governed-video');
    assert.equal(publicVideo.deletedAt, '2026-09-25T00:01:00.000Z');
    assert.equal(publicVideo.userId, null);
    assert.equal(publicVideo.accountUsername, null);
    assert.equal(publicVideo.accountDisplayName, null);
    const publicDiscussion = database.getDiscussion(discussion.id);
    assert.equal(publicDiscussion.deletedAt, '2026-09-25T00:02:00.000Z');
    assert.equal(publicDiscussion.userId, null);
    assert.equal(publicDiscussion.accountUsername, null);
    assert.equal(publicDiscussion.accountDisplayName, null);
    assert.equal(publicDiscussion.nickname, '已删除用户');
    assert.equal(publicDiscussion.bodyMarkdown, '');

    const cases = service.store.listCases({
      excludeTargetAuthorUserId: owner.id,
      limit: 100
    });
    assert.deepEqual(cases.items, []);
    assert.equal(cases.total, 0);
    const audit = service.store.listAudit({
      excludeRelatedUserId: owner.id,
      limit: 100
    });
    assert.deepEqual(audit.items, []);
    assert.equal(audit.total, 0);
  });
});

test('举报同一目标后不能借主动调查旁路处理，列表、申诉、仪表盘和审计均按目标隔离', async () => {
  await withDatabase('tongjian-cms-target-wide-reporter-', async (database, service) => {
    const owner = seedUser(database, 'target-wide-owner');
    const otherOwner = seedUser(database, 'target-wide-other-owner');
    const reporterAdministrator = seedUser(database, 'target-wide-reporter-admin', 'administrator');
    const investigator = seedUser(database, 'target-wide-investigator', 'moderator');
    const appealReviewer = seedUser(database, 'target-wide-appeal-reviewer', 'moderator');
    seedVideo(database, 'target-wide-video', owner.id);
    seedVideo(database, 'target-wide-unrelated-video', otherOwner.id);

    const reportCase = service.createReport({
      videoId: 'target-wide-video',
      reasonCategory: 'privacy_copyright',
      description: '工作人员举报这个视频后，不得通过另建主动调查重新取得处理权限。'
    }, context(reporterAdministrator.id, 'target-wide-report', '2026-08-25T00:20:00.000Z'));

    assert.throws(() => service.createInvestigation({
      videoId: 'target-wide-video',
      reasonCategory: 'other',
      description: '举报人不能用主动调查案件绕过原举报案件的利益冲突。'
    }, context(reporterAdministrator.id, 'target-wide-self-investigation', '2026-08-25T00:21:00.000Z')),
    appError('SELF_REVIEW_FORBIDDEN', 403));

    const investigation = service.createInvestigation({
      videoId: 'target-wide-video',
      reasonCategory: 'other',
      description: 'TARGET_WIDE_INVESTIGATION_SENTINEL：由无利益冲突的工作人员建立调查。'
    }, context(investigator.id, 'target-wide-independent-investigation', '2026-08-25T00:22:00.000Z'));

    assert.throws(() => service.claimCase({
      caseId: investigation.id,
      expectedVersion: investigation.version,
      internalReason: '原举报人不得认领同一目标的主动调查'
    }, context(reporterAdministrator.id, 'target-wide-claim-investigation')),
    appError('SELF_REVIEW_FORBIDDEN', 403));

    const claimedInvestigation = service.claimCase({
      caseId: investigation.id,
      expectedVersion: investigation.version,
      internalReason: '由独立调查员认领主动调查'
    }, context(investigator.id, 'target-wide-independent-claim', '2026-08-25T01:05:00.000Z'));

    assert.throws(() => service.transferCase({
      caseId: investigation.id,
      expectedVersion: claimedInvestigation.version,
      assigneeUserId: appealReviewer.id,
      internalReason: '举报人即使是管理员也不能控制同目标调查的转交'
    }, context(reporterAdministrator.id, 'target-wide-reporter-transfer')),
    appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.transferCase({
      caseId: investigation.id,
      expectedVersion: claimedInvestigation.version,
      assigneeUserId: reporterAdministrator.id,
      internalReason: '当前负责人也不能把同目标调查转给原举报人'
    }, context(investigator.id, 'target-wide-transfer-to-reporter')),
    appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.addCaseNote({
      caseId: investigation.id,
      expectedVersion: claimedInvestigation.version,
      body: '原举报人不得写入同目标主动调查的内部备注'
    }, context(reporterAdministrator.id, 'target-wide-reporter-note')),
    appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.resolveCase({
      caseId: investigation.id,
      expectedVersion: claimedInvestigation.version,
      resolution: 'no_violation',
      publicExplanation: '原举报人不得决定同一目标的调查结果。',
      internalReason: '利益冲突命令必须在任何写入前被拒绝。'
    }, context(reporterAdministrator.id, 'target-wide-reporter-resolve')),
    appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => moderateVideo(
      service,
      reporterAdministrator.id,
      'target-wide-video',
      investigation.id,
      0,
      'hide',
      'target-wide-reporter-moderate',
      '2026-08-25T01:10:00.000Z'
    ), appError('SELF_REVIEW_FORBIDDEN', 403));

    const action = service.moderateVideo({
      videoId: 'target-wide-video',
      caseId: investigation.id,
      expectedVersion: 0,
      command: 'hide',
      publicReason: '独立调查后暂时隐藏该视频。',
      internalNote: 'TARGET_WIDE_ACTION_SENTINEL：不得泄露给同目标原举报人。'
    }, context(investigator.id, 'target-wide-independent-action', '2026-08-25T02:00:00.000Z'));
    const appeal = service.submitAppeal({
      moderationActionId: action.id,
      reason: APPEAL_REASON
    }, context(owner.id, 'target-wide-appeal-submit', '2026-08-25T03:00:00.000Z'));

    assert.throws(() => service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: '同目标原举报人不能认领调查动作形成的申诉'
    }, context(reporterAdministrator.id, 'target-wide-reporter-appeal-claim')),
    appError('SELF_APPEAL_REVIEW_FORBIDDEN', 403));
    const claimedAppeal = service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: 'TARGET_WIDE_APPEAL_SENTINEL：由独立复核人认领申诉。'
    }, context(appealReviewer.id, 'target-wide-independent-appeal-claim', '2026-08-25T04:00:00.000Z'));
    assert.throws(() => service.transferAppeal({
      appealId: appeal.id,
      expectedVersion: claimedAppeal.version,
      reviewerUserId: investigator.id,
      internalReason: '同目标原举报人不能利用管理员权限转交申诉'
    }, context(reporterAdministrator.id, 'target-wide-reporter-appeal-transfer')),
    appError('SELF_APPEAL_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.reviewAppeal({
      appealId: appeal.id,
      expectedVersion: claimedAppeal.version,
      result: 'upheld',
      publicExplanation: '原举报人不得处理同一目标产生的申诉。',
      internalNote: '即使提交完整参数，也不得产生复核结果。'
    }, context(reporterAdministrator.id, 'target-wide-reporter-appeal-review')),
    appError('APPEAL_ALREADY_CLAIMED', 409));

    const unrelatedCase = createClaimedVideoCase(
      service,
      investigator.id,
      'target-wide-unrelated-video',
      'target-wide-unrelated',
      5
    );
    const unrelatedAction = service.moderateVideo({
      videoId: 'target-wide-unrelated-video',
      caseId: unrelatedCase.id,
      expectedVersion: 0,
      command: 'hide',
      publicReason: '无关视频的独立治理决定仍应正常显示。',
      internalNote: 'TARGET_WIDE_UNRELATED_SENTINEL：无关审计必须保留。'
    }, context(investigator.id, 'target-wide-unrelated-action', '2026-08-25T06:00:00.000Z'));

    const cases = service.store.listCases({
      excludeReporterUserId: reporterAdministrator.id,
      limit: 100
    });
    assert.deepEqual(cases.items.map((item) => item.id), [unrelatedCase.id]);
    assert.equal(cases.total, 1);
    assert.ok(!cases.items.some((item) => item.id === reportCase.id || item.id === investigation.id));

    const appeals = service.store.listAppeals({
      status: 'unresolved',
      excludeActionCaseReporterUserId: reporterAdministrator.id,
      limit: 100
    });
    assert.deepEqual(appeals.items, []);
    assert.equal(appeals.total, 0);

    const recentActions = service.store.listRecentActions(100, {
      excludeCaseReporterUserId: reporterAdministrator.id
    });
    assert.deepEqual(recentActions.map((item) => item.id), [unrelatedAction.id]);

    const dashboard = service.store.dashboard({
      viewerUserId: reporterAdministrator.id,
      includeAdministrative: true
    });
    assert.equal(dashboard.openCaseCount, 1);
    assert.deepEqual(dashboard.pendingCases.map((item) => item.id), [unrelatedCase.id]);
    assert.equal(dashboard.pendingAppealCount, 0);
    assert.deepEqual(dashboard.recentActions.map((item) => item.id), [unrelatedAction.id]);

    const audit = service.store.listAudit({
      excludeRelatedUserId: reporterAdministrator.id,
      limit: 100
    });
    assert.equal(audit.total, audit.items.length);
    const serializedAudit = JSON.stringify(audit.items);
    assert.ok(serializedAudit.includes('TARGET_WIDE_UNRELATED_SENTINEL'));
    assert.ok(!serializedAudit.includes('TARGET_WIDE_INVESTIGATION_SENTINEL'));
    assert.ok(!serializedAudit.includes('TARGET_WIDE_ACTION_SENTINEL'));
    assert.ok(!serializedAudit.includes('TARGET_WIDE_APPEAL_SENTINEL'));
    assert.ok(!audit.items.some((event) => (
      event.objectType === 'appeal' && event.objectId === String(appeal.id)
    )));

    await assert.rejects(invokeCmsRoute(
      cmsRouter(database, service),
      '/cases/:id',
      'get',
      {
        originalUrl: `/cms/cases/${investigation.id}`,
        params: { id: String(investigation.id) },
        currentUser: reporterAdministrator,
        authSession: { tokenHash: 'd'.repeat(64) }
      }
    ), appError('CASE_NOT_FOUND', 404));
  });
});

test('举报人管理员不能从讨论上下文或账号治理旁路读取和操作被举报作者', async () => {
  await withDatabase('tongjian-cms-reporter-account-', async (database, service) => {
    const owner = seedUser(database, 'reporter-account-owner');
    const siblingAuthor = seedUser(database, 'reporter-account-sibling-author');
    const unrelatedUser = seedUser(database, 'reporter-account-unrelated');
    const reporterAdministrator = seedUser(database, 'reporter-account-admin', 'administrator');
    const independentAdministrator = seedUser(database, 'reporter-account-clean-admin', 'administrator');
    const accountReviewer = seedUser(database, 'reporter-account-reviewer', 'administrator');
    const nextAccountReviewer = seedUser(database, 'reporter-account-next', 'administrator');
    seedVideo(database, 'reporter-account-video', owner.id);
    const reportedDiscussion = seedDiscussion(
      database,
      'reporter-account-video',
      owner.id,
      'reporter-account-reported'
    );
    const siblingDiscussion = seedDiscussion(
      database,
      'reporter-account-video',
      siblingAuthor.id,
      'reporter-account-sibling'
    );
    database.raw.prepare(`
      UPDATE discussions
      SET nickname = 'DISCUSSION_IDENTITY_SENTINEL',
        title = 'DISCUSSION_TITLE_SENTINEL',
        body_markdown = 'DISCUSSION_SIBLING_SECRET_SENTINEL'
      WHERE id = ?
    `).run(reportedDiscussion.id);

    service.createReport({
      discussionId: reportedDiscussion.id,
      reasonCategory: 'harassment_hate',
      description: '管理员举报这条讨论后，必须回避其作者账号以及同视频中的该讨论正文。'
    }, context(reporterAdministrator.id, 'reporter-account-report', '2026-08-25T00:20:00.000Z'));

    assert.equal(service.store.hasUserReporterConflict(reporterAdministrator.id, owner.id), true);
    assert.deepEqual(
      service.store.listDiscussionConflictIds('reporter-account-video', reporterAdministrator.id),
      [reportedDiscussion.id]
    );

    const router = cmsRouter(database, service);
    await assert.rejects(invokeCmsRoute(router, '/discussions/:id', 'get', {
      originalUrl: `/cms/discussions/${reportedDiscussion.id}`,
      params: { id: String(reportedDiscussion.id) },
      currentUser: reporterAdministrator
    }), appError('DISCUSSION_NOT_FOUND', 404));

    const siblingPage = await invokeCmsRoute(router, '/discussions/:id', 'get', {
      originalUrl: `/cms/discussions/${siblingDiscussion.id}`,
      params: { id: String(siblingDiscussion.id) },
      currentUser: reporterAdministrator
    });
    assert.equal(siblingPage.rendered?.view, 'cms/discussion-detail');
    const contextRows = siblingPage.rendered.locals.contextDiscussions;
    const redacted = contextRows.find((row) => row.id === reportedDiscussion.id);
    assert.ok(redacted?.governanceConflictRedacted);
    assert.equal(redacted.bodyMarkdown, '该讨论因工作人员利益冲突不可查看。');
    assert.equal(redacted.userId, null);
    assert.equal(redacted.accountUsername, null);
    const serializedContext = JSON.stringify(contextRows);
    assert.ok(!serializedContext.includes('DISCUSSION_SIBLING_SECRET_SENTINEL'));
    assert.ok(!serializedContext.includes('DISCUSSION_IDENTITY_SENTINEL'));
    assert.ok(!serializedContext.includes('DISCUSSION_TITLE_SENTINEL'));

    const visibleUsers = service.store.listUsers({
      excludeReporterConflictUserId: reporterAdministrator.id,
      limit: 100
    });
    assert.equal(visibleUsers.total, visibleUsers.items.length);
    assert.ok(!visibleUsers.items.some((user) => user.id === owner.id));
    assert.ok(visibleUsers.items.some((user) => user.id === unrelatedUser.id));

    await assert.rejects(invokeCmsRoute(router, '/users/:id', 'get', {
      originalUrl: `/cms/users/${owner.id}`,
      params: { id: owner.id },
      currentUser: reporterAdministrator
    }), appError('USER_NOT_FOUND', 404));

    const ownerSessionHash = 'e'.repeat(64);
    database.createSession({
      tokenHash: ownerSessionHash,
      userId: owner.id,
      csrfTokenHash: 'f'.repeat(64),
      createdAt: '2026-08-25T00:30:00.000Z',
      expiresAt: '2026-09-25T00:30:00.000Z'
    });
    const beforeUser = service.store.getUser(owner.id);
    const actionCountBefore = database.raw
      .prepare('SELECT count(*) AS count FROM moderation_actions').get().count;
    const auditCountBefore = database.raw
      .prepare('SELECT count(*) AS count FROM audit_events').get().count;

    assert.throws(() => service.changeUserStatus({
      userId: owner.id,
      command: 'suspend',
      expectedVersion: beforeUser.governance_version,
      publicReason: '有利益冲突的管理员不得暂停该作者。',
      internalNote: 'REPORTER_ACCOUNT_FORBIDDEN_STATUS_SENTINEL'
    }, context(reporterAdministrator.id, 'reporter-account-forbidden-status')),
    appError('REPORTER_GOVERNANCE_CONFLICT', 403));
    assert.throws(() => service.setUserRole({
      userId: owner.id,
      role: 'moderator',
      expectedVersion: beforeUser.governance_version,
      publicReason: '有利益冲突的管理员不得修改该作者角色。',
      internalNote: 'REPORTER_ACCOUNT_FORBIDDEN_ROLE_SENTINEL'
    }, context(reporterAdministrator.id, 'reporter-account-forbidden-role')),
    appError('REPORTER_GOVERNANCE_CONFLICT', 403));
    assert.throws(() => service.revokeUserSessions({
      userId: owner.id,
      expectedVersion: beforeUser.governance_version,
      internalReason: 'REPORTER_ACCOUNT_FORBIDDEN_SESSION_SENTINEL'
    }, context(reporterAdministrator.id, 'reporter-account-forbidden-session')),
    appError('REPORTER_GOVERNANCE_CONFLICT', 403));

    const afterForbidden = service.store.getUser(owner.id);
    assert.deepEqual(
      [afterForbidden.status, afterForbidden.role, afterForbidden.governance_version],
      [beforeUser.status, beforeUser.role, beforeUser.governance_version]
    );
    assert.ok(database.findSessionByTokenHash(ownerSessionHash, '2026-08-25T01:30:00.000Z'));
    assert.equal(
      database.raw.prepare('SELECT count(*) AS count FROM moderation_actions').get().count,
      actionCountBefore
    );
    assert.equal(
      database.raw.prepare('SELECT count(*) AS count FROM audit_events').get().count,
      auditCountBefore
    );

    const ownerAction = service.changeUserStatus({
      userId: owner.id,
      command: 'suspend',
      expectedVersion: beforeUser.governance_version,
      publicReason: '由无利益冲突管理员暂停账号。',
      internalNote: 'REPORTER_ACCOUNT_PRIVATE_SENTINEL：不得向原举报人展示。'
    }, context(independentAdministrator.id, 'reporter-account-independent-status', '2026-08-25T02:00:00.000Z'));
    const ownerAppeal = service.submitAppeal({
      moderationActionId: ownerAction.id,
      reason: APPEAL_REASON
    }, context(owner.id, 'reporter-account-owner-appeal', '2026-08-25T03:00:00.000Z'));
    const claimedOwnerAppeal = service.claimAppeal({
      appealId: ownerAppeal.id,
      expectedVersion: ownerAppeal.version,
      internalReason: '由未参与原决定的管理员认领账号申诉'
    }, context(accountReviewer.id, 'reporter-account-owner-appeal-claim', '2026-08-25T03:05:00.000Z'));
    assert.throws(() => service.transferAppeal({
      appealId: ownerAppeal.id,
      expectedVersion: claimedOwnerAppeal.version,
      reviewerUserId: nextAccountReviewer.id,
      internalReason: '举报过目标作者内容的管理员不得旁路转交其账号申诉'
    }, context(reporterAdministrator.id, 'reporter-account-forbidden-appeal-transfer')),
    appError('SELF_APPEAL_REVIEW_FORBIDDEN', 403));
    assert.equal(service.store.getAppeal(ownerAppeal.id).reviewerUserId, accountReviewer.id);

    const unrelatedAction = service.changeUserStatus({
      userId: unrelatedUser.id,
      command: 'suspend',
      expectedVersion: 0,
      publicReason: '无关账号治理动作。',
      internalNote: 'REPORTER_ACCOUNT_UNRELATED_SENTINEL：无关审计仍应可见。'
    }, context(independentAdministrator.id, 'reporter-account-unrelated-status', '2026-08-25T03:10:00.000Z'));
    const unrelatedAppeal = service.submitAppeal({
      moderationActionId: unrelatedAction.id,
      reason: APPEAL_REASON
    }, context(unrelatedUser.id, 'reporter-account-unrelated-appeal', '2026-08-25T03:20:00.000Z'));

    const appeals = service.store.listAppeals({
      status: 'unresolved',
      includeAccountActions: true,
      excludeAppellantUserId: reporterAdministrator.id,
      excludeActionCaseReporterUserId: reporterAdministrator.id,
      excludeAffectedReporterUserId: reporterAdministrator.id,
      limit: 100
    });
    assert.deepEqual(appeals.items.map((item) => item.id), [unrelatedAppeal.id]);
    assert.equal(appeals.total, 1);
    assert.ok(!appeals.items.some((item) => item.id === ownerAppeal.id));

    const recentActions = service.store.listRecentActions(100, {
      excludeAffectedReporterUserId: reporterAdministrator.id
    });
    assert.deepEqual(recentActions.map((item) => item.id), [unrelatedAction.id]);

    const dashboard = service.store.dashboard({
      viewerUserId: reporterAdministrator.id,
      includeAdministrative: true
    });
    assert.equal(dashboard.pendingAppealCount, 1);
    assert.deepEqual(dashboard.recentActions.map((item) => item.id), [unrelatedAction.id]);
    assert.ok(!dashboard.pendingAppeals?.some?.((item) => item.id === ownerAppeal.id));

    await assert.rejects(invokeCmsRoute(router, '/appeals/:id', 'get', {
      originalUrl: `/cms/appeals/${ownerAppeal.id}`,
      params: { id: String(ownerAppeal.id) },
      currentUser: reporterAdministrator
    }), appError('APPEAL_NOT_FOUND', 404));

    const audit = service.store.listAudit({
      excludeRelatedUserId: reporterAdministrator.id,
      limit: 100
    });
    assert.equal(audit.total, audit.items.length);
    const serializedAudit = JSON.stringify(audit.items);
    assert.ok(serializedAudit.includes('REPORTER_ACCOUNT_UNRELATED_SENTINEL'));
    assert.ok(!serializedAudit.includes('REPORTER_ACCOUNT_PRIVATE_SENTINEL'));
    assert.ok(!serializedAudit.includes('REPORTER_ACCOUNT_FORBIDDEN_STATUS_SENTINEL'));
    assert.ok(!serializedAudit.includes('REPORTER_ACCOUNT_FORBIDDEN_ROLE_SENTINEL'));
    assert.ok(!serializedAudit.includes('REPORTER_ACCOUNT_FORBIDDEN_SESSION_SENTINEL'));
    assert.ok(!audit.items.some((event) => (
      event.objectType === 'user' && event.objectId === owner.id
    )));
    assert.ok(!audit.items.some((event) => (
      event.objectType === 'appeal' && event.objectId === String(ownerAppeal.id)
    )));
  });
});

test('承载视频作者不能调查、处理或读取自己视频下的讨论治理案件', async () => {
  await withDatabase('tongjian-cms-discussion-host-stake-', async (database, service) => {
    const videoOwner = seedUser(database, 'discussion-host-admin', 'administrator');
    const discussionAuthor = seedUser(database, 'discussion-host-commenter');
    const independentModerator = seedUser(database, 'discussion-host-reviewer', 'moderator');
    seedVideo(database, 'discussion-host-video', videoOwner.id);
    const discussion = seedDiscussion(
      database,
      'discussion-host-video',
      discussionAuthor.id,
      'discussion-host-target'
    );

    assert.equal(service.store.hasTargetStake(videoOwner.id, null, discussion.id), true);
    assert.throws(() => service.createInvestigation({
      discussionId: discussion.id,
      reasonCategory: 'other',
      description: '承载视频作者不得主动调查自己视频下其他成员的讨论。'
    }, context(videoOwner.id, 'discussion-host-create')),
    appError('SELF_REVIEW_FORBIDDEN', 403));

    const moderationCase = service.createInvestigation({
      discussionId: discussion.id,
      reasonCategory: 'other',
      description: 'DISCUSSION_HOST_PRIVATE_SENTINEL：交由独立工作人员调查。'
    }, context(independentModerator.id, 'discussion-host-independent-create'));
    const claimed = service.claimCase({
      caseId: moderationCase.id,
      expectedVersion: moderationCase.version,
      internalReason: '独立工作人员认领讨论案件'
    }, context(independentModerator.id, 'discussion-host-independent-claim'));

    assert.throws(() => service.transferCase({
      caseId: moderationCase.id,
      expectedVersion: claimed.version,
      assigneeUserId: videoOwner.id,
      internalReason: '不得把案件转给承载视频作者'
    }, context(independentModerator.id, 'discussion-host-transfer')),
    appError('SELF_REVIEW_FORBIDDEN', 403));
    assert.throws(() => service.moderateDiscussion({
      discussionId: discussion.id,
      caseId: moderationCase.id,
      expectedVersion: 0,
      command: 'remove',
      publicReason: '承载视频作者不得裁决自己页面下的讨论。',
      internalNote: '利益冲突写命令必须被拒绝。'
    }, context(videoOwner.id, 'discussion-host-remove')),
    appError('SELF_REVIEW_FORBIDDEN', 403));

    const cases = service.store.listCases({
      excludeTargetAuthorUserId: videoOwner.id,
      limit: 100
    });
    assert.deepEqual(cases.items, []);
    assert.equal(cases.total, 0);
    const discussions = service.store.listDiscussions({
      excludeStakeholderUserId: videoOwner.id,
      limit: 100
    });
    assert.deepEqual(discussions.items, []);
    assert.equal(discussions.total, 0);
    const audit = service.store.listAudit({
      excludeRelatedUserId: videoOwner.id,
      limit: 100
    });
    assert.ok(!JSON.stringify(audit.items).includes('DISCUSSION_HOST_PRIVATE_SENTINEL'));

    await assert.rejects(invokeCmsRoute(
      cmsRouter(database, service),
      '/cases/:id',
      'get',
      {
        originalUrl: `/cms/cases/${moderationCase.id}`,
        params: { id: String(moderationCase.id) },
        currentUser: videoOwner,
        authSession: { tokenHash: '1'.repeat(64) }
      }
    ), appError('CASE_NOT_FOUND', 404));
  });
});
