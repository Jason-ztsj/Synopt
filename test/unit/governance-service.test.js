import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../../src/database.js';
import { createGovernanceService } from '../../src/governance.js';

const DESCRIPTION = '这是一段足够详细的治理测试说明，用于触发真实的领域规则。';
const APPEAL_REASON = '我认为这项决定忽略了必要的上下文，申请另一名工作人员复核。';

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

function seedUser(database, id, role = 'member') {
  database.createUser({
    id,
    username: id.replaceAll('-', '_'),
    displayName: `用户 ${id}`,
    passwordHash: `scrypt-test-${id}`,
    createdAt: '2026-08-25T00:00:00.000Z'
  });
  if (role !== 'member') {
    database.raw.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  return database.governance.getUser(id);
}

function seedVideo(database, id, userId, overrides = {}) {
  return database.insertVideo({
    id,
    title: `视频 ${id}`,
    creator: `创作者 ${id}`,
    description: '测试视频',
    licenseCode: 'CC-BY-4.0',
    storageName: `${id}.mp4`,
    originalFilename: `${id}.mp4`,
    mediaType: 'video/mp4',
    byteSize: 128,
    validationStatus: 'ready',
    userId,
    visibility: 'public',
    moderationStatus: 'visible',
    createdAt: '2026-08-25T00:10:00.000Z',
    ...overrides
  });
}

function seedDiscussion(database, videoId, userId, suffix = 'one') {
  return database.insertDiscussion({
    videoId,
    nickname: `讨论者 ${suffix}`,
    title: `讨论 ${suffix}`,
    bodyMarkdown: `这是讨论正文 ${suffix}`,
    userId,
    createdAt: '2026-08-25T00:20:00.000Z'
  });
}

function context(actorUserId, suffix, createdAt = '2026-08-25T01:00:00.000Z') {
  return { actorUserId, requestId: `governance-test-${suffix}`, createdAt };
}

function appError(code, status) {
  return (error) => error?.code === code && error?.status === status;
}

function createInvestigation(service, actorUserId, target, suffix) {
  return service.createInvestigation({
    ...target,
    reasonCategory: 'other',
    description: DESCRIPTION
  }, context(actorUserId, `investigation-${suffix}`));
}

function claimInvestigation(service, actorUserId, moderationCase, suffix) {
  return service.claimCase({
    caseId: moderationCase.id,
    expectedVersion: moderationCase.version,
    internalReason: '认领后执行完整的审核流程'
  }, context(actorUserId, `claim-${suffix}`, '2026-08-25T01:30:00.000Z'));
}

function moderateVideo(service, actorUserId, videoId, caseId, expectedVersion, command, suffix) {
  return service.moderateVideo({
    videoId,
    caseId,
    expectedVersion,
    command,
    publicReason: `视频${command}的公开说明`,
    internalNote: `视频${command}的内部说明`
  }, context(actorUserId, suffix, `2026-08-25T0${2 + expectedVersion}:00:00.000Z`));
}

function moderateDiscussion(service, actorUserId, discussionId, caseId, expectedVersion, command, suffix) {
  return service.moderateDiscussion({
    discussionId,
    caseId,
    expectedVersion,
    command,
    publicReason: `讨论${command}的公开说明`,
    internalNote: `讨论${command}的内部说明`
  }, context(actorUserId, suffix, `2026-08-25T0${5 + expectedVersion}:00:00.000Z`));
}

test('举报拒绝本人和不可见内容，并将重复未结案举报映射为领域冲突', async () => {
  await withDatabase('tongjian-governance-report-', (database, service) => {
    const owner = seedUser(database, 'report-owner');
    const reporter = seedUser(database, 'report-member');
    seedVideo(database, 'own-video', reporter.id);
    seedVideo(database, 'private-video', owner.id, { visibility: 'private' });
    seedVideo(database, 'reportable-video', owner.id);

    const ownDiscussion = seedDiscussion(database, 'reportable-video', reporter.id, 'own');
    const hiddenDiscussion = seedDiscussion(database, 'reportable-video', owner.id, 'hidden');
    database.raw.prepare("UPDATE discussions SET moderation_status = 'hidden' WHERE id = ?")
      .run(hiddenDiscussion.id);

    assert.throws(() => service.createReport({
      reporterUserId: owner.id,
      videoId: 'reportable-video', reasonCategory: 'other', description: DESCRIPTION
    }, context(reporter.id, 'report-impersonation')), appError('REPORTER_IDENTITY_MISMATCH', 403));

    assert.throws(() => service.createReport({
      videoId: 'own-video', reasonCategory: 'other', description: DESCRIPTION
    }, context(reporter.id, 'self-video')), appError('SELF_REPORT_FORBIDDEN', 403));
    assert.throws(() => service.createReport({
      discussionId: ownDiscussion.id, reasonCategory: 'other', description: DESCRIPTION
    }, context(reporter.id, 'self-discussion')), appError('SELF_REPORT_FORBIDDEN', 403));
    assert.throws(() => service.createReport({
      videoId: 'private-video', reasonCategory: 'other', description: DESCRIPTION
    }, context(reporter.id, 'private-video')), appError('REPORT_TARGET_NOT_FOUND', 404));
    assert.throws(() => service.createReport({
      discussionId: hiddenDiscussion.id, reasonCategory: 'other', description: DESCRIPTION
    }, context(reporter.id, 'hidden-discussion')), appError('REPORT_TARGET_NOT_FOUND', 404));

    const report = service.createReport({
      videoId: 'reportable-video', reasonCategory: 'spam_fraud', description: DESCRIPTION
    }, context(reporter.id, 'first-report'));
    assert.equal(report.source, 'report');
    assert.equal(report.status, 'open');
    assert.equal(report.reporterUserId, reporter.id);

    assert.throws(() => service.createReport({
      videoId: 'reportable-video', reasonCategory: 'spam_fraud', description: DESCRIPTION
    }, context(reporter.id, 'duplicate-report')), appError('OPEN_REPORT_EXISTS', 409));

    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM moderation_cases').get().count, 1);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'report.created'").get().count, 1);
    database.raw.prepare("UPDATE videos SET moderation_status = 'removed' WHERE id = 'reportable-video'").run();
    assert.equal(service.store.listUserReports(reporter.id).items[0].videoTitle, '已按规则移除的视频');
  });
});

test('讨论举报在父视频失去公开可见性后不泄露原讨论标题', async () => {
  await withDatabase('tongjian-governance-report-privacy-', (database, service) => {
    const owner = seedUser(database, 'report-privacy-owner');
    const reporter = seedUser(database, 'report-privacy-member');
    seedVideo(database, 'report-privacy-video', owner.id);
    const discussion = seedDiscussion(database, 'report-privacy-video', owner.id, 'private-parent');
    service.createReport({
      discussionId: discussion.id,
      reasonCategory: 'privacy_copyright',
      description: DESCRIPTION
    }, context(reporter.id, 'report-private-parent'));

    database.raw.prepare("UPDATE videos SET visibility = 'private' WHERE id = ?")
      .run('report-privacy-video');
    const report = service.store.listUserReports(reporter.id).items[0];
    assert.equal(report.discussionTitle, '当前不可公开的讨论');
    assert.notEqual(report.discussionTitle, discussion.title);
  });
});

test('案件认领使用 CAS，过期版本不会增加备注或审计', async () => {
  await withDatabase('tongjian-governance-claim-', (database, service) => {
    const owner = seedUser(database, 'claim-owner');
    const moderatorA = seedUser(database, 'claim-mod-a', 'moderator');
    const moderatorB = seedUser(database, 'claim-mod-b', 'moderator');
    seedVideo(database, 'claim-video', owner.id);
    const moderationCase = createInvestigation(service, moderatorA.id, { videoId: 'claim-video' }, 'claim');

    const claimed = service.claimCase({
      caseId: moderationCase.id,
      expectedVersion: 0,
      internalReason: '负责跟进这个案件'
    }, context(moderatorA.id, 'claim-success', '2026-08-25T02:00:00.000Z'));
    assert.equal(claimed.status, 'in_review');
    assert.equal(claimed.assigneeUserId, moderatorA.id);
    assert.equal(claimed.version, 1);

    assert.throws(() => service.claimCase({
      caseId: moderationCase.id,
      expectedVersion: 0,
      internalReason: '使用过期页面再次认领'
    }, context(moderatorA.id, 'claim-stale')), appError('CASE_VERSION_CONFLICT', 409));
    assert.throws(() => service.claimCase({
      caseId: moderationCase.id,
      expectedVersion: 1,
      internalReason: '尝试抢占已认领案件'
    }, context(moderatorB.id, 'claim-taken')), appError('CASE_ALREADY_CLAIMED', 409));

    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM case_notes WHERE case_id = ?').get(moderationCase.id).count, 1);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'case.claimed'").get().count, 1);
  });
});

test('只有当前负责人能操作案件，未违规结论不能留下被治理状态', async () => {
  await withDatabase('tongjian-governance-assignment-', (database, service) => {
    const owner = seedUser(database, 'assignment-owner');
    const moderatorA = seedUser(database, 'assignment-mod-a', 'moderator');
    const moderatorB = seedUser(database, 'assignment-mod-b', 'moderator');
    seedVideo(database, 'assignment-video', owner.id);
    const moderationCase = createInvestigation(
      service,
      moderatorA.id,
      { videoId: 'assignment-video' },
      'assignment'
    );

    assert.throws(() => moderateVideo(
      service, moderatorA.id, 'assignment-video', moderationCase.id, 0, 'hide', 'before-claim'
    ), appError('CASE_STATE_CONFLICT', 409));

    const claimed = claimInvestigation(service, moderatorA.id, moderationCase, 'assignment');
    assert.throws(() => moderateVideo(
      service, moderatorB.id, 'assignment-video', moderationCase.id, 0, 'hide', 'wrong-worker'
    ), appError('CASE_ASSIGNMENT_FORBIDDEN', 403));
    assert.throws(() => service.transferCase({
      caseId: moderationCase.id,
      expectedVersion: claimed.version,
      assigneeUserId: moderatorB.id,
      internalReason: '非负责人不能擅自转交案件'
    }, context(moderatorB.id, 'unauthorized-transfer')), appError('CASE_ASSIGNMENT_FORBIDDEN', 403));

    moderateVideo(service, moderatorA.id, 'assignment-video', moderationCase.id, 0, 'hide', 'assigned-hide');
    assert.throws(() => service.resolveCase({
      caseId: moderationCase.id,
      expectedVersion: claimed.version,
      resolution: 'no_violation',
      publicExplanation: '复核后没有发现足以认定违规的事实。',
      internalReason: '测试隐藏状态与未违规结论的一致性保护'
    }, context(moderatorA.id, 'invalid-no-violation')), appError('CASE_TARGET_STILL_MODERATED', 409));
    assert.equal(database.governance.getCase(moderationCase.id).status, 'in_review');

    moderateVideo(service, moderatorA.id, 'assignment-video', moderationCase.id, 1, 'restore', 'assigned-restore');
    const resolved = service.resolveCase({
      caseId: moderationCase.id,
      expectedVersion: claimed.version,
      resolution: 'no_violation',
      publicExplanation: '复核后没有发现足以认定违规的事实。',
      internalReason: '目标已恢复，案件状态和治理状态保持一致'
    }, context(moderatorA.id, 'valid-no-violation'));
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolution, 'no_violation');
    assert.equal(database.governance.getVideo('assignment-video').moderation_status, 'visible');
  });
});

