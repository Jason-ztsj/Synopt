function jsonObject(value) {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function page(options = {}, defaultLimit = 25) {
  const limit = Number.isSafeInteger(options.limit)
    ? Math.min(Math.max(options.limit, 1), 100)
    : defaultLimit;
  const offset = Number.isSafeInteger(options.offset) ? Math.max(options.offset, 0) : 0;
  return { limit, offset };
}

function mapCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    reporterUserId: row.reporter_user_id ?? null,
    reporterUsername: row.reporter_username ?? null,
    openedByUserId: row.opened_by_user_id ?? null,
    openedByName: row.opened_by_name ?? null,
    videoId: row.video_id ?? null,
    videoTitle: row.video_title ?? null,
    discussionId: row.discussion_id ?? null,
    discussionTitle: row.discussion_title ?? null,
    targetAuthorUserId: row.target_author_user_id ?? null,
    discussionVideoAuthorUserId: row.discussion_video_author_user_id ?? null,
    reasonCategory: row.reason_category,
    description: row.description,
    status: row.status,
    assigneeUserId: row.assignee_user_id ?? null,
    assigneeName: row.assignee_name ?? null,
    resolution: row.resolution ?? null,
    publicExplanation: row.public_explanation ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? null
  };
}

function mapAction(row) {
  if (!row) return null;
  const targetType = row.video_id ? 'video' : row.discussion_id ? 'discussion' : 'user';
  const targetId = row.video_id ?? row.discussion_id ?? row.user_id ?? null;
  return {
    id: row.id,
    caseId: row.case_id ?? null,
    actorUserId: row.actor_user_id ?? null,
    actorLabel: row.actor_label ?? null,
    actorName: row.actor_name ?? row.actor_label ?? null,
    affectedUserId: row.affected_user_id ?? null,
    videoId: row.video_id ?? null,
    videoTitle: row.video_title ?? null,
    discussionId: row.discussion_id ?? null,
    userId: row.user_id ?? null,
    targetType,
    targetId,
    targetUsername: row.target_username ?? null,
    action: row.action,
    publicReason: row.public_reason,
    internalNote: row.internal_note,
    before: jsonObject(row.before_json),
    after: jsonObject(row.after_json),
    beforeVersion: row.before_version,
    afterVersion: row.after_version,
    reversesActionId: row.reverses_action_id ?? null,
    createdAt: row.created_at
  };
}

function mapAppeal(row) {
  if (!row) return null;
  const targetType = row.video_id ? 'video' : row.discussion_id ? 'discussion' : 'user';
  const targetId = row.video_id ?? row.discussion_id ?? row.target_user_id ?? null;
  return {
    id: row.id,
    moderationActionId: row.moderation_action_id,
    actionId: row.moderation_action_id,
    appellantUserId: row.appellant_user_id,
    appellantUsername: row.appellant_username ?? null,
    reason: row.reason,
    status: row.status,
    result: row.result ?? null,
    outcome: row.result ?? null,
    reviewerUserId: row.reviewer_user_id ?? null,
    reviewerName: row.reviewer_name ?? null,
    reviewerDisplayName: row.reviewer_name ?? null,
    publicExplanation: row.public_explanation ?? null,
    hasStateConflict: row.has_state_conflict === 1,
    stateConflict: row.has_state_conflict === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? null,
    action: row.action ?? null,
    actionType: row.action ?? null,
    actionActorUserId: row.action_actor_user_id ?? null,
    actionCaseId: row.action_case_id ?? null,
    actionCaseReporterUserId: row.action_case_reporter_user_id ?? null,
    actionPublicReason: row.action_public_reason ?? null,
    actionCreatedAt: row.action_created_at ?? null,
    videoId: row.video_id ?? null,
    discussionId: row.discussion_id ?? null,
    discussionVideoAuthorUserId: row.discussion_video_author_user_id ?? null,
    targetUserId: row.target_user_id ?? null,
    targetType,
    targetId,
    targetTitle: row.video_title ?? row.discussion_title ?? row.target_username ?? null
  };
}

const CASE_SELECT = `
  SELECT c.*,
    reporter.username AS reporter_username,
    opener.display_name AS opened_by_name,
    assignee.display_name AS assignee_name,
    v.title AS video_title,
    COALESCE(d.title, substr(d.body_markdown, 1, 80)) AS discussion_title,
    COALESCE(v.user_id, d.user_id) AS target_author_user_id,
    discussion_video.user_id AS discussion_video_author_user_id
  FROM moderation_cases AS c
  LEFT JOIN users AS reporter ON reporter.id = c.reporter_user_id
  LEFT JOIN users AS opener ON opener.id = c.opened_by_user_id
  LEFT JOIN users AS assignee ON assignee.id = c.assignee_user_id
  LEFT JOIN videos AS v ON v.id = c.video_id
  LEFT JOIN discussions AS d ON d.id = c.discussion_id
  LEFT JOIN videos AS discussion_video ON discussion_video.id = d.video_id
`;

const ACTION_SELECT = `
  SELECT a.*,
    actor.display_name AS actor_name,
    v.title AS video_title,
    target.username AS target_username
  FROM moderation_actions AS a
  LEFT JOIN users AS actor ON actor.id = a.actor_user_id
  LEFT JOIN videos AS v ON v.id = a.video_id
  LEFT JOIN users AS target ON target.id = a.user_id
`;

const APPEAL_SELECT = `
  SELECT p.*,
    appellant.username AS appellant_username,
    reviewer.display_name AS reviewer_name,
    a.action, a.actor_user_id AS action_actor_user_id,
    a.case_id AS action_case_id,
    action_case.reporter_user_id AS action_case_reporter_user_id,
    a.public_reason AS action_public_reason, a.created_at AS action_created_at,
    a.video_id, a.discussion_id, a.user_id AS target_user_id,
    v.title AS video_title,
    COALESCE(d.title, substr(d.body_markdown, 1, 80)) AS discussion_title,
    discussion_video.user_id AS discussion_video_author_user_id,
    target.username AS target_username
  FROM appeals AS p
  JOIN moderation_actions AS a ON a.id = p.moderation_action_id
  LEFT JOIN moderation_cases AS action_case ON action_case.id = a.case_id
  JOIN users AS appellant ON appellant.id = p.appellant_user_id
  LEFT JOIN users AS reviewer ON reviewer.id = p.reviewer_user_id
  LEFT JOIN videos AS v ON v.id = a.video_id
  LEFT JOIN discussions AS d ON d.id = a.discussion_id
  LEFT JOIN videos AS discussion_video ON discussion_video.id = d.video_id
  LEFT JOIN users AS target ON target.id = a.user_id
`;

