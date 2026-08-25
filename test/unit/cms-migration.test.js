import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { CURRENT_SCHEMA_VERSION, openDatabase } from '../../src/database.js';

const LEGACY_CREATED_AT = '2026-08-24T00:00:00.000Z';
const CASE_DESCRIPTION = '这是一段用于验证治理案件数据约束的详细说明文字。';
const APPEAL_REASON = '这是一段用于验证单次申诉唯一性的完整申诉理由。';

function createLegacyV4Database(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      BEGIN IMMEDIATE;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(username) BETWEEN 3 AND 32),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
        password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 512),
        created_at TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'administrator')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
        bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 500),
        avatar_storage_name TEXT,
        avatar_media_type TEXT CHECK (avatar_media_type IS NULL OR avatar_media_type IN ('image/jpeg', 'image/png', 'image/webp')),
        updated_at TEXT,
        deleted_at TEXT
      ) STRICT;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token_hash TEXT NOT NULL CHECK (length(csrf_token_hash) = 64),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 48),
        name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 40),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 240),
        parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        creator TEXT NOT NULL CHECK (length(creator) BETWEEN 1 AND 80),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
        license_code TEXT NOT NULL CHECK (license_code IN ('CC0-1.0', 'CC-BY-4.0', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-ND-4.0')),
        storage_name TEXT NOT NULL UNIQUE,
        original_filename TEXT NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('video/mp4', 'video/webm')),
        byte_size INTEGER NOT NULL CHECK (byte_size > 0),
        container TEXT NOT NULL CHECK (container IN ('mp4', 'webm')),
        video_codec TEXT NOT NULL CHECK (video_codec IN ('unknown', 'avc', 'hevc', 'vp9', 'av1')),
        audio_codec TEXT CHECK (audio_codec IS NULL OR audio_codec IN ('unknown', 'aac', 'opus')),
        playback_strategy TEXT NOT NULL CHECK (playback_strategy IN ('native', 'native-hevc')),
        validation_status TEXT NOT NULL CHECK (validation_status IN ('pending', 'validating', 'ready', 'ready_with_warnings', 'rejected', 'validation_failed')),
        sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
        duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
        width INTEGER CHECK (width IS NULL OR width > 0),
        height INTEGER CHECK (height IS NULL OR height > 0),
        frame_rate REAL CHECK (frame_rate IS NULL OR frame_rate > 0),
        validation_warning_count INTEGER NOT NULL DEFAULT 0 CHECK (validation_warning_count >= 0),
        validation_summary TEXT NOT NULL DEFAULT '{}',
        validation_started_at TEXT,
        validated_at TEXT,
        source_container TEXT,
        source_video_codec TEXT,
        source_audio_codec TEXT,
        ingest_operation TEXT NOT NULL DEFAULT 'unknown' CHECK (ingest_operation IN ('unknown', 'direct', 'remux')),
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        cover_storage_name TEXT,
        cover_media_type TEXT CHECK (cover_media_type IS NULL OR cover_media_type IN ('image/jpeg', 'image/png', 'image/webp')),
        cover_source TEXT CHECK (cover_source IS NULL OR cover_source IN ('uploaded', 'generated')),
        visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted', 'private')),
        moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK (moderation_status IN ('visible', 'hidden', 'removed')),
        withdrawn_at TEXT,
        deleted_at TEXT,
        archive_public INTEGER NOT NULL DEFAULT 0 CHECK (archive_public IN (0, 1))
      ) STRICT;
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(slug) BETWEEN 1 AND 48),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE video_tags (
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (video_id, tag_id)
      ) STRICT;
      CREATE TABLE discussions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL,
        body_markdown TEXT NOT NULL CHECK (
          (deleted_at IS NULL AND length(body_markdown) BETWEEN 1 AND 5000)
          OR (deleted_at IS NOT NULL AND body_markdown = '')
        ),
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        title TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120),
        parent_id INTEGER REFERENCES discussions(id) ON DELETE RESTRICT,
        edited_at TEXT,
        deleted_at TEXT,
        edit_count INTEGER NOT NULL DEFAULT 0 CHECK (edit_count >= 0)
      ) STRICT;
      CREATE TABLE video_votes (
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        value INTEGER NOT NULL CHECK (value IN (-1, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (video_id, user_id)
      ) STRICT;
      CREATE TABLE discussion_votes (
        discussion_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        value INTEGER NOT NULL CHECK (value IN (-1, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (discussion_id, user_id)
      ) STRICT;
      CREATE TABLE notification_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        reply INTEGER NOT NULL DEFAULT 1 CHECK (reply IN (0, 1)),
        video_vote INTEGER NOT NULL DEFAULT 1 CHECK (video_vote IN (0, 1)),
        system INTEGER NOT NULL DEFAULT 1 CHECK (system IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('reply', 'video_upvote', 'video_downvote', 'system')),
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
        discussion_id INTEGER REFERENCES discussions(id) ON DELETE SET NULL,
        event_count INTEGER NOT NULL DEFAULT 1 CHECK (event_count > 0),
        is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
        system_title TEXT CHECK (system_title IS NULL OR length(system_title) BETWEEN 1 AND 120),
        system_body TEXT CHECK (system_body IS NULL OR length(system_body) <= 1000),
        system_link TEXT CHECK (system_link IS NULL OR length(system_link) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        read_at TEXT
      ) STRICT;
      CREATE TABLE notification_vote_actors (
        notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        value INTEGER NOT NULL CHECK (value IN (-1, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (notification_id, actor_user_id)
      ) STRICT;
      CREATE TABLE file_deletion_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('video', 'cover', 'avatar')),
        storage_name TEXT NOT NULL CHECK (length(storage_name) BETWEEN 1 AND 255),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 2000),
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (kind, storage_name)
      ) STRICT;

      CREATE INDEX idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
      CREATE INDEX idx_users_public_username ON users(username) WHERE status = 'active' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX idx_users_avatar_storage_name ON users(avatar_storage_name) WHERE avatar_storage_name IS NOT NULL;
      CREATE INDEX idx_categories_parent_sort ON categories(parent_id, sort_order, id);
      CREATE INDEX idx_videos_created_at_id ON videos(created_at DESC, id DESC);
      CREATE INDEX idx_videos_user_id ON videos(user_id);
      CREATE INDEX idx_videos_validation_status_created_at ON videos(validation_status, created_at ASC, id ASC);
      CREATE INDEX idx_videos_category_created_at ON videos(category_id, created_at DESC, id DESC);
      CREATE UNIQUE INDEX idx_videos_cover_storage_name ON videos(cover_storage_name) WHERE cover_storage_name IS NOT NULL;
      CREATE INDEX idx_videos_user_created_at ON videos(user_id, created_at DESC, id DESC);
      CREATE INDEX idx_videos_public_user_created_at ON videos(user_id, created_at DESC, id DESC)
        WHERE visibility = 'public' AND moderation_status = 'visible' AND withdrawn_at IS NULL AND deleted_at IS NULL;
      CREATE INDEX idx_video_tags_tag_video ON video_tags(tag_id, video_id);
      CREATE INDEX idx_discussions_video_created_at_id ON discussions(video_id, created_at ASC, id ASC);
      CREATE INDEX idx_discussions_user_id ON discussions(user_id);
      CREATE INDEX idx_discussions_user_created_at ON discussions(user_id, created_at DESC, id DESC);
      CREATE INDEX idx_discussions_parent_created_at ON discussions(parent_id, created_at ASC, id ASC);
      CREATE INDEX idx_video_votes_video_value ON video_votes(video_id, value);
      CREATE INDEX idx_discussion_votes_discussion_value ON discussion_votes(discussion_id, value);
      CREATE INDEX idx_notifications_recipient_created_at ON notifications(recipient_user_id, created_at DESC, id DESC);
      CREATE INDEX idx_notifications_recipient_unread ON notifications(recipient_user_id, is_read, id DESC);
      CREATE UNIQUE INDEX idx_notifications_reply_discussion ON notifications(discussion_id)
        WHERE type = 'reply' AND discussion_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_notifications_unread_video_vote ON notifications(recipient_user_id, type, video_id)
        WHERE is_read = 0 AND type IN ('video_upvote', 'video_downvote') AND video_id IS NOT NULL;
      CREATE INDEX idx_notification_vote_actors_actor_value ON notification_vote_actors(actor_user_id, value, notification_id);
      CREATE INDEX idx_file_deletion_queue_updated_at ON file_deletion_queue(updated_at ASC, id ASC);
      CREATE INDEX idx_file_deletion_queue_next_attempt_at ON file_deletion_queue(next_attempt_at ASC, id ASC);

      INSERT INTO users (
        id, username, display_name, password_hash, created_at,
        role, status, bio, updated_at
      ) VALUES (
        'legacy-owner', 'legacy_owner', '旧版作者', 'legacy-password-hash', '${LEGACY_CREATED_AT}',
        'moderator', 'active', '迁移前的简介', '${LEGACY_CREATED_AT}'
      );
      INSERT INTO sessions (
        token_hash, user_id, csrf_token_hash, created_at, expires_at
      ) VALUES (
        '${'a'.repeat(64)}', 'legacy-owner', '${'b'.repeat(64)}',
        '${LEGACY_CREATED_AT}', '2026-09-24T00:00:00.000Z'
      );
      INSERT INTO categories (
        id, slug, name, description, sort_order, created_at, updated_at
      ) VALUES (
        1, 'legacy-category', '旧版分类', '迁移保留分类', 10,
        '${LEGACY_CREATED_AT}', '${LEGACY_CREATED_AT}'
      );
      INSERT INTO videos (
        id, title, creator, description, license_code, storage_name, original_filename,
        media_type, byte_size, container, video_codec, playback_strategy,
        validation_status, validation_summary, ingest_operation, user_id, created_at,
        category_id, visibility, moderation_status, archive_public
      ) VALUES (
        'legacy-video', '旧版视频', '旧版创作者', '迁移前的视频描述', 'CC-BY-4.0',
        'legacy-video.mp4', 'legacy-video.mp4', 'video/mp4', 2048,
        'mp4', 'avc', 'native', 'ready', '{}', 'direct', 'legacy-owner',
        '2026-08-24T00:01:00.000Z', 1, 'public', 'visible', 0
      );
      INSERT INTO tags (slug, name, created_by, created_at)
      VALUES ('legacy-tag', '旧版标签', 'legacy-owner', '2026-08-24T00:01:30.000Z');
      INSERT INTO video_tags (video_id, tag_id, sort_order)
      VALUES ('legacy-video', 1, 0);
      INSERT INTO discussions (
        video_id, nickname, body_markdown, user_id, created_at, title
      ) VALUES (
        'legacy-video', '旧版作者', '迁移前的讨论正文', 'legacy-owner',
        '2026-08-24T00:02:00.000Z', '迁移前的讨论标题'
      );
      INSERT INTO video_votes (video_id, user_id, value, created_at, updated_at)
      VALUES ('legacy-video', 'legacy-owner', 1, '2026-08-24T00:03:00.000Z', '2026-08-24T00:03:00.000Z');
      INSERT INTO discussion_votes (discussion_id, user_id, value, created_at, updated_at)
      VALUES (1, 'legacy-owner', -1, '2026-08-24T00:03:30.000Z', '2026-08-24T00:03:30.000Z');
      INSERT INTO notification_preferences (user_id, reply, video_vote, system, updated_at)
      VALUES ('legacy-owner', 0, 1, 1, '2026-08-24T00:04:00.000Z');
      INSERT INTO notifications (
        recipient_user_id, type, event_count, is_read, system_title, system_body,
        created_at, updated_at
      ) VALUES (
        'legacy-owner', 'system', 1, 0, '旧版系统通知', '迁移时不应丢失',
        '2026-08-24T00:04:30.000Z', '2026-08-24T00:04:30.000Z'
      );
      INSERT INTO file_deletion_queue (
        kind, storage_name, attempt_count, last_error, next_attempt_at, created_at, updated_at
      ) VALUES (
        'cover', 'legacy-orphan.webp', 1, '旧版失败记录',
        '2026-08-24T00:05:00.000Z', '2026-08-24T00:04:45.000Z', '2026-08-24T00:04:45.000Z'
      );

      PRAGMA user_version = 4;
      COMMIT;
    `);
  } finally {
    database.close();
  }
}

function video(id, userId, createdAt = '2026-08-25T00:03:00.000Z') {
  return {
    id,
    title: `标题 ${id}`,
    creator: '测试创作者',
    description: '',
    licenseCode: 'CC-BY-4.0',
    storageName: `${id}.mp4`,
    originalFilename: `${id}.mp4`,
    mediaType: 'video/mp4',
    byteSize: 2048,
    container: 'mp4',
    videoCodec: 'avc',
    audioCodec: null,
    playbackStrategy: 'native',
    validationStatus: 'ready',
    validationSummary: {},
    ingestOperation: 'direct',
    userId,
    visibility: 'public',
    moderationStatus: 'visible',
    createdAt
  };
}

function seedGovernanceTargets(database) {
  const owner = database.createUser({
    id: 'cms-owner', username: 'cms_owner', displayName: '内容作者',
    passwordHash: 'owner-hash', createdAt: '2026-08-25T00:00:00.000Z'
  });
  const reporter = database.createUser({
    id: 'cms-reporter', username: 'cms_reporter', displayName: '举报用户',
    passwordHash: 'reporter-hash', createdAt: '2026-08-25T00:01:00.000Z'
  });
  const administrator = database.createUser({
    id: 'cms-admin', username: 'cms_admin', displayName: '管理员',
    passwordHash: 'admin-hash', createdAt: '2026-08-25T00:02:00.000Z'
  });
  database.raw.prepare("UPDATE users SET role = 'administrator' WHERE id = ?").run(administrator.id);
  const storedVideo = database.insertVideo(video('cms-video', owner.id));
  const discussion = database.insertDiscussion({
    videoId: storedVideo.id,
    userId: owner.id,
    nickname: owner.displayName,
    title: '待审核讨论',
    bodyMarkdown: '这是待审核讨论正文。',
    createdAt: '2026-08-25T00:04:00.000Z'
  });
  const session = database.createSession({
    tokenHash: 'c'.repeat(64),
    userId: administrator.id,
    csrfTokenHash: 'd'.repeat(64),
    createdAt: '2026-08-25T00:05:00.000Z',
    expiresAt: '2026-09-25T00:05:00.000Z'
  });
  return { owner, reporter, administrator, video: storedVideo, discussion, session };
}

function insertCase(database, values = {}) {
  const result = database.prepare(`
    INSERT INTO moderation_cases (
      source, reporter_user_id, opened_by_user_id, video_id, discussion_id,
      reason_category, description, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.source ?? 'investigation',
    values.reporterUserId ?? null,
    values.openedByUserId ?? null,
    values.videoId ?? null,
    values.discussionId ?? null,
    values.reasonCategory ?? 'other',
    values.description ?? CASE_DESCRIPTION,
    values.createdAt ?? '2026-08-25T00:06:00.000Z',
    values.updatedAt ?? values.createdAt ?? '2026-08-25T00:06:00.000Z'
  );
  return Number(result.lastInsertRowid);
}

function insertAction(database, values) {
  const result = database.prepare(`
    INSERT INTO moderation_actions (
      case_id, actor_user_id, affected_user_id, video_id, discussion_id, user_id,
      action, public_reason, internal_note, before_json, after_json,
      before_version, after_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.caseId ?? null,
    values.actorUserId,
    values.affectedUserId ?? null,
    values.videoId ?? null,
    values.discussionId ?? null,
    values.userId ?? null,
    values.action,
    values.publicReason ?? '违反平台规则',
    values.internalNote ?? '供工作人员复核的内部说明',
    JSON.stringify(values.before ?? { moderationStatus: 'visible' }),
    JSON.stringify(values.after ?? { moderationStatus: 'hidden' }),
    values.beforeVersion ?? 0,
    values.afterVersion ?? 1,
    values.createdAt ?? '2026-08-25T00:07:00.000Z'
  );
  return Number(result.lastInsertRowid);
}

test('真实 schema v4 增量迁移到 v5 保留数据并补全审核默认值', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cms-v4-migration-'));
  const databasePath = path.join(directory, 'legacy-v4.sqlite');
  let database;
  try {
    createLegacyV4Database(databasePath);
    const legacy = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(
      legacy.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'moderation_cases'").get().count,
      0
    );
    assert.equal(
      legacy.prepare("SELECT count(*) AS count FROM pragma_table_info('discussions') WHERE name = 'moderation_status'").get().count,
      0
    );
    legacy.close();

    database = openDatabase(databasePath);
    assert.equal(CURRENT_SCHEMA_VERSION, 5);
    assert.equal(database.getSchemaVersion(), CURRENT_SCHEMA_VERSION);

    const migratedUser = database.getUserById('legacy-owner');
    assert.equal(migratedUser.displayName, '旧版作者');
    assert.equal(migratedUser.bio, '迁移前的简介');
    assert.equal(migratedUser.role, 'moderator');
    assert.equal(migratedUser.governanceVersion, 0);

    const migratedSession = database.findSessionByTokenHash(
      'a'.repeat(64),
      '2026-08-25T00:00:00.000Z'
    );
    assert.equal(migratedSession.userId, migratedUser.id);
    assert.equal(migratedSession.cmsVerifiedAt, null);

    const migratedVideo = database.getVideo('legacy-video', migratedUser.id);
    assert.equal(migratedVideo.title, '旧版视频');
    assert.equal(migratedVideo.description, '迁移前的视频描述');
    assert.equal(migratedVideo.categorySlug, 'legacy-category');
    assert.equal(migratedVideo.moderationStatus, 'visible');
    assert.equal(migratedVideo.moderationVersion, 0);
    assert.deepEqual(migratedVideo.tags, [{ slug: 'legacy-tag', name: '旧版标签' }]);
    assert.equal(migratedVideo.viewerVote, 1);

    const migratedDiscussion = database.getDiscussion(1, migratedUser.id);
    assert.equal(migratedDiscussion.title, '迁移前的讨论标题');
    assert.equal(migratedDiscussion.bodyMarkdown, '迁移前的讨论正文');
    assert.equal(migratedDiscussion.viewerVote, -1);
    assert.equal(migratedDiscussion.moderationStatus, 'visible');
    assert.equal(migratedDiscussion.moderationVersion, 0);

    assert.deepEqual({ ...database.raw.prepare(`
      SELECT is_active, merged_into_id, updated_at FROM tags WHERE slug = 'legacy-tag'
    `).get() }, {
      is_active: 1,
      merged_into_id: null,
      updated_at: '2026-08-24T00:01:30.000Z'
    });
    assert.deepEqual(database.getNotificationPreferences(migratedUser.id), {
      userId: migratedUser.id,
      reply: false,
      videoVote: true,
      system: true,
      updatedAt: '2026-08-24T00:04:00.000Z'
    });
    assert.equal(database.listNotifications(migratedUser.id).items[0].systemTitle, '旧版系统通知');
    assert.equal(database.listPendingFileDeletions()[0].storageName, 'legacy-orphan.webp');

    const governanceTables = database.raw.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'moderation_cases', 'case_notes', 'moderation_actions',
        'appeals', 'audit_events', 'cms_media_access_grants'
      ) ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(governanceTables, [
      'appeals',
      'audit_events',
      'case_notes',
      'cms_media_access_grants',
      'moderation_actions',
      'moderation_cases'
    ]);
    assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);

    database.close();
    database = openDatabase(databasePath);
    assert.equal(database.getSchemaVersion(), 5);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM users').get().count, 1);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM videos').get().count, 1);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM discussions').get().count, 1);
    assert.equal(database.raw.prepare('SELECT count(*) AS count FROM tags').get().count, 1);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('v5 严格约束案件目标、未结重复举报、申诉唯一性和新表外键', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cms-constraints-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'constraints.sqlite'));
    const fixture = seedGovernanceTargets(database);
    const raw = database.raw;

    assert.throws(() => insertCase(raw, {
      openedByUserId: fixture.administrator.id
    }), /CHECK constraint failed/);
    assert.throws(() => insertCase(raw, {
      openedByUserId: fixture.administrator.id,
      videoId: fixture.video.id,
      discussionId: fixture.discussion.id
    }), /CHECK constraint failed/);
    assert.throws(() => insertCase(raw, {
      openedByUserId: fixture.administrator.id,
      videoId: 'missing-video'
    }), /FOREIGN KEY constraint failed/);

    const videoCaseId = insertCase(raw, {
      source: 'report',
      reporterUserId: fixture.reporter.id,
      videoId: fixture.video.id
    });
    assert.throws(() => insertCase(raw, {
      source: 'report',
      reporterUserId: fixture.reporter.id,
      videoId: fixture.video.id,
      createdAt: '2026-08-25T00:06:01.000Z'
    }), /UNIQUE constraint failed/);
    const discussionCaseId = insertCase(raw, {
      source: 'report',
      reporterUserId: fixture.reporter.id,
      discussionId: fixture.discussion.id,
      createdAt: '2026-08-25T00:06:02.000Z'
    });
    assert.ok(videoCaseId > 0);
    assert.ok(discussionCaseId > videoCaseId);

    assert.throws(() => raw.prepare(`
      INSERT INTO case_notes (case_id, author_user_id, body, created_at)
      VALUES (999999, ?, '不存在案件的备注', ?)
    `).run(fixture.administrator.id, '2026-08-25T00:07:00.000Z'), /FOREIGN KEY constraint failed/);
    assert.throws(() => insertAction(raw, {
      actorUserId: fixture.administrator.id,
      affectedUserId: fixture.owner.id,
      userId: 'missing-user',
      action: 'user_suspend'
    }), /FOREIGN KEY constraint failed/);

    const actionId = insertAction(raw, {
      caseId: videoCaseId,
      actorUserId: fixture.administrator.id,
      affectedUserId: fixture.owner.id,
      videoId: fixture.video.id,
      action: 'video_hide'
    });
    const appealInsert = raw.prepare(`
      INSERT INTO appeals (
        moderation_action_id, appellant_user_id, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    appealInsert.run(
      actionId,
      fixture.owner.id,
      APPEAL_REASON,
      '2026-08-25T00:08:00.000Z',
      '2026-08-25T00:08:00.000Z'
    );
    assert.throws(() => appealInsert.run(
      actionId,
      fixture.owner.id,
      APPEAL_REASON,
      '2026-08-25T00:08:01.000Z',
      '2026-08-25T00:08:01.000Z'
    ), /UNIQUE constraint failed/);
    assert.throws(() => appealInsert.run(
      999999,
      fixture.owner.id,
      APPEAL_REASON,
      '2026-08-25T00:08:02.000Z',
      '2026-08-25T00:08:02.000Z'
    ), /FOREIGN KEY constraint failed/);

    assert.throws(() => raw.prepare(`
      INSERT INTO audit_events (
        actor_user_id, actor_label, request_id, action, object_type, object_id, created_at
      ) VALUES ('missing-actor', 'fallback', 'request-missing-actor', 'test', 'video', ?, ?)
    `).run(fixture.video.id, '2026-08-25T00:09:00.000Z'), /FOREIGN KEY constraint failed/);
    assert.throws(() => raw.prepare(`
      INSERT INTO cms_media_access_grants (
        session_token_hash, case_id, video_id, granted_by_user_id,
        reason, granted_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'e'.repeat(64),
      videoCaseId,
      fixture.video.id,
      fixture.administrator.id,
      '查看举报证据',
      '2026-08-25T00:10:00.000Z',
      '2026-08-25T00:25:00.000Z'
    ), /FOREIGN KEY constraint failed/);

    raw.prepare(`
      INSERT INTO cms_media_access_grants (
        session_token_hash, case_id, video_id, granted_by_user_id,
        reason, granted_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      fixture.session.tokenHash,
      videoCaseId,
      fixture.video.id,
      fixture.administrator.id,
      '查看举报证据',
      '2026-08-25T00:10:00.000Z',
      '2026-08-25T00:25:00.000Z'
    );

    const tagId = Number(raw.prepare(`
      INSERT INTO tags (slug, name, created_by, created_at, updated_at)
      VALUES ('constraint-tag', '约束标签', ?, ?, ?)
    `).run(
      fixture.administrator.id,
      '2026-08-25T00:11:00.000Z',
      '2026-08-25T00:11:00.000Z'
    ).lastInsertRowid);
    assert.throws(() => raw.prepare(`
      UPDATE tags SET merged_into_id = 999999 WHERE id = ?
    `).run(tagId), /FOREIGN KEY constraint failed/);
    assert.throws(() => raw.prepare(`
      UPDATE tags SET merged_into_id = id WHERE id = ?
    `).run(tagId), /tag cannot merge into itself/);

    const expectedForeignKeys = {
      moderation_cases: ['discussions', 'users', 'videos'],
      case_notes: ['moderation_cases', 'users'],
      moderation_actions: ['discussions', 'moderation_actions', 'moderation_cases', 'users', 'videos'],
      appeals: ['moderation_actions', 'users'],
      audit_events: ['users'],
      cms_media_access_grants: ['moderation_cases', 'sessions', 'users', 'videos'],
      tags: ['tags', 'users']
    };
    for (const [table, expectedTargets] of Object.entries(expectedForeignKeys)) {
      const targets = [...new Set(raw.prepare(`PRAGMA foreign_key_list('${table}')`)
        .all().map((entry) => entry.table))].sort();
      assert.deepEqual(targets, expectedTargets, `${table} 外键目标完整`);
    }
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('v5 案件备注、审核动作和审计事件只能追加', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tongjian-cms-append-only-'));
  let database;
  try {
    database = openDatabase(path.join(directory, 'append-only.sqlite'));
    const fixture = seedGovernanceTargets(database);
    const raw = database.raw;
    const caseId = insertCase(raw, {
      openedByUserId: fixture.administrator.id,
      videoId: fixture.video.id
    });
    const noteId = Number(raw.prepare(`
      INSERT INTO case_notes (case_id, author_user_id, body, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      caseId,
      fixture.administrator.id,
      '只追加的内部备注',
      '2026-08-25T00:07:00.000Z'
    ).lastInsertRowid);
    const actionId = insertAction(raw, {
      caseId,
      actorUserId: fixture.administrator.id,
      affectedUserId: fixture.owner.id,
      videoId: fixture.video.id,
      action: 'video_hide'
    });
    const auditId = Number(raw.prepare(`
      INSERT INTO audit_events (
        actor_user_id, request_id, action, object_type, object_id,
        before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fixture.administrator.id,
      'request-append-only',
      'video.hide',
      'video',
      fixture.video.id,
      '{"moderationStatus":"visible"}',
      '{"moderationStatus":"hidden"}',
      '{}',
      '2026-08-25T00:07:30.000Z'
    ).lastInsertRowid);

    const assertions = [
      ['case_notes', noteId, 'body', '篡改备注'],
      ['moderation_actions', actionId, 'public_reason', '篡改理由'],
      ['audit_events', auditId, 'action', 'tampered.action']
    ];
    for (const [table, id, column, value] of assertions) {
      assert.throws(
        () => raw.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, id),
        /append-only/
      );
      assert.throws(
        () => raw.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id),
        /append-only/
      );
      assert.equal(raw.prepare(`SELECT count(*) AS count FROM ${table} WHERE id = ?`).get(id).count, 1);
    }
    assert.equal(raw.prepare('SELECT body FROM case_notes WHERE id = ?').get(noteId).body, '只追加的内部备注');
    assert.equal(
      raw.prepare('SELECT public_reason FROM moderation_actions WHERE id = ?').get(actionId).public_reason,
      '违反平台规则'
    );
    assert.equal(raw.prepare('SELECT action FROM audit_events WHERE id = ?').get(auditId).action, 'video.hide');
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