test('私密媒体授权绑定会话与当前负责人，案件转交会立即撤销旧授权', async () => {
  await withDatabase('tongjian-governance-media-grant-', (database, service) => {
    const owner = seedUser(database, 'grant-owner');
    const moderatorA = seedUser(database, 'grant-mod-a', 'moderator');
    const moderatorB = seedUser(database, 'grant-mod-b', 'moderator');
    seedVideo(database, 'grant-private-video', owner.id, { visibility: 'private' });
    const tokenA = 'e'.repeat(64);
    const tokenB = 'f'.repeat(64);
    database.createSession({
      tokenHash: tokenA,
      userId: moderatorA.id,
      csrfTokenHash: 'a'.repeat(64),
      createdAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-09-25T00:00:00.000Z'
    });
    database.createSession({
      tokenHash: tokenB,
      userId: moderatorB.id,
      csrfTokenHash: 'b'.repeat(64),
      createdAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-09-25T00:00:00.000Z'
    });
    const moderationCase = createInvestigation(
      service,
      moderatorA.id,
      { videoId: 'grant-private-video' },
      'private-grant'
    );
    const claimed = claimInvestigation(service, moderatorA.id, moderationCase, 'private-grant');
    const grant = service.grantPrivateMedia({
      caseId: moderationCase.id,
      expectedVersion: claimed.version,
      videoId: 'grant-private-video',
      sessionTokenHash: tokenA,
      reason: '核查案件中的必要私密媒体证据'
    }, context(moderatorA.id, 'private-grant-create', '2026-08-25T02:00:00.000Z'));
    assert.equal(grant.caseId, moderationCase.id);
    assert.ok(service.store.getMediaGrant(
      tokenA,
      moderationCase.id,
      'grant-private-video',
      '2026-08-25T02:05:00.000Z'
    ));

    const transferred = service.transferCase({
      caseId: moderationCase.id,
      expectedVersion: claimed.version,
      assigneeUserId: moderatorB.id,
      internalReason: '由另一名工作人员继续处理私密证据'
    }, context(moderatorA.id, 'private-grant-transfer', '2026-08-25T02:06:00.000Z'));
    assert.equal(service.store.getMediaGrant(
      tokenA,
      moderationCase.id,
      'grant-private-video',
      '2026-08-25T02:07:00.000Z'
    ), null);
    assert.equal(database.raw.prepare(
      'SELECT count(*) AS count FROM cms_media_access_grants WHERE case_id = ?'
    ).get(moderationCase.id).count, 0);
    assert.throws(() => service.grantPrivateMedia({
      caseId: moderationCase.id,
      expectedVersion: transferred.version,
      videoId: 'grant-private-video',
      sessionTokenHash: tokenA,
      reason: '不能把其他工作人员的会话用于授权'
    }, context(moderatorB.id, 'private-grant-wrong-session', '2026-08-25T02:08:00.000Z')),
    appError('SESSION_EXPIRED', 401));
    assert.throws(() => service.grantPrivateMedia({
      caseId: moderationCase.id,
      expectedVersion: claimed.version,
      videoId: 'grant-private-video',
      sessionTokenHash: tokenB,
      reason: '陈旧案件页面不能授予私密媒体访问'
    }, context(moderatorB.id, 'private-grant-stale-case', '2026-08-25T02:08:30.000Z')),
    appError('CASE_VERSION_CONFLICT', 409));
    assert.ok(service.grantPrivateMedia({
      caseId: moderationCase.id,
      expectedVersion: transferred.version,
      videoId: 'grant-private-video',
      sessionTokenHash: tokenB,
      reason: '由当前负责人在自己的会话中申请访问'
    }, context(moderatorB.id, 'private-grant-new-owner', '2026-08-25T02:09:00.000Z')));
  });
});