export function createGovernanceStore(database) {
  const governanceUserSelect = `
    SELECT id, username, display_name, bio, avatar_storage_name, avatar_media_type,
      role, status, governance_version, updated_at, created_at, deleted_at
    FROM users
  `;
  const store = {
    transaction(action) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = action(store);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },

    getUser(id) {
      return database.prepare(`${governanceUserSelect} WHERE id = ?`).get(id) ?? null;
    },

    findUserByUsername(username) {
      return database.prepare(`${governanceUserSelect} WHERE username = ? COLLATE NOCASE`).get(username) ?? null;
    },

    getVideo(id) {
      return database.prepare(`
        SELECT v.*, u.username AS owner_username, u.display_name AS owner_display_name,
          c.name AS category_name, c.slug AS category_slug
        FROM videos AS v
        LEFT JOIN users AS u ON u.id = v.user_id
        LEFT JOIN categories AS c ON c.id = v.category_id
        WHERE v.id = ?
      `).get(id) ?? null;
    },

    getDiscussion(id) {
      return database.prepare(`
        SELECT d.*, u.username AS owner_username, u.display_name AS owner_display_name,
          v.title AS video_title, v.visibility AS video_visibility,
          v.moderation_status AS video_moderation_status,
          v.validation_status AS video_validation_status,
          v.withdrawn_at AS video_withdrawn_at, v.deleted_at AS video_deleted_at,
          v.user_id AS video_owner_user_id
        FROM discussions AS d
        JOIN videos AS v ON v.id = d.video_id
        LEFT JOIN users AS u ON u.id = d.user_id
        WHERE d.id = ?
      `).get(id) ?? null;
    },

    hasTargetReporterConflict(reporterUserId, videoId = null, discussionId = null) {
      if (!reporterUserId || (!videoId && !discussionId)) return false;
      return Boolean(database.prepare(`
        SELECT 1 FROM moderation_cases
        WHERE reporter_user_id = ?
          AND (
            (? IS NOT NULL AND video_id = ?)
            OR (? IS NOT NULL AND discussion_id = ?)
          )
        LIMIT 1
      `).get(reporterUserId, videoId, videoId, discussionId, discussionId));
    },

    hasTargetStake(userId, videoId = null, discussionId = null) {
      if (!userId || (!videoId && !discussionId)) return false;
      return Boolean(database.prepare(`
        SELECT 1
        WHERE (
          ? IS NOT NULL AND EXISTS (
            SELECT 1 FROM videos AS target_video
            WHERE target_video.id = ? AND target_video.user_id = ?
          )
        ) OR (
          ? IS NOT NULL AND EXISTS (
            SELECT 1
            FROM discussions AS target_discussion
            JOIN videos AS discussion_video ON discussion_video.id = target_discussion.video_id
            WHERE target_discussion.id = ?
              AND (target_discussion.user_id = ? OR discussion_video.user_id = ?)
          )
        )
      `).get(
        videoId, videoId, userId,
        discussionId, discussionId, userId, userId
      ));
    },

    hasUserReporterConflict(reporterUserId, targetUserId) {
      if (!reporterUserId || !targetUserId) return false;
      return Boolean(database.prepare(`
        SELECT 1
        FROM moderation_cases AS reported_case
        LEFT JOIN videos AS reported_video ON reported_video.id = reported_case.video_id
        LEFT JOIN discussions AS reported_discussion
          ON reported_discussion.id = reported_case.discussion_id
        WHERE reported_case.reporter_user_id = ?
          AND (reported_video.user_id = ? OR reported_discussion.user_id = ?)
        LIMIT 1
      `).get(reporterUserId, targetUserId, targetUserId));
    },

    listDiscussionConflictIds(videoId, viewerUserId) {
      if (!videoId || !viewerUserId) return [];
      return database.prepare(`
        SELECT d.id
        FROM discussions AS d
        WHERE d.video_id = ?
          AND (
            d.user_id = ?
            OR EXISTS (
              SELECT 1 FROM videos AS discussion_video
              WHERE discussion_video.id = d.video_id AND discussion_video.user_id = ?
            )
            OR EXISTS (
              SELECT 1 FROM moderation_cases AS viewer_report
              WHERE viewer_report.discussion_id = d.id
                AND viewer_report.reporter_user_id = ?
            )
          )
        ORDER BY d.id ASC
      `).all(videoId, viewerUserId, viewerUserId, viewerUserId).map((row) => row.id);
    },

    getCase(id) {
      return mapCase(database.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id));
    },

    getAction(id) {
      return mapAction(database.prepare(`${ACTION_SELECT} WHERE a.id = ?`).get(id));
    },

    getAppeal(id) {
      return mapAppeal(database.prepare(`${APPEAL_SELECT} WHERE p.id = ?`).get(id));
    },

    createCase(values) {
      const result = database.prepare(`
        INSERT INTO moderation_cases (
          source, reporter_user_id, opened_by_user_id, video_id, discussion_id,
          reason_category, description, status, assignee_user_id,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, 0, ?, ?)
      `).run(
        values.source,
        values.reporterUserId ?? null,
        values.openedByUserId ?? null,
        values.videoId ?? null,
        values.discussionId ?? null,
        values.reasonCategory,
        values.description,
        values.createdAt,
        values.createdAt
      );
      return store.getCase(Number(result.lastInsertRowid));
    },

    claimCase(id, expectedVersion, assigneeUserId, updatedAt) {
      const changed = database.prepare(`
        UPDATE moderation_cases
        SET assignee_user_id = ?, status = 'in_review', version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'open' AND assignee_user_id IS NULL
      `).run(assigneeUserId, updatedAt, id, expectedVersion).changes;
      return changed === 1 ? store.getCase(id) : null;
    },

    transferCase(id, expectedVersion, assigneeUserId, updatedAt) {
      const changed = database.prepare(`
        UPDATE moderation_cases
        SET assignee_user_id = ?, status = 'in_review', version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'in_review'
      `).run(assigneeUserId, updatedAt, id, expectedVersion).changes;
      return changed === 1 ? store.getCase(id) : null;
    },

    resolveCase(id, expectedVersion, resolution, publicExplanation, resolvedAt) {
      const changed = database.prepare(`
        UPDATE moderation_cases
        SET status = 'resolved', resolution = ?, public_explanation = ?,
            resolved_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND status = 'in_review'
      `).run(resolution, publicExplanation, resolvedAt, resolvedAt, id, expectedVersion).changes;
      return changed === 1 ? store.getCase(id) : null;
    },

    touchAssignedCase(id, expectedVersion, assigneeUserId, updatedAt) {
      const changed = database.prepare(`
        UPDATE moderation_cases
        SET version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'in_review' AND assignee_user_id = ?
      `).run(updatedAt, id, expectedVersion, assigneeUserId).changes;
      return changed === 1 ? store.getCase(id) : null;
    },

    insertCaseNote(caseId, authorUserId, body, createdAt) {
      const result = database.prepare(`
        INSERT INTO case_notes (case_id, author_user_id, body, created_at)
        VALUES (?, ?, ?, ?)
      `).run(caseId, authorUserId, body, createdAt);
      return Number(result.lastInsertRowid);
    },

    listCaseNotes(caseId) {
      return database.prepare(`
        SELECT n.*, u.display_name AS author_name
        FROM case_notes AS n LEFT JOIN users AS u ON u.id = n.author_user_id
        WHERE n.case_id = ? ORDER BY n.created_at ASC, n.id ASC
      `).all(caseId).map((row) => ({
        id: row.id, caseId: row.case_id, authorUserId: row.author_user_id ?? null,
        authorName: row.author_name ?? '已离任工作人员', body: row.body, createdAt: row.created_at
      }));
    },

    insertAction(values) {
      const result = database.prepare(`
        INSERT INTO moderation_actions (
          case_id, actor_user_id, actor_label, affected_user_id,
          video_id, discussion_id, user_id, action,
          public_reason, internal_note, before_json, after_json,
          before_version, after_version, reverses_action_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.caseId ?? null,
        values.actorUserId ?? null,
        values.actorLabel ?? null,
        values.affectedUserId ?? null,
        values.videoId ?? null,
        values.discussionId ?? null,
        values.userId ?? null,
        values.action,
        values.publicReason,
        values.internalNote,
        JSON.stringify(values.before ?? {}),
        JSON.stringify(values.after ?? {}),
        values.beforeVersion,
        values.afterVersion,
        values.reversesActionId ?? null,
        values.createdAt
      );
      return store.getAction(Number(result.lastInsertRowid));
    },

    updateVideoModeration(id, expectedVersion, status) {
      return database.prepare(`
        UPDATE videos SET moderation_status = ?, moderation_version = moderation_version + 1
        WHERE id = ? AND moderation_version = ? AND deleted_at IS NULL
      `).run(status, id, expectedVersion).changes;
    },

    updateDiscussionModeration(id, expectedVersion, status) {
      return database.prepare(`
        UPDATE discussions SET moderation_status = ?, moderation_version = moderation_version + 1
        WHERE id = ? AND moderation_version = ? AND deleted_at IS NULL
      `).run(status, id, expectedVersion).changes;
    },

    updateUserStatus(id, expectedVersion, status, updatedAt) {
      return database.prepare(`
        UPDATE users SET status = ?, governance_version = governance_version + 1, updated_at = ?
        WHERE id = ? AND governance_version = ? AND deleted_at IS NULL AND status != 'disabled'
      `).run(status, updatedAt, id, expectedVersion).changes;
    },

    updateUserRole(id, expectedVersion, role, updatedAt) {
      return database.prepare(`
        UPDATE users SET role = ?, governance_version = governance_version + 1, updated_at = ?
        WHERE id = ? AND governance_version = ? AND deleted_at IS NULL AND status != 'disabled'
      `).run(role, updatedAt, id, expectedVersion).changes;
    },

    touchUserGovernance(id, expectedVersion, updatedAt) {
      return database.prepare(`
        UPDATE users SET governance_version = governance_version + 1, updated_at = ?
        WHERE id = ? AND governance_version = ? AND deleted_at IS NULL AND status != 'disabled'
      `).run(updatedAt, id, expectedVersion).changes;
    },

    revokeUserSessions(userId) {
      return database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
    },

    revokeUserCmsGrants(userId) {
      return database.prepare(`
        DELETE FROM cms_media_access_grants
        WHERE granted_by_user_id = ? OR session_token_hash IN (
          SELECT token_hash FROM sessions WHERE user_id = ?
        )
      `).run(userId, userId).changes;
    },

    clearUserCmsVerification(userId) {
      return database.prepare('UPDATE sessions SET cms_verified_at = NULL WHERE user_id = ?')
        .run(userId).changes;
    },

    revokeCaseMediaGrants(caseId) {
      return database.prepare('DELETE FROM cms_media_access_grants WHERE case_id = ?')
        .run(caseId).changes;
    },

    activeAdministratorCount() {
      return database.prepare(`
        SELECT count(*) AS count FROM users
        WHERE role = 'administrator' AND status = 'active' AND deleted_at IS NULL
      `).get().count;
    },

    listSessionsForUser(userId, nowIso) {
      return database.prepare(`
        SELECT created_at, expires_at, cms_verified_at
        FROM sessions
        WHERE user_id = ? AND expires_at > ?
        ORDER BY created_at DESC, token_hash DESC
      `).all(userId, nowIso);
    },

    activeReviewerCount(accountOnly = false) {
      return database.prepare(`
        SELECT count(*) AS count FROM users
        WHERE status = 'active' AND deleted_at IS NULL
          AND role ${accountOnly ? "= 'administrator'" : "IN ('moderator', 'administrator')"}
      `).get().count;
    },

    activeAlternativeReviewerCount(
      accountOnly,
      originalActorUserId,
      appellantUserId,
      videoId = null,
      discussionId = null,
      targetUserId = null
    ) {
      return database.prepare(`
        SELECT count(*) AS count FROM users AS candidate
        WHERE candidate.status = 'active' AND candidate.deleted_at IS NULL
          AND candidate.role ${accountOnly ? "= 'administrator'" : "IN ('moderator', 'administrator')"}
          AND candidate.id != ? AND candidate.id != ?
          AND NOT (
            (? IS NOT NULL AND EXISTS (
              SELECT 1 FROM videos AS candidate_target_video
              WHERE candidate_target_video.id = ?
                AND candidate_target_video.user_id = candidate.id
            ))
            OR (? IS NOT NULL AND EXISTS (
              SELECT 1
              FROM discussions AS candidate_target_discussion
              JOIN videos AS candidate_discussion_video
                ON candidate_discussion_video.id = candidate_target_discussion.video_id
              WHERE candidate_target_discussion.id = ?
                AND (
                  candidate_target_discussion.user_id = candidate.id
                  OR candidate_discussion_video.user_id = candidate.id
                )
            ))
          )
          AND NOT EXISTS (
            SELECT 1 FROM moderation_cases AS candidate_report
            LEFT JOIN videos AS candidate_report_video
              ON candidate_report_video.id = candidate_report.video_id
            LEFT JOIN discussions AS candidate_report_discussion
              ON candidate_report_discussion.id = candidate_report.discussion_id
            WHERE candidate_report.reporter_user_id = candidate.id
              AND (
                (? IS NOT NULL AND candidate_report.video_id = ?)
                OR (? IS NOT NULL AND candidate_report.discussion_id = ?)
                OR (
                  ? IS NOT NULL
                  AND (
                    candidate_report_video.user_id = ?
                    OR candidate_report_discussion.user_id = ?
                  )
                )
              )
          )
      `).get(
        originalActorUserId,
        appellantUserId,
        videoId,
        videoId,
        discussionId,
        discussionId,
        videoId,
        videoId,
        discussionId,
        discussionId,
        targetUserId,
        targetUserId,
        targetUserId
      ).count;
    },

    insertAudit(values) {
      const result = database.prepare(`
        INSERT INTO audit_events (
          actor_user_id, actor_label, request_id, action, object_type, object_id,
          before_json, after_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.actorUserId ?? null,
        values.actorLabel ?? null,
        values.requestId,
        values.action,
        values.objectType,
        String(values.objectId),
        JSON.stringify(values.before ?? {}),
        JSON.stringify(values.after ?? {}),
        JSON.stringify(values.metadata ?? {}),
        values.createdAt
      );
      return Number(result.lastInsertRowid);
    },

    createMandatoryNotification(recipientUserId, title, body, link, createdAt) {
      if (!recipientUserId) return null;
      const target = database.prepare(`
        SELECT id FROM users
        WHERE id = ? AND status IN ('active', 'suspended') AND deleted_at IS NULL
      `).get(recipientUserId);
      if (!target) return null;
      // Governance records keep the complete public explanation (up to 2,000
      // code points). The pre-existing notification schema has a 1,000-code-
      // point preview limit, so keep the source of truth intact and truncate
      // only the inbox preview.
      const notificationBody = Array.from(String(body ?? '')).slice(0, 1000).join('');
      const result = database.prepare(`
        INSERT INTO notifications (
          recipient_user_id, type, event_count, is_read,
          system_title, system_body, system_link, created_at, updated_at
        ) VALUES (?, 'system', 1, 0, ?, ?, ?, ?, ?)
      `).run(recipientUserId, title, notificationBody, link, createdAt, createdAt);
      return Number(result.lastInsertRowid);
    },

    createAppeal(values) {
      const result = database.prepare(`
        INSERT INTO appeals (
          moderation_action_id, appellant_user_id, reason,
          status, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 0, ?, ?)
      `).run(
        values.moderationActionId,
        values.appellantUserId,
        values.reason,
        values.createdAt,
        values.createdAt
      );
      return store.getAppeal(Number(result.lastInsertRowid));
    },

    resolveAppeal(id, expectedVersion, values) {
      const changed = database.prepare(`
        UPDATE appeals
        SET status = ?, result = ?, reviewer_user_id = ?, public_explanation = ?,
            has_state_conflict = ?, version = version + 1, updated_at = ?, resolved_at = ?
        WHERE id = ? AND version = ? AND status IN ('pending', 'in_review')
      `).run(
        values.status,
        values.result ?? null,
        values.reviewerUserId,
        values.publicExplanation ?? null,
        values.hasStateConflict ? 1 : 0,
        values.updatedAt,
        values.resolvedAt ?? null,
        id,
        expectedVersion
      ).changes;
      return changed === 1 ? store.getAppeal(id) : null;
    },

    claimAppeal(id, expectedVersion, reviewerUserId, updatedAt) {
      const changed = database.prepare(`
        UPDATE appeals
        SET status = 'in_review', reviewer_user_id = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'pending' AND reviewer_user_id IS NULL
      `).run(reviewerUserId, updatedAt, id, expectedVersion).changes;
      return changed === 1 ? store.getAppeal(id) : null;
    },

    transferAppeal(id, expectedVersion, reviewerUserId, updatedAt) {
      const changed = database.prepare(`
        UPDATE appeals
        SET reviewer_user_id = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'in_review' AND reviewer_user_id IS NOT NULL
      `).run(reviewerUserId, updatedAt, id, expectedVersion).changes;
      return changed === 1 ? store.getAppeal(id) : null;
    },

    updateSessionCmsVerifiedAt(tokenHash, userId, verifiedAt) {
      return database.prepare('UPDATE sessions SET cms_verified_at = ? WHERE token_hash = ? AND user_id = ?')
        .run(verifiedAt, tokenHash, userId).changes;
    },

    sessionBelongsToUser(tokenHash, userId, nowIso) {
      return Boolean(database.prepare(`
        SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?
      `).get(tokenHash, userId, nowIso));
    },

    upsertMediaGrant(values) {
      database.prepare(`
        INSERT INTO cms_media_access_grants (
          session_token_hash, case_id, video_id, granted_by_user_id,
          reason, granted_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_token_hash, case_id, video_id) DO UPDATE SET
          granted_by_user_id = excluded.granted_by_user_id,
          reason = excluded.reason,
          granted_at = excluded.granted_at,
          expires_at = excluded.expires_at
      `).run(
        values.sessionTokenHash, values.caseId, values.videoId, values.grantedByUserId,
        values.reason, values.grantedAt, values.expiresAt
      );
      return store.getMediaGrant(values.sessionTokenHash, values.caseId, values.videoId, values.grantedAt);
    },

    getMediaGrant(sessionTokenHash, caseId, videoId, nowIso) {
      const row = database.prepare(`
        SELECT g.* FROM cms_media_access_grants AS g
        JOIN moderation_cases AS c ON c.id = g.case_id AND c.video_id = g.video_id
        JOIN users AS staff ON staff.id = g.granted_by_user_id
        JOIN sessions AS s ON s.token_hash = g.session_token_hash
          AND s.user_id = g.granted_by_user_id
        WHERE g.session_token_hash = ? AND g.case_id = ? AND g.video_id = ?
          AND g.expires_at > ? AND s.expires_at > ?
          AND c.status = 'in_review' AND c.assignee_user_id = g.granted_by_user_id
          AND staff.status = 'active' AND staff.deleted_at IS NULL
          AND staff.role IN ('moderator', 'administrator')
          AND NOT EXISTS (
            SELECT 1 FROM moderation_cases AS staff_report
            WHERE staff_report.reporter_user_id = g.granted_by_user_id
              AND staff_report.video_id = g.video_id
          )
      `).get(sessionTokenHash, caseId, videoId, nowIso, nowIso);
      return row ? {
        id: row.id, caseId: row.case_id, videoId: row.video_id,
        expiresAt: row.expires_at, grantedAt: row.granted_at
      } : null;
    },

    listCases(filters = {}) {
      const { limit, offset } = page(filters);
      const clauses = [];
      const values = [];
      if (['open', 'in_review', 'resolved'].includes(filters.status)) {
        clauses.push('c.status = ?');
        values.push(filters.status);
      }
      if (filters.status === 'pending') clauses.push("c.status != 'resolved'");
      if (filters.target === 'video') clauses.push('c.video_id IS NOT NULL');
      if (filters.target === 'discussion') clauses.push('c.discussion_id IS NOT NULL');
      if (typeof filters.videoId === 'string' && filters.videoId) {
        clauses.push('c.video_id = ?');
        values.push(filters.videoId);
      }
      if (Number.isSafeInteger(filters.discussionId) && filters.discussionId > 0) {
        clauses.push('c.discussion_id = ?');
        values.push(filters.discussionId);
      }
      if (typeof filters.assigneeUserId === 'string' && filters.assigneeUserId) {
        clauses.push('c.assignee_user_id = ?');
        values.push(filters.assigneeUserId);
      }
      if (typeof filters.reporterUserId === 'string' && filters.reporterUserId) {
        clauses.push('c.reporter_user_id = ?');
        values.push(filters.reporterUserId);
      }
      if (typeof filters.excludeTargetAuthorUserId === 'string' && filters.excludeTargetAuthorUserId) {
        clauses.push(`NOT (
          (c.video_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM videos AS own_video
            WHERE own_video.id = c.video_id AND own_video.user_id = ?
          ))
          OR (c.discussion_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM discussions AS own_discussion
            JOIN videos AS own_discussion_video ON own_discussion_video.id = own_discussion.video_id
            WHERE own_discussion.id = c.discussion_id
              AND (own_discussion.user_id = ? OR own_discussion_video.user_id = ?)
          ))
        )`);
        values.push(
          filters.excludeTargetAuthorUserId,
          filters.excludeTargetAuthorUserId,
          filters.excludeTargetAuthorUserId
        );
      }
      if (typeof filters.excludeReporterUserId === 'string' && filters.excludeReporterUserId) {
        clauses.push(`NOT EXISTS (
          SELECT 1 FROM moderation_cases AS viewer_report
          WHERE viewer_report.reporter_user_id = ?
            AND (
              (c.video_id IS NOT NULL AND viewer_report.video_id = c.video_id)
              OR (c.discussion_id IS NOT NULL AND viewer_report.discussion_id = c.discussion_id)
            )
        )`);
        values.push(filters.excludeReporterUserId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const items = database.prepare(`
        ${CASE_SELECT} ${where}
        ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map(mapCase);
      const total = database.prepare(`SELECT count(*) AS count FROM moderation_cases AS c ${where}`)
        .get(...values).count;
      return { items, total, limit, offset };
    },

    listActionsForCase(caseId) {
      return database.prepare(`
        ${ACTION_SELECT} WHERE a.case_id = ? ORDER BY a.created_at DESC, a.id DESC
      `).all(caseId).map(mapAction);
    },

    listActionsForTarget(targetType, targetId) {
      const column = ({ video: 'a.video_id', discussion: 'a.discussion_id', user: 'a.user_id' })[targetType];
      if (!column) return [];
      return database.prepare(`
        ${ACTION_SELECT} WHERE ${column} = ? ORDER BY a.created_at DESC, a.id DESC
      `).all(targetId).map(mapAction);
    },

    listRecentActions(limit = 20, options = {}) {
      const clauses = [];
      const values = [];
      if (options.includeUserActions === false) clauses.push('a.user_id IS NULL');
      if (typeof options.excludeAffectedUserId === 'string' && options.excludeAffectedUserId) {
        clauses.push(`NOT (
          (a.affected_user_id IS NOT NULL AND a.affected_user_id = ?)
          OR (a.discussion_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM discussions AS affected_discussion
            JOIN videos AS affected_discussion_video
              ON affected_discussion_video.id = affected_discussion.video_id
            WHERE affected_discussion.id = a.discussion_id
              AND affected_discussion_video.user_id = ?
          ))
        )`);
        values.push(options.excludeAffectedUserId, options.excludeAffectedUserId);
      }
      if (typeof options.excludeCaseReporterUserId === 'string' && options.excludeCaseReporterUserId) {
        clauses.push(`NOT EXISTS (
          SELECT 1 FROM moderation_cases AS reported_case
          WHERE reported_case.reporter_user_id = ?
            AND (
              (a.video_id IS NOT NULL AND reported_case.video_id = a.video_id)
              OR (a.discussion_id IS NOT NULL AND reported_case.discussion_id = a.discussion_id)
            )
        )`);
        values.push(options.excludeCaseReporterUserId);
      }
      if (
        typeof options.excludeAffectedReporterUserId === 'string'
        && options.excludeAffectedReporterUserId
      ) {
        clauses.push(`NOT EXISTS (
          SELECT 1
          FROM moderation_cases AS affected_report
          LEFT JOIN videos AS affected_report_video
            ON affected_report_video.id = affected_report.video_id
          LEFT JOIN discussions AS affected_report_discussion
            ON affected_report_discussion.id = affected_report.discussion_id
          WHERE a.user_id IS NOT NULL
            AND affected_report.reporter_user_id = ?
            AND (
              affected_report_video.user_id = a.user_id
              OR affected_report_discussion.user_id = a.user_id
            )
        )`);
        values.push(options.excludeAffectedReporterUserId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return database.prepare(`
        ${ACTION_SELECT} ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ?
      `).all(...values, Math.min(Math.max(limit, 1), 100)).map(mapAction);
    },

    listUserReports(userId, options = {}) {
      const { limit, offset } = page(options);
      const items = database.prepare(`
        SELECT c.id, c.video_id, c.discussion_id, c.reason_category,
          c.status, c.resolution, c.public_explanation, c.created_at, c.updated_at,
          CASE
            WHEN c.video_id IS NULL THEN NULL
            WHEN target_video.deleted_at IS NOT NULL THEN '已删除的视频'
            WHEN target_video.moderation_status = 'hidden' THEN '正在审核的视频'
            WHEN target_video.moderation_status = 'removed' THEN '已按规则移除的视频'
            WHEN target_video.visibility != 'public' OR target_video.withdrawn_at IS NOT NULL
              THEN '当前不可公开的视频'
            ELSE target_video.title
          END AS video_title,
          CASE
            WHEN c.discussion_id IS NULL THEN NULL
            WHEN d.deleted_at IS NOT NULL THEN '作者已删除的讨论'
            WHEN d.moderation_status = 'hidden' THEN '正在审核的讨论'
            WHEN d.moderation_status = 'removed' THEN '已按规则移除的讨论'
            WHEN discussion_video.deleted_at IS NOT NULL OR discussion_video.withdrawn_at IS NOT NULL
              OR discussion_video.visibility != 'public'
              OR discussion_video.moderation_status != 'visible'
              THEN '当前不可公开的讨论'
            ELSE COALESCE(d.title, '讨论 #' || d.id)
          END AS discussion_title
        FROM moderation_cases AS c
        LEFT JOIN videos AS target_video ON target_video.id = c.video_id
        LEFT JOIN discussions AS d ON d.id = c.discussion_id
        LEFT JOIN videos AS discussion_video ON discussion_video.id = d.video_id
        WHERE c.reporter_user_id = ?
        ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?
      `).all(userId, limit, offset).map((row) => ({
        id: row.id, videoId: row.video_id ?? null, discussionId: row.discussion_id ?? null,
        videoTitle: row.video_title ?? null, discussionTitle: row.discussion_title ?? null,
        reasonCategory: row.reason_category, status: row.status,
        resolution: row.resolution ?? null, publicExplanation: row.public_explanation ?? null,
        createdAt: row.created_at, updatedAt: row.updated_at
      }));
      const total = database.prepare(`
        SELECT count(*) AS count FROM moderation_cases WHERE reporter_user_id = ?
      `).get(userId).count;
      return { items, total, limit, offset };
    },

    listAppealableActions(userId, nowIso) {
      return database.prepare(`
        ${ACTION_SELECT}
        WHERE a.affected_user_id = ?
          AND a.action IN ('video_hide', 'video_remove', 'discussion_hide', 'discussion_remove', 'user_suspend')
          AND a.created_at >= ?
          AND NOT EXISTS (SELECT 1 FROM appeals AS p WHERE p.moderation_action_id = a.id)
        ORDER BY a.created_at DESC, a.id DESC
      `).all(userId, nowIso).map(mapAction);
    },

    listUserDecisions(userId, options = {}) {
      const { limit, offset } = page(options, 50);
      const items = database.prepare(`
        SELECT a.id, a.action, a.public_reason, a.created_at,
          a.video_id, a.discussion_id, a.user_id,
          v.title AS video_title,
          COALESCE(d.title, substr(d.body_markdown, 1, 80)) AS discussion_title,
          p.id AS appeal_id, p.status AS appeal_status, p.result AS appeal_result,
          p.public_explanation AS appeal_public_explanation
        FROM moderation_actions AS a
        LEFT JOIN videos AS v ON v.id = a.video_id
        LEFT JOIN discussions AS d ON d.id = a.discussion_id
        LEFT JOIN appeals AS p ON p.moderation_action_id = a.id
        WHERE a.affected_user_id = ?
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ? OFFSET ?
      `).all(userId, limit, offset).map((row) => ({
        id: row.id,
        action: row.action,
        publicReason: row.public_reason,
        createdAt: row.created_at,
        videoId: row.video_id ?? null,
        discussionId: row.discussion_id ?? null,
        userId: row.user_id ?? null,
        targetTitle: row.video_title ?? row.discussion_title ?? null,
        appealId: row.appeal_id ?? null,
        appealStatus: row.appeal_status ?? null,
        appealResult: row.appeal_result ?? null,
        appealPublicExplanation: row.appeal_public_explanation ?? null
      }));
      const total = database.prepare(`
        SELECT count(*) AS count FROM moderation_actions WHERE affected_user_id = ?
      `).get(userId).count;
      return { items, total, limit, offset };
    },

    listUserAppeals(userId, options = {}) {
      const { limit, offset } = page(options);
      const items = database.prepare(`
        ${APPEAL_SELECT} WHERE p.appellant_user_id = ?
        ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?
      `).all(userId, limit, offset).map(mapAppeal);
      const total = database.prepare('SELECT count(*) AS count FROM appeals WHERE appellant_user_id = ?')
        .get(userId).count;
      return { items, total, limit, offset };
    },

    listAppeals(filters = {}) {
      const { limit, offset } = page(filters);
      const clauses = [];
      const values = [];
      if (['pending', 'in_review', 'resolved'].includes(filters.status)) {
        clauses.push('p.status = ?'); values.push(filters.status);
      }
      if (filters.status === 'unresolved') clauses.push("p.status != 'resolved'");
      if (filters.includeAccountActions === false) clauses.push("a.action != 'user_suspend'");
      if (filters.target === 'video') clauses.push('a.video_id IS NOT NULL');
      if (filters.target === 'discussion') clauses.push('a.discussion_id IS NOT NULL');
      if (filters.target === 'user') clauses.push('a.user_id IS NOT NULL');
      if (filters.assignment === 'unassigned') clauses.push('p.reviewer_user_id IS NULL');
      if (filters.assignment === 'mine' && typeof filters.reviewerUserId === 'string' && filters.reviewerUserId) {
        clauses.push('p.reviewer_user_id = ?'); values.push(filters.reviewerUserId);
      }
      if (typeof filters.excludeAppellantUserId === 'string' && filters.excludeAppellantUserId) {
        clauses.push('p.appellant_user_id != ?'); values.push(filters.excludeAppellantUserId);
      }
      if (typeof filters.excludeTargetStakeUserId === 'string' && filters.excludeTargetStakeUserId) {
        clauses.push(`NOT (
          (a.video_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM videos AS stake_video
            WHERE stake_video.id = a.video_id AND stake_video.user_id = ?
          ))
          OR (a.discussion_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM discussions AS stake_discussion
            JOIN videos AS stake_discussion_video
              ON stake_discussion_video.id = stake_discussion.video_id
            WHERE stake_discussion.id = a.discussion_id
              AND (stake_discussion.user_id = ? OR stake_discussion_video.user_id = ?)
          ))
        )`);
        values.push(
          filters.excludeTargetStakeUserId,
          filters.excludeTargetStakeUserId,
          filters.excludeTargetStakeUserId
        );
      }
      if (
        typeof filters.excludeActionCaseReporterUserId === 'string'
        && filters.excludeActionCaseReporterUserId
      ) {
        clauses.push(`NOT EXISTS (
          SELECT 1 FROM moderation_cases AS reported_case
          WHERE reported_case.reporter_user_id = ?
            AND (
              (a.video_id IS NOT NULL AND reported_case.video_id = a.video_id)
              OR (a.discussion_id IS NOT NULL AND reported_case.discussion_id = a.discussion_id)
            )
        )`);
        values.push(filters.excludeActionCaseReporterUserId);
      }
      if (
        typeof filters.excludeAffectedReporterUserId === 'string'
        && filters.excludeAffectedReporterUserId
      ) {
        clauses.push(`NOT EXISTS (
          SELECT 1
          FROM moderation_cases AS affected_report
          LEFT JOIN videos AS affected_report_video
            ON affected_report_video.id = affected_report.video_id
          LEFT JOIN discussions AS affected_report_discussion
            ON affected_report_discussion.id = affected_report.discussion_id
          WHERE a.user_id IS NOT NULL
            AND affected_report.reporter_user_id = ?
            AND (
              affected_report_video.user_id = a.user_id
              OR affected_report_discussion.user_id = a.user_id
            )
        )`);
        values.push(filters.excludeAffectedReporterUserId);
      }
      if (typeof filters.query === 'string' && filters.query.trim()) {
        const query = filters.query.trim();
        const pattern = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        const numericId = Number(query);
        clauses.push(`(
          p.id = ? OR p.moderation_action_id = ?
          OR appellant.username LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR a.video_id LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR CAST(a.discussion_id AS TEXT) = ? OR a.user_id LIKE ? ESCAPE '\\' COLLATE NOCASE
        )`);
        const safeNumericId = Number.isSafeInteger(numericId) ? numericId : -1;
        values.push(safeNumericId, safeNumericId, pattern, pattern, query, pattern);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const items = database.prepare(`
        ${APPEAL_SELECT} ${where}
        ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map(mapAppeal);
      const total = database.prepare(`
        SELECT count(*) AS count
        FROM appeals AS p
        JOIN moderation_actions AS a ON a.id = p.moderation_action_id
        JOIN users AS appellant ON appellant.id = p.appellant_user_id
        ${where}
      `)
        .get(...values).count;
      return { items, total, limit, offset };
    },

    listStaff() {
      return database.prepare(`
        SELECT id, username, display_name, role, status
        FROM users WHERE role IN ('moderator', 'administrator') AND deleted_at IS NULL
        ORDER BY status = 'active' DESC, role = 'administrator' DESC, username COLLATE NOCASE ASC
      `).all().map((row) => ({
        id: row.id, username: row.username, displayName: row.display_name,
        role: row.role, status: row.status
      }));
    },

    listVideos(filters = {}) {
      const { limit, offset } = page(filters);
      const clauses = [];
      const values = [];
      if (typeof filters.validationStatus === 'string' && filters.validationStatus) {
        clauses.push('v.validation_status = ?'); values.push(filters.validationStatus);
      }
      if (typeof filters.visibility === 'string' && filters.visibility) {
        clauses.push('v.visibility = ?'); values.push(filters.visibility);
      }
      if (typeof filters.moderationStatus === 'string' && filters.moderationStatus) {
        clauses.push('v.moderation_status = ?'); values.push(filters.moderationStatus);
      }
      if (typeof filters.excludeReportedByUserId === 'string' && filters.excludeReportedByUserId) {
        clauses.push(`NOT EXISTS (
          SELECT 1 FROM moderation_cases AS viewer_report
          WHERE viewer_report.video_id = v.id AND viewer_report.reporter_user_id = ?
        )`);
        values.push(filters.excludeReportedByUserId);
      }
      if (typeof filters.query === 'string' && filters.query.trim()) {
        const query = filters.query.trim();
        const pattern = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        clauses.push(`(
          v.id = ? OR v.title LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR v.creator LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR u.username LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        )`);
        values.push(query, pattern, pattern, pattern, pattern);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const items = database.prepare(`
        SELECT v.*, u.username AS owner_username, u.display_name AS owner_display_name,
          c.name AS category_name
        FROM videos AS v LEFT JOIN users AS u ON u.id = v.user_id
        LEFT JOIN categories AS c ON c.id = v.category_id
        ${where} ORDER BY v.created_at DESC, v.id DESC LIMIT ? OFFSET ?
      `).all(...values, limit, offset);
      const total = database.prepare(`
        SELECT count(*) AS count FROM videos AS v
        LEFT JOIN users AS u ON u.id = v.user_id
        ${where}
      `).get(...values).count;
      return { items, total, limit, offset };
    },

    listDiscussions(filters = {}) {
      const { limit, offset } = page(filters);
      const clauses = [];
      const values = [];
      if (typeof filters.moderationStatus === 'string' && filters.moderationStatus) {
        clauses.push('d.moderation_status = ?'); values.push(filters.moderationStatus);
      }
      if (filters.kind === 'topic') clauses.push('d.parent_id IS NULL AND d.deleted_at IS NULL');
      if (filters.kind === 'reply') clauses.push('d.parent_id IS NOT NULL AND d.deleted_at IS NULL');
      if (filters.kind === 'author_deleted') clauses.push('d.deleted_at IS NOT NULL');
      if (typeof filters.excludeStakeholderUserId === 'string' && filters.excludeStakeholderUserId) {
        clauses.push(`NOT (
          d.user_id = ?
          OR EXISTS (
            SELECT 1 FROM videos AS stake_video
            WHERE stake_video.id = d.video_id AND stake_video.user_id = ?
          )
        )`);
        values.push(filters.excludeStakeholderUserId, filters.excludeStakeholderUserId);
      }
      if (typeof filters.excludeReportedByUserId === 'string' && filters.excludeReportedByUserId) {
        clauses.push(`NOT EXISTS (
          SELECT 1 FROM moderation_cases AS viewer_report
          WHERE viewer_report.discussion_id = d.id AND viewer_report.reporter_user_id = ?
        )`);
        values.push(filters.excludeReportedByUserId);
      }
      if (typeof filters.query === 'string' && filters.query.trim()) {
        const query = filters.query.trim();
        const pattern = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        const numericId = Number(query);
        clauses.push(`(
          d.id = ? OR d.body_markdown LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR d.title LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR v.title LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR u.username LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        )`);
        values.push(Number.isSafeInteger(numericId) ? numericId : -1, pattern, pattern, pattern, pattern, pattern);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const items = database.prepare(`
        SELECT d.*, u.username AS owner_username, u.display_name AS owner_display_name,
          v.title AS video_title,
          (SELECT count(*) FROM discussions AS child WHERE child.parent_id = d.id) AS reply_count
        FROM discussions AS d JOIN videos AS v ON v.id = d.video_id
        LEFT JOIN users AS u ON u.id = d.user_id
        ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?
      `).all(...values, limit, offset);
      const total = database.prepare(`
        SELECT count(*) AS count FROM discussions AS d
        JOIN videos AS v ON v.id = d.video_id
        LEFT JOIN users AS u ON u.id = d.user_id
        ${where}
      `).get(...values).count;
      return { items, total, limit, offset };
    },

    listUsers(filters = {}) {
      const { limit, offset } = page(filters);
      const clauses = ['u.deleted_at IS NULL'];
      const values = [];
      if (typeof filters.role === 'string' && filters.role) { clauses.push('u.role = ?'); values.push(filters.role); }
      if (typeof filters.status === 'string' && filters.status) { clauses.push('u.status = ?'); values.push(filters.status); }
      if (
        typeof filters.excludeReporterConflictUserId === 'string'
        && filters.excludeReporterConflictUserId
      ) {
        clauses.push(`NOT EXISTS (
          SELECT 1
          FROM moderation_cases AS viewer_report
          LEFT JOIN videos AS viewer_report_video ON viewer_report_video.id = viewer_report.video_id
          LEFT JOIN discussions AS viewer_report_discussion
            ON viewer_report_discussion.id = viewer_report.discussion_id
          WHERE viewer_report.reporter_user_id = ?
            AND (
              viewer_report_video.user_id = u.id
              OR viewer_report_discussion.user_id = u.id
            )
        )`);
        values.push(filters.excludeReporterConflictUserId);
      }
      if (typeof filters.query === 'string' && filters.query.trim()) {
        const pattern = `%${filters.query.trim().replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        clauses.push("(u.username LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE)");
        values.push(pattern, pattern);
      }
      const where = `WHERE ${clauses.join(' AND ')}`;
      const items = database.prepare(`
        SELECT u.id, u.username, u.display_name, u.bio,
          u.avatar_storage_name, u.avatar_media_type,
          u.role, u.status, u.governance_version,
          u.updated_at, u.created_at, u.deleted_at,
          (SELECT count(*) FROM videos WHERE user_id = u.id) AS video_count,
          (SELECT count(*) FROM discussions WHERE user_id = u.id) AS discussion_count
        FROM users AS u ${where}
        ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?
      `).all(...values, limit, offset);
      const total = database.prepare(`SELECT count(*) AS count FROM users AS u ${where}`).get(...values).count;
      return { items, total, limit, offset };
    },

    listUserGovernanceHistory(userId) {
      return database.prepare(`
        ${ACTION_SELECT} WHERE a.affected_user_id = ? OR a.user_id = ?
        ORDER BY a.created_at DESC, a.id DESC
      `).all(userId, userId).map(mapAction);
    },

    listAllCategories() {
      return database.prepare(`
        SELECT c.*, p.name AS parent_name,
          (SELECT count(*) FROM videos AS v WHERE v.category_id = c.id) AS video_count
        FROM categories AS c LEFT JOIN categories AS p ON p.id = c.parent_id
        ORDER BY c.sort_order ASC, c.id ASC
      `).all();
    },

    getCategory(id) {
      return database.prepare('SELECT * FROM categories WHERE id = ?').get(id) ?? null;
    },

    getCategoryBySlug(slug) {
      return database.prepare('SELECT * FROM categories WHERE slug = ?').get(slug) ?? null;
    },

    getCategoryByName(name) {
      return database.prepare('SELECT * FROM categories WHERE name = ?').get(name) ?? null;
    },

    insertCategory(values) {
      const result = database.prepare(`
        INSERT INTO categories (slug, name, description, parent_id, sort_order, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(values.slug, values.name, values.description, values.parentId, values.sortOrder, values.createdAt, values.createdAt);
      return store.getCategory(Number(result.lastInsertRowid));
    },

    updateCategory(id, expectedUpdatedAt, values) {
      const changed = database.prepare(`
        UPDATE categories
        SET name = ?, description = ?, parent_id = ?, sort_order = ?, is_active = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(
        values.name, values.description, values.parentId, values.sortOrder,
        values.isActive ? 1 : 0, values.updatedAt, id, expectedUpdatedAt
      ).changes;
      return changed === 1 ? store.getCategory(id) : null;
    },

    listAllTags() {
      return database.prepare(`
        SELECT t.*, target.slug AS merged_into_slug, target.name AS merged_into_name,
          (SELECT count(*) FROM video_tags AS vt WHERE vt.tag_id = t.id) AS video_count
        FROM tags AS t LEFT JOIN tags AS target ON target.id = t.merged_into_id
        ORDER BY t.is_active DESC, t.name COLLATE NOCASE ASC, t.id ASC
      `).all();
    },

    getTag(id) {
      return database.prepare('SELECT * FROM tags WHERE id = ?').get(id) ?? null;
    },

    insertTag(values) {
      const result = database.prepare(`
        INSERT INTO tags (slug, name, created_by, created_at, is_active, updated_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(values.slug, values.name, values.createdBy, values.createdAt, values.createdAt);
      return store.getTag(Number(result.lastInsertRowid));
    },

    updateTag(id, expectedUpdatedAt, values) {
      const changed = database.prepare(`
        UPDATE tags SET name = ?, is_active = ?, updated_at = ?
        WHERE id = ? AND updated_at = ? AND merged_into_id IS NULL
      `).run(values.name, values.isActive ? 1 : 0, values.updatedAt, id, expectedUpdatedAt).changes;
      return changed === 1 ? store.getTag(id) : null;
    },

    mergeTag(sourceId, targetId, expectedUpdatedAt, updatedAt) {
      database.prepare(`
        INSERT OR IGNORE INTO video_tags (video_id, tag_id, sort_order)
        SELECT video_id, ?, sort_order FROM video_tags WHERE tag_id = ?
      `).run(targetId, sourceId);
      database.prepare('DELETE FROM video_tags WHERE tag_id = ?').run(sourceId);
      return database.prepare(`
        UPDATE tags SET is_active = 0, merged_into_id = ?, updated_at = ?
        WHERE id = ? AND updated_at = ? AND merged_into_id IS NULL AND id != ?
      `).run(targetId, updatedAt, sourceId, expectedUpdatedAt, targetId).changes;
    },

    listTasks() {
      const videos = database.prepare(`
          SELECT id, user_id, title, validation_status, validation_started_at, validated_at,
            validation_warning_count, validation_summary, created_at
          FROM videos WHERE validation_status IN ('pending', 'validating', 'rejected', 'validation_failed')
            AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 100
        `).all().map((row) => {
          const validationSummary = jsonObject(row.validation_summary);
          return { ...row, validation_summary: validationSummary, validationSummary };
        });
      const deletions = database.prepare(`
          SELECT * FROM file_deletion_queue
          ORDER BY attempt_count > 0 DESC, next_attempt_at ASC, id ASC LIMIT 100
        `).all();
      return { videos, deletions };
    },

    retryVideoValidation(id, expectedValidatedAt, expectedValidationStartedAt) {
      return database.prepare(`
        UPDATE videos SET validation_status = 'pending', validation_started_at = NULL
        WHERE id = ? AND validation_status = 'validation_failed' AND deleted_at IS NULL
          AND validated_at IS ? AND validation_started_at IS ?
      `).run(id, expectedValidatedAt, expectedValidationStartedAt).changes;
    },

    retryDeletion(id, expectedUpdatedAt, updatedAt) {
      return database.prepare(`
        UPDATE file_deletion_queue SET next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND attempt_count > 0 AND updated_at = ?
      `).run(updatedAt, updatedAt, id, expectedUpdatedAt).changes;
    },

    getDeletionTask(id) {
      return database.prepare('SELECT * FROM file_deletion_queue WHERE id = ?').get(id) ?? null;
    },

    listAudit(filters = {}) {
      const { limit, offset } = page(filters, 50);
      const clauses = [];
      const values = [];
      if (typeof filters.excludeRelatedUserId === 'string' && filters.excludeRelatedUserId) {
        clauses.push(`NOT (
          (e.object_type = 'moderation_case' AND EXISTS (
            SELECT 1 FROM moderation_cases AS related_case
            LEFT JOIN videos AS related_case_video ON related_case_video.id = related_case.video_id
            LEFT JOIN discussions AS related_case_discussion ON related_case_discussion.id = related_case.discussion_id
            LEFT JOIN videos AS related_case_discussion_video
              ON related_case_discussion_video.id = related_case_discussion.video_id
            WHERE CAST(related_case.id AS TEXT) = e.object_id
              AND (
                related_case_video.user_id = ?
                OR related_case_discussion.user_id = ?
                OR related_case_discussion_video.user_id = ?
                OR EXISTS (
                  SELECT 1 FROM moderation_cases AS viewer_related_case
                  WHERE viewer_related_case.reporter_user_id = ?
                    AND (
                      (related_case.video_id IS NOT NULL
                        AND viewer_related_case.video_id = related_case.video_id)
                      OR (related_case.discussion_id IS NOT NULL
                        AND viewer_related_case.discussion_id = related_case.discussion_id)
                    )
                )
              )
          ))
          OR (e.object_type = 'video' AND EXISTS (
            SELECT 1 FROM videos AS related_video
            WHERE related_video.id = e.object_id
              AND (
                related_video.user_id = ?
                OR EXISTS (
                  SELECT 1 FROM moderation_cases AS reported_video_case
                  WHERE reported_video_case.video_id = related_video.id
                    AND reported_video_case.reporter_user_id = ?
                )
              )
          ))
          OR (e.object_type = 'discussion' AND EXISTS (
            SELECT 1
            FROM discussions AS related_discussion
            JOIN videos AS related_discussion_video
              ON related_discussion_video.id = related_discussion.video_id
            WHERE CAST(related_discussion.id AS TEXT) = e.object_id
              AND (
                related_discussion.user_id = ?
                OR related_discussion_video.user_id = ?
                OR EXISTS (
                  SELECT 1 FROM moderation_cases AS reported_discussion_case
                  WHERE reported_discussion_case.discussion_id = related_discussion.id
                    AND reported_discussion_case.reporter_user_id = ?
                )
              )
          ))
          OR (e.object_type = 'appeal' AND EXISTS (
            SELECT 1 FROM appeals AS related_appeal
            JOIN moderation_actions AS related_appeal_action
              ON related_appeal_action.id = related_appeal.moderation_action_id
            WHERE CAST(related_appeal.id AS TEXT) = e.object_id
              AND (
                related_appeal.appellant_user_id = ?
                OR EXISTS (
                  SELECT 1
                  FROM discussions AS related_appeal_discussion
                  JOIN videos AS related_appeal_discussion_video
                    ON related_appeal_discussion_video.id = related_appeal_discussion.video_id
                  WHERE related_appeal_discussion.id = related_appeal_action.discussion_id
                    AND related_appeal_discussion_video.user_id = ?
                )
                OR EXISTS (
                  SELECT 1
                  FROM moderation_cases AS viewer_appeal_report
                  LEFT JOIN videos AS viewer_appeal_report_video
                    ON viewer_appeal_report_video.id = viewer_appeal_report.video_id
                  LEFT JOIN discussions AS viewer_appeal_report_discussion
                    ON viewer_appeal_report_discussion.id = viewer_appeal_report.discussion_id
                  WHERE viewer_appeal_report.reporter_user_id = ?
                    AND (
                      (related_appeal_action.video_id IS NOT NULL
                        AND viewer_appeal_report.video_id = related_appeal_action.video_id)
                      OR (related_appeal_action.discussion_id IS NOT NULL
                        AND viewer_appeal_report.discussion_id = related_appeal_action.discussion_id)
                      OR (related_appeal_action.user_id IS NOT NULL AND (
                        viewer_appeal_report_video.user_id = related_appeal_action.user_id
                        OR viewer_appeal_report_discussion.user_id = related_appeal_action.user_id
                      ))
                    )
                )
              )
          ))
          OR (e.object_type = 'user' AND (
            e.object_id = ?
            OR EXISTS (
              SELECT 1
              FROM moderation_cases AS viewer_user_report
              LEFT JOIN videos AS viewer_user_report_video
                ON viewer_user_report_video.id = viewer_user_report.video_id
              LEFT JOIN discussions AS viewer_user_report_discussion
                ON viewer_user_report_discussion.id = viewer_user_report.discussion_id
              WHERE viewer_user_report.reporter_user_id = ?
                AND (
                  viewer_user_report_video.user_id = e.object_id
                  OR viewer_user_report_discussion.user_id = e.object_id
                )
            )
          ))
        )`);
        values.push(
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId,
          filters.excludeRelatedUserId
        );
      }
      if (typeof filters.actorUserId === 'string' && filters.actorUserId) { clauses.push('e.actor_user_id = ?'); values.push(filters.actorUserId); }
      if (typeof filters.actor === 'string' && filters.actor.trim()) {
        const actor = filters.actor.trim();
        const pattern = `%${actor.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        clauses.push(`(
          e.actor_user_id = ? OR e.actor_label LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR u.username LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        )`);
        values.push(actor, pattern, pattern, pattern);
      }
      if (typeof filters.action === 'string' && filters.action) { clauses.push('e.action = ?'); values.push(filters.action); }
      if (typeof filters.objectType === 'string' && filters.objectType) { clauses.push('e.object_type = ?'); values.push(filters.objectType); }
      if (typeof filters.objectId === 'string' && filters.objectId) { clauses.push('e.object_id = ?'); values.push(filters.objectId); }
      if (typeof filters.from === 'string' && filters.from) { clauses.push('e.created_at >= ?'); values.push(filters.from); }
      if (typeof filters.to === 'string' && filters.to) { clauses.push('e.created_at <= ?'); values.push(filters.to); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const items = database.prepare(`
        SELECT e.*, u.username AS actor_username, u.display_name AS actor_name
        FROM audit_events AS e LEFT JOIN users AS u ON u.id = e.actor_user_id
        ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map((row) => ({
        id: row.id, actorUserId: row.actor_user_id ?? null,
        actorName: row.actor_name ?? row.actor_label ?? '系统', actorUsername: row.actor_username ?? null,
        requestId: row.request_id, action: row.action, objectType: row.object_type,
        objectId: row.object_id, before: jsonObject(row.before_json), after: jsonObject(row.after_json),
        metadata: jsonObject(row.metadata_json), createdAt: row.created_at
      }));
      const total = database.prepare(`
        SELECT count(*) AS count
        FROM audit_events AS e LEFT JOIN users AS u ON u.id = e.actor_user_id
        ${where}
      `).get(...values).count;
      return { items, total, limit, offset };
    },

    dashboard(options = {}) {
      const includeAdministrative = options.includeAdministrative !== false;
      const viewerUserId = typeof options.viewerUserId === 'string' ? options.viewerUserId : null;
      const tasks = store.listTasks();
      const failedValidations = tasks.videos.filter((video) => video.validation_status === 'validation_failed').slice(0, 6);
      const failedDeletions = includeAdministrative
        ? tasks.deletions.filter((task) => task.attempt_count > 0).slice(0, 6)
        : [];
      const recentVideos = store.listVideos({
        limit: 8, excludeReportedByUserId: viewerUserId
      }).items.map((video) => ({ ...video, type: 'video' }));
      const recentDiscussions = store.listDiscussions({
        limit: 8,
        excludeReportedByUserId: viewerUserId,
        excludeStakeholderUserId: viewerUserId
      }).items.map((discussion) => ({ ...discussion, type: 'discussion' }));
      const recentContent = [...recentVideos, ...recentDiscussions]
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id)))
        .slice(0, 8);
      const pendingCaseResult = store.listCases({
        status: 'pending', limit: 8,
        excludeTargetAuthorUserId: viewerUserId,
        excludeReporterUserId: viewerUserId
      });
      const pendingCases = pendingCaseResult.items;
      const pendingAppealResult = store.listAppeals({
        status: 'unresolved', limit: 1,
        includeAccountActions: includeAdministrative,
        excludeAppellantUserId: viewerUserId,
        excludeTargetStakeUserId: viewerUserId,
        excludeActionCaseReporterUserId: viewerUserId,
        excludeAffectedReporterUserId: viewerUserId
      });
      const recentActions = store.listRecentActions(8, {
        includeUserActions: includeAdministrative,
        excludeAffectedUserId: viewerUserId,
        excludeCaseReporterUserId: viewerUserId,
        excludeAffectedReporterUserId: viewerUserId
      });
      return {
        openCaseCount: pendingCaseResult.total,
        pendingAppealCount: pendingAppealResult.total,
        validationFailedCount: database.prepare("SELECT count(*) AS count FROM videos WHERE validation_status = 'validation_failed' AND deleted_at IS NULL").get().count,
        deletionFailedCount: database.prepare('SELECT count(*) AS count FROM file_deletion_queue WHERE attempt_count > 0').get().count,
        pendingCases,
        failedValidations,
        failedDeletions,
        recentContent,
        recentActions,
        // Keep the compact aliases used by early V1 templates and integrations.
        cases: pendingCases,
        videos: recentVideos,
        actions: recentActions
      };
    }
  };

  return store;
}