test('案件备注由当前负责人以案件版本 CAS 追加，结案后不可继续写入', async () => {
  await withDatabase('tongjian-governance-case-note-', (database, service) => {
    const owner = seedUser(database, 'note-owner');
    const moderatorA = seedUser(database, 'note-mod-a', 'moderator');
    const moderatorB = seedUser(database, 'note-mod-b', 'moderator');
    seedVideo(database, 'note-video', owner.id);
    const moderationCase = createInvestigation(service, moderatorA.id, { videoId: 'note-video' }, 'note');
    const claimed = claimInvestigation(service, moderatorA.id, moderationCase, 'note');
    const note = service.addCaseNote({
      caseId: moderationCase.id,
      expectedVersion: claimed.version,
      body: '负责人追加的一条只读内部案件备注'
    }, context(moderatorA.id, 'note-success'));
    assert.equal(note.caseVersion, claimed.version + 1);
    assert.throws(() => service.addCaseNote({
      caseId: moderationCase.id,
      expectedVersion: claimed.version,
      body: '来自过期页面的备注不能追加'
    }, context(moderatorA.id, 'note-stale')), appError('CASE_VERSION_CONFLICT', 409));
    assert.throws(() => service.addCaseNote({
      caseId: moderationCase.id,
      expectedVersion: note.caseVersion,
      body: '其他工作人员不能向案件追加内部备注'
    }, context(moderatorB.id, 'note-wrong-worker')), appError('CASE_ASSIGNMENT_FORBIDDEN', 403));
    const resolved = service.resolveCase({
      caseId: moderationCase.id,
      expectedVersion: note.caseVersion,
      resolution: 'no_violation',
      publicExplanation: '复核后没有发现违反平台规则的事实。',
      internalReason: '完成案件备注的状态边界测试'
    }, context(moderatorA.id, 'note-resolve'));
    assert.throws(() => service.addCaseNote({
      caseId: moderationCase.id,
      expectedVersion: resolved.version,
      body: '结案以后不能继续改写案件时间线'
    }, context(moderatorA.id, 'note-after-resolve')), appError('CASE_STATE_CONFLICT', 409));
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM case_notes WHERE case_id = ?')
      .get(moderationCase.id).count, 3, '认领、人工备注和结案各追加一条记录');
  });
});

test('视频和讨论 hide/remove/restore 原子写入状态、动作、审计与强制通知', async () => {
  await withDatabase('tongjian-governance-moderation-', (database, service) => {
    const owner = seedUser(database, 'moderation-owner');
    const moderator = seedUser(database, 'moderation-staff', 'moderator');
    seedVideo(database, 'moderation-video', owner.id);
    const discussion = seedDiscussion(database, 'moderation-video', owner.id, 'moderation');
    database.updateNotificationPreferences(owner.id, {
      reply: false, videoVote: false, system: false
    }, '2026-08-25T00:30:00.000Z');
    const videoCase = createInvestigation(service, moderator.id, { videoId: 'moderation-video' }, 'video');
    const discussionCase = createInvestigation(service, moderator.id, { discussionId: discussion.id }, 'discussion');
    claimInvestigation(service, moderator.id, videoCase, 'video');
    claimInvestigation(service, moderator.id, discussionCase, 'discussion');

    database.raw.exec(`
      CREATE TRIGGER force_mandatory_notification_failure
      BEFORE INSERT ON notifications WHEN NEW.type = 'system'
      BEGIN SELECT RAISE(ABORT, 'forced mandatory notification failure'); END
    `);
    assert.throws(() => moderateVideo(
      service, moderator.id, 'moderation-video', videoCase.id, 0, 'hide', 'video-rollback'
    ), /forced mandatory notification failure/);
    assert.throws(() => moderateDiscussion(
      service, moderator.id, discussion.id, discussionCase.id, 0, 'hide', 'discussion-rollback'
    ), /forced mandatory notification failure/);
    database.raw.exec('DROP TRIGGER force_mandatory_notification_failure');

    const rolledBackVideo = database.governance.getVideo('moderation-video');
    const rolledBackDiscussion = database.governance.getDiscussion(discussion.id);
    assert.equal(rolledBackVideo.moderation_status, 'visible');
    assert.equal(rolledBackVideo.moderation_version, 0);
    assert.equal(rolledBackDiscussion.moderation_status, 'visible');
    assert.equal(rolledBackDiscussion.moderation_version, 0);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM moderation_actions').get().count, 0);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action LIKE 'video.%' OR action LIKE 'discussion.%'").get().count, 0);

    const videoActions = [
      moderateVideo(service, moderator.id, 'moderation-video', videoCase.id, 0, 'hide', 'video-hide'),
      moderateVideo(service, moderator.id, 'moderation-video', videoCase.id, 1, 'remove', 'video-remove'),
      moderateVideo(service, moderator.id, 'moderation-video', videoCase.id, 2, 'restore', 'video-restore')
    ];
    const discussionActions = [
      moderateDiscussion(service, moderator.id, discussion.id, discussionCase.id, 0, 'hide', 'discussion-hide'),
      moderateDiscussion(service, moderator.id, discussion.id, discussionCase.id, 1, 'remove', 'discussion-remove'),
      moderateDiscussion(service, moderator.id, discussion.id, discussionCase.id, 2, 'restore', 'discussion-restore')
    ];

    assert.deepEqual(videoActions.map((entry) => entry.action), ['video_hide', 'video_remove', 'video_restore']);
    assert.deepEqual(discussionActions.map((entry) => entry.action), ['discussion_hide', 'discussion_remove', 'discussion_restore']);
    assert.deepEqual(videoActions.map((entry) => [entry.beforeVersion, entry.afterVersion]), [[0, 1], [1, 2], [2, 3]]);
    assert.deepEqual(discussionActions.map((entry) => [entry.beforeVersion, entry.afterVersion]), [[0, 1], [1, 2], [2, 3]]);
    assert.deepEqual(
      [database.governance.getVideo('moderation-video').moderation_status,
        database.governance.getVideo('moderation-video').moderation_version],
      ['visible', 3]
    );
    assert.deepEqual(
      [database.governance.getDiscussion(discussion.id).moderation_status,
        database.governance.getDiscussion(discussion.id).moderation_version],
      ['visible', 3]
    );
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM moderation_actions').get().count, 6);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action LIKE 'video.%' OR action LIKE 'discussion.%'").get().count, 6);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM notifications WHERE recipient_user_id = ? AND type = 'system'").get(owner.id).count, 6);
  });
});

test('长公开说明完整保存在决定中，通知只保存安全长度的预览', async () => {
  await withDatabase('tongjian-governance-long-public-reason-', (database, service) => {
    const owner = seedUser(database, 'long-reason-owner');
    const moderator = seedUser(database, 'long-reason-moderator', 'moderator');
    seedVideo(database, 'long-reason-video', owner.id);
    const moderationCase = createInvestigation(
      service,
      moderator.id,
      { videoId: 'long-reason-video' },
      'long-reason'
    );
    claimInvestigation(service, moderator.id, moderationCase, 'long-reason');
    const publicReason = '公'.repeat(1500);
    const action = service.moderateVideo({
      videoId: 'long-reason-video',
      caseId: moderationCase.id,
      expectedVersion: 0,
      command: 'hide',
      publicReason,
      internalNote: '验证长公开说明不会让通知约束破坏领域事务。'
    }, context(moderator.id, 'long-reason-hide', '2026-08-25T03:00:00.000Z'));

    assert.equal(action.publicReason, publicReason);
    assert.equal(Array.from(action.publicReason).length, 1500);
    const notification = database.raw.prepare(`
      SELECT system_body FROM notifications
      WHERE recipient_user_id = ? AND type = 'system'
      ORDER BY id DESC LIMIT 1
    `).get(owner.id);
    assert.equal(Array.from(notification.system_body).length, 1000);
    assert.equal(database.governance.getVideo('long-reason-video').moderation_status, 'hidden');
    const decisions = service.store.listUserDecisions(owner.id).items;
    assert.equal(decisions[0].publicReason, publicReason);
    assert.equal(decisions[0].action, 'video_hide');
  });
});

test('管理员不能暂停或降级自己，暂停会撤销旧会话但允许新建受限会话', async () => {
  await withDatabase('tongjian-governance-account-', (database, service) => {
    const administrator = seedUser(database, 'account-admin', 'administrator');
    const member = seedUser(database, 'account-member');
    const staff = seedUser(database, 'account-staff', 'moderator');

    assert.throws(() => service.changeUserStatus({
      userId: administrator.id,
      expectedVersion: 0,
      command: 'suspend',
      publicReason: '暂停管理员自己',
      internalNote: '测试自我操作保护'
    }, context(administrator.id, 'self-suspend')), appError('SELF_GOVERNANCE_FORBIDDEN', 403));
    assert.throws(() => service.setUserRole({
      userId: administrator.id,
      expectedVersion: 0,
      role: 'member',
      publicReason: '降低管理员自己的角色',
      internalNote: '测试最后管理员和自我操作保护'
    }, context(administrator.id, 'self-demote')), appError('SELF_GOVERNANCE_FORBIDDEN', 403));
    assert.equal(database.governance.activeAdministratorCount(), 1);
    assert.deepEqual(
      [database.governance.getUser(administrator.id).role, database.governance.getUser(administrator.id).status],
      ['administrator', 'active']
    );

    const staffToken = '9'.repeat(64);
    database.createSession({
      tokenHash: staffToken,
      userId: staff.id,
      csrfTokenHash: '8'.repeat(64),
      createdAt: '2026-08-25T00:20:00.000Z',
      expiresAt: '2026-09-25T00:20:00.000Z'
    });
    service.markCmsReauthenticated({ sessionTokenHash: staffToken }, context(
      staff.id, 'staff-reauth', '2026-08-25T00:30:00.000Z'
    ));
    assert.equal(database.findSessionByTokenHash(
      staffToken, '2026-08-25T00:40:00.000Z'
    ).cmsVerifiedAt, '2026-08-25T00:30:00.000Z');
    service.setUserRole({
      userId: staff.id,
      expectedVersion: 0,
      role: 'member',
      publicReason: '暂时撤销工作人员角色',
      internalNote: '角色变化必须使旧后台密码复核立即失效'
    }, context(administrator.id, 'staff-demote', '2026-08-25T00:40:00.000Z'));
    assert.equal(database.findSessionByTokenHash(
      staffToken, '2026-08-25T00:50:00.000Z'
    ).cmsVerifiedAt, null);
    service.setUserRole({
      userId: staff.id,
      expectedVersion: 1,
      role: 'moderator',
      publicReason: '重新授予工作人员角色',
      internalNote: '恢复角色后仍必须重新输入密码'
    }, context(administrator.id, 'staff-regrant', '2026-08-25T00:50:00.000Z'));
    assert.equal(database.findSessionByTokenHash(
      staffToken, '2026-08-25T01:00:00.000Z'
    ).cmsVerifiedAt, null);

    const oldToken = 'a'.repeat(64);
    database.createSession({
      tokenHash: oldToken,
      userId: member.id,
      csrfTokenHash: 'b'.repeat(64),
      createdAt: '2026-08-25T01:00:00.000Z',
      expiresAt: '2026-09-25T01:00:00.000Z'
    });
    const suspension = service.changeUserStatus({
      userId: member.id,
      expectedVersion: 0,
      command: 'suspend',
      publicReason: '因明确违规暂停写入权限',
      internalNote: '撤销现有会话并进入受限模式'
    }, context(administrator.id, 'suspend-member', '2026-08-25T02:00:00.000Z'));
    assert.equal(suspension.action, 'user_suspend');
    assert.equal(database.findSessionByTokenHash(oldToken, '2026-08-26T00:00:00.000Z'), null);
    assert.equal(database.governance.getUser(member.id).status, 'suspended');

    const restrictedToken = 'c'.repeat(64);
    const restrictedSession = database.createSession({
      tokenHash: restrictedToken,
      userId: member.id,
      csrfTokenHash: 'd'.repeat(64),
      createdAt: '2026-08-25T03:00:00.000Z',
      expiresAt: '2026-09-25T03:00:00.000Z'
    });
    assert.equal(restrictedSession.user.status, 'suspended');
    assert.equal(database.findSessionByTokenHash(restrictedToken, '2026-08-26T00:00:00.000Z').user.status, 'suspended');
    assert.throws(() => service.createReport({
      videoId: 'anything', reasonCategory: 'other', description: DESCRIPTION
    }, context(member.id, 'suspended-report')), appError('ACCOUNT_NOT_WRITABLE', 403));
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM notifications WHERE recipient_user_id = ? AND type = 'system'").get(member.id).count, 1);
  });
});

test('申诉只能提交一次，原操作者必须回避，撤销决定使用原动作版本做 CAS', async () => {
  await withDatabase('tongjian-governance-appeal-', (database, service) => {
    const owner = seedUser(database, 'appeal-owner');
    const moderatorA = seedUser(database, 'appeal-mod-a', 'moderator');
    const moderatorB = seedUser(database, 'appeal-mod-b', 'moderator');
    seedUser(database, 'appeal-admin', 'administrator');
    seedVideo(database, 'appeal-success-video', owner.id);
    seedVideo(database, 'appeal-conflict-video', owner.id);

    const successCase = createInvestigation(service, moderatorA.id, { videoId: 'appeal-success-video' }, 'appeal-success');
    claimInvestigation(service, moderatorA.id, successCase, 'appeal-success');
    const hideAction = moderateVideo(
      service, moderatorA.id, 'appeal-success-video', successCase.id, 0, 'hide', 'appeal-hide'
    );
    const appeal = service.submitAppeal({
      moderationActionId: hideAction.id,
      reason: APPEAL_REASON
    }, context(owner.id, 'appeal-submit', '2026-08-25T03:00:00.000Z'));
    assert.throws(() => service.submitAppeal({
      appellantUserId: moderatorB.id,
      moderationActionId: hideAction.id,
      reason: APPEAL_REASON
    }, context(owner.id, 'appeal-impersonation', '2026-08-25T03:00:30.000Z')),
    appError('APPELLANT_IDENTITY_MISMATCH', 403));
    assert.throws(() => service.submitAppeal({
      moderationActionId: hideAction.id,
      reason: APPEAL_REASON
    }, context(owner.id, 'appeal-duplicate', '2026-08-25T03:01:00.000Z')), appError('APPEAL_EXISTS', 409));
    assert.throws(() => service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: 0,
      internalReason: '原操作者不应当认领自己的决定'
    }, context(moderatorA.id, 'appeal-self-review', '2026-08-25T04:00:00.000Z')), appError('ORIGINAL_ACTOR_REVIEW_FORBIDDEN', 403));

    const claimedAppeal = service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: 0,
      internalReason: '由非原操作者认领并完成独立复核'
    }, context(moderatorB.id, 'appeal-claim', '2026-08-25T04:01:00.000Z'));
    assert.equal(claimedAppeal.status, 'in_review');
    assert.equal(claimedAppeal.reviewerUserId, moderatorB.id);

    const overturned = service.reviewAppeal({
      appealId: appeal.id,
      expectedVersion: claimedAppeal.version,
      result: 'overturned',
      publicExplanation: '复核后撤销原决定',
      internalNote: '由非原操作者完成独立复核'
    }, context(moderatorB.id, 'appeal-overturn', '2026-08-25T04:01:00.000Z'));
    assert.equal(overturned.conflict, false);
    assert.equal(overturned.appeal.status, 'resolved');
    assert.equal(overturned.appeal.result, 'overturned');
    assert.equal(overturned.reversalAction.action, 'appeal_overturn');
    assert.equal(overturned.reversalAction.reversesActionId, hideAction.id);
    assert.deepEqual(
      [database.governance.getVideo('appeal-success-video').moderation_status,
        database.governance.getVideo('appeal-success-video').moderation_version],
      ['visible', 2]
    );

    const conflictCase = createInvestigation(service, moderatorA.id, { videoId: 'appeal-conflict-video' }, 'appeal-conflict');
    claimInvestigation(service, moderatorA.id, conflictCase, 'appeal-conflict');
    const conflictedHide = moderateVideo(
      service, moderatorA.id, 'appeal-conflict-video', conflictCase.id, 0, 'hide', 'conflict-hide'
    );
    const conflictedAppeal = service.submitAppeal({
      moderationActionId: conflictedHide.id,
      reason: APPEAL_REASON
    }, context(owner.id, 'conflict-submit', '2026-08-25T06:00:00.000Z'));
    const claimedConflictAppeal = service.claimAppeal({
      appealId: conflictedAppeal.id,
      expectedVersion: conflictedAppeal.version,
      internalReason: '认领后核对原动作之后的目标状态'
    }, context(moderatorB.id, 'conflict-appeal-claim', '2026-08-25T06:00:30.000Z'));
    service.transferCase({
      caseId: conflictCase.id,
      expectedVersion: 1,
      assigneeUserId: moderatorB.id,
      internalReason: '转交另一名工作人员继续处理后续状态'
    }, context(moderatorA.id, 'conflict-transfer', '2026-08-25T06:01:00.000Z'));
    moderateVideo(service, moderatorB.id, 'appeal-conflict-video', conflictCase.id, 1, 'remove', 'conflict-new-action');

    const conflict = service.reviewAppeal({
      appealId: conflictedAppeal.id,
      expectedVersion: claimedConflictAppeal.version,
      result: 'overturned',
      publicExplanation: '当前状态已变更，需要人工处理',
      internalNote: '原动作之后已经存在新的治理动作'
    }, context(moderatorB.id, 'conflict-review', '2026-08-25T07:00:00.000Z'));
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.appeal.status, 'in_review');
    assert.equal(conflict.appeal.hasStateConflict, true);
    assert.equal(conflict.appeal.version, 2);
    assert.deepEqual(
      [database.governance.getVideo('appeal-conflict-video').moderation_status,
        database.governance.getVideo('appeal-conflict-video').moderation_version],
      ['removed', 2]
    );
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'appeal.overturn_conflict'").get().count, 1);
  });
});

test('仅剩一名有效管理员时可例外复核本人账号决定并写冲突审计', async () => {
  await withDatabase('tongjian-governance-self-review-', (database, service) => {
    const administrator = seedUser(database, 'self-review-admin', 'administrator');
    const member = seedUser(database, 'self-review-member');
    const suspension = service.changeUserStatus({
      userId: member.id,
      expectedVersion: 0,
      command: 'suspend',
      publicReason: '因明确的平台规则问题临时暂停账号写入权限。',
      internalNote: '建立唯一管理员申诉复核例外的测试决定。'
    }, context(administrator.id, 'self-review-suspend', '2026-08-25T02:00:00.000Z'));
    const appeal = service.submitAppeal({
      moderationActionId: suspension.id,
      reason: APPEAL_REASON
    }, context(member.id, 'self-review-submit', '2026-08-25T03:00:00.000Z'));
    const claimed = service.claimAppeal({
      appealId: appeal.id,
      expectedVersion: appeal.version,
      internalReason: '当前仅剩一名有效管理员，按例外流程认领复核'
    }, context(administrator.id, 'self-review-claim', '2026-08-25T04:00:00.000Z'));
    const reviewed = service.reviewAppeal({
      appealId: appeal.id,
      expectedVersion: claimed.version,
      result: 'upheld',
      publicExplanation: '复核现有证据后，维持原账号暂停决定。',
      internalNote: '唯一有效管理员例外复核，已明确记录利益冲突。'
    }, context(administrator.id, 'self-review-resolve', '2026-08-25T05:00:00.000Z'));
    assert.equal(reviewed.appeal.result, 'upheld');
    assert.equal(database.raw.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'appeal.self_review_claim_exception'"
    ).get().count, 1);
    assert.equal(database.raw.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'appeal.self_review_exception'"
    ).get().count, 1);
  });
});

test('验证重试只能回到 pending，标签合并去重关联并保留旧 slug 指向', async () => {
  await withDatabase('tongjian-governance-task-taxonomy-', (database, service) => {
    const administrator = seedUser(database, 'task-admin', 'administrator');
    assert.throws(() => service.createCategory({
      slug: 'duplicate-knowledge-name',
      name: '知识与学习',
      description: '重复显示名不应冒泡为数据库错误。',
      sortOrder: 99,
      internalReason: '验证分类显示名唯一约束的领域错误映射'
    }, context(administrator.id, 'duplicate-category-name')),
    appError('CATEGORY_NAME_EXISTS', 409));
    const failedVideo = seedVideo(database, 'failed-video', administrator.id, {
      validationStatus: 'validation_failed',
      validationStartedAt: '2026-08-25T00:05:00.000Z',
      validatedAt: '2026-08-25T00:06:00.000Z'
    });
    const readyVideo = seedVideo(database, 'already-ready-video', administrator.id);

    const retried = service.retryVideoValidation({
      videoId: 'failed-video',
      expectedValidatedAt: failedVideo.validatedAt,
      expectedValidationStartedAt: failedVideo.validationStartedAt,
      internalReason: '重试失败的技术验证任务'
    }, context(administrator.id, 'retry-validation', '2026-08-25T02:00:00.000Z'));
    assert.equal(retried.validation_status, 'pending');
    assert.equal(database.governance.getVideo('failed-video').validation_status, 'pending');
    assert.notEqual(database.governance.getVideo('failed-video').validation_status, 'ready');
    assert.throws(() => service.retryVideoValidation({
      videoId: 'already-ready-video',
      expectedValidatedAt: readyVideo.validatedAt === null ? '__null__' : readyVideo.validatedAt,
      expectedValidationStartedAt: readyVideo.validationStartedAt === null
        ? '__null__'
        : readyVideo.validationStartedAt,
      internalReason: '不允许将已就绪视频写成其他状态'
    }, context(administrator.id, 'retry-ready')), appError('VALIDATION_RETRY_CONFLICT', 409));

    database.raw.prepare(`
      UPDATE videos
      SET validation_status = 'validation_failed',
        validation_started_at = '2026-08-25T02:10:00.000Z',
        validated_at = '2026-08-25T02:11:00.000Z',
        validation_summary = '{"message":"new failure"}'
      WHERE id = 'failed-video'
    `).run();
    assert.throws(() => service.retryVideoValidation({
      videoId: 'failed-video',
      expectedValidatedAt: failedVideo.validatedAt,
      expectedValidationStartedAt: failedVideo.validationStartedAt,
      internalReason: '陈旧页面不能覆盖新一轮验证失败'
    }, context(administrator.id, 'retry-validation-stale', '2026-08-25T02:12:00.000Z')),
    appError('VALIDATION_RETRY_CONFLICT', 409));
    const newerFailure = database.governance.getVideo('failed-video');
    assert.equal(newerFailure.validation_status, 'validation_failed');
    assert.equal(newerFailure.validated_at, '2026-08-25T02:11:00.000Z');
    assert.equal(database.raw.prepare(`
      SELECT count(*) AS count FROM audit_events
      WHERE action = 'task.video_validation_retried' AND object_id = 'failed-video'
    `).get().count, 1);

    const queuedDeletion = database.enqueueFileDeletion({
      kind: 'video', storageName: 'failed-delete.mp4', createdAt: '2026-08-25T02:05:00.000Z'
    });
    const failedDeletion = database.failFileDeletion(
      queuedDeletion.id,
      '模拟文件删除失败',
      '2026-08-25T02:06:00.000Z'
    );
    const retriedDeletion = service.retryDeletion({
      deletionId: failedDeletion.id,
      expectedUpdatedAt: failedDeletion.updatedAt,
      internalReason: '确认失败原因后令删除 worker 立即重试'
    }, context(administrator.id, 'retry-deletion', '2026-08-25T02:07:00.000Z'));
    assert.equal(retriedDeletion.next_attempt_at, '2026-08-25T02:07:00.000Z');
    assert.throws(() => service.retryDeletion({
      deletionId: failedDeletion.id,
      expectedUpdatedAt: failedDeletion.updatedAt,
      internalReason: '陈旧页面不能重复覆盖任务调度时间'
    }, context(administrator.id, 'retry-deletion-stale', '2026-08-25T02:08:00.000Z')),
    appError('DELETION_RETRY_CONFLICT', 409));

    const source = service.createTag({
      slug: 'old-topic',
      name: '旧主题',
      internalReason: '为标签合并测试创建源标签'
    }, context(administrator.id, 'create-source-tag', '2026-08-25T03:00:00.000Z'));
    const target = service.createTag({
      slug: 'canonical-topic',
      name: '规范主题',
      internalReason: '为标签合并测试创建目标标签'
    }, context(administrator.id, 'create-target-tag', '2026-08-25T03:01:00.000Z'));
    const updatedTarget = service.updateTag({
      tagId: target.id,
      expectedUpdatedAt: target.updated_at,
      name: '规范主题',
      isActive: true,
      internalReason: '同一毫秒内修改也必须产生新的 CAS 版本'
    }, context(administrator.id, 'update-target-same-millisecond', target.updated_at));
    assert.notEqual(updatedTarget.updated_at, target.updated_at);
    assert.throws(() => service.updateTag({
      tagId: target.id,
      expectedUpdatedAt: target.updated_at,
      name: '陈旧页面不应保存',
      isActive: true,
      internalReason: '验证同毫秒修改后的陈旧版本冲突'
    }, context(administrator.id, 'update-target-stale', '2026-08-25T03:01:00.000Z')),
    appError('TAG_VERSION_CONFLICT', 409));
    seedVideo(database, 'tag-video-overlap', administrator.id, {
      createdAt: '2026-08-25T03:02:00.000Z',
      tags: [
        { slug: source.slug, name: source.name },
        { slug: updatedTarget.slug, name: updatedTarget.name }
      ]
    });
    seedVideo(database, 'tag-video-source-only', administrator.id, {
      createdAt: '2026-08-25T03:03:00.000Z',
      tags: [{ slug: source.slug, name: source.name }]
    });

    const merged = service.mergeTag({
      sourceTagId: source.id,
      targetTagId: target.id,
      expectedUpdatedAt: source.updated_at,
      internalReason: '将重复标签合并到规范标签'
    }, context(administrator.id, 'merge-tag', '2026-08-25T04:00:00.000Z'));
    assert.equal(merged.is_active, 0);
    assert.equal(merged.merged_into_id, target.id);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM video_tags WHERE tag_id = ?').get(source.id).count, 0);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM video_tags WHERE tag_id = ?').get(target.id).count, 2);
    const legacyTag = database.getTagBySlug(source.slug);
    assert.equal(legacyTag.isActive, false);
    assert.equal(legacyTag.mergedIntoId, target.id);
    assert.equal(legacyTag.mergedIntoSlug, target.slug);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'task.video_validation_retried'").get().count, 1);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'task.file_deletion_retried'").get().count, 1);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'taxonomy.tag_merged'").get().count, 1);
  });
});

test('讨论删除使用配置的申诉窗口保留近期治理证据', async () => {
  await withDatabase('tongjian-governance-retention-', (database, service) => {
    const owner = seedUser(database, 'retention-owner');
    const moderator = seedUser(database, 'retention-mod', 'moderator');
    seedVideo(database, 'retention-video', owner.id, { createdAt: '2026-06-20T00:00:00.000Z' });
    const discussion = seedDiscussion(database, 'retention-video', owner.id, 'retention');
    const moderationCase = service.createInvestigation({
      discussionId: discussion.id,
      reasonCategory: 'other',
      description: DESCRIPTION
    }, context(moderator.id, 'retention-create', '2026-06-25T00:00:00.000Z'));
    service.claimCase({
      caseId: moderationCase.id,
      expectedVersion: 0,
      internalReason: '认领长期申诉窗口的证据保留测试'
    }, context(moderator.id, 'retention-claim', '2026-06-26T00:00:00.000Z'));
    service.moderateDiscussion({
      discussionId: discussion.id,
      caseId: moderationCase.id,
      expectedVersion: 0,
      command: 'hide',
      publicReason: '暂时隐藏以完成规则核查',
      internalNote: '形成需要在申诉窗口内保留的治理动作'
    }, context(moderator.id, 'retention-hide', '2026-06-30T00:00:00.000Z'));
    service.moderateDiscussion({
      discussionId: discussion.id,
      caseId: moderationCase.id,
      expectedVersion: 1,
      command: 'restore',
      publicReason: '完成核查后恢复讨论内容',
      internalNote: '恢复公开状态但仍保留原隐藏决定的申诉期限'
    }, context(moderator.id, 'retention-restore', '2026-07-01T00:00:00.000Z'));
    service.resolveCase({
      caseId: moderationCase.id,
      expectedVersion: 1,
      resolution: 'violation_confirmed',
      publicExplanation: '案件已完成核查，相关内容现已恢复显示。',
      internalReason: '完成案件以隔离申诉窗口对删除的独立保护'
    }, context(moderator.id, 'retention-resolve', '2026-07-02T00:00:00.000Z'));

    assert.equal(database.editDiscussion(discussion.id, owner.id, {
      title: discussion.title,
      bodyMarkdown: '试图在 60 天申诉窗口内覆盖原始证据',
      editedAt: '2026-08-25T00:00:00.000Z'
    }, '2026-06-26T00:00:00.000Z'), null, '60 天申诉窗口内不能编辑治理证据');
    assert.equal(database.getDiscussion(discussion.id).bodyMarkdown, `这是讨论正文 retention`);

    assert.equal(database.deleteDiscussion(
      discussion.id,
      owner.id,
      '2026-08-25T00:00:00.000Z',
      '2026-06-26T00:00:00.000Z'
    ), null, '60 天申诉窗口内不能删除治理证据');
    assert.equal(database.getDiscussion(discussion.id).bodyMarkdown, `这是讨论正文 retention`);

    assert.deepEqual(database.deleteDiscussion(
      discussion.id,
      owner.id,
      '2026-08-25T00:00:00.000Z'
    ), { id: discussion.id, mode: 'tombstoned' }, '默认 30 天窗口已过时才允许作者删除');
  });
});
