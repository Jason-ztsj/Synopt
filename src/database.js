import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGovernanceStore } from './governance-store.js';

export const CURRENT_SCHEMA_VERSION = 5;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const FILE_DELETION_KINDS = new Set(['video', 'cover', 'avatar']);
const MAX_FILE_DELETION_ERROR_LENGTH = 2000;
const FILE_DELETION_INITIAL_BACKOFF_MS = 5_000;
const FILE_DELETION_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DEFAULT_GOVERNANCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function requireSha256Hash(value, name) {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
    throw new TypeError(`${name} 必须是 SHA-256 十六进制摘要`);
  }
  return value;
}

function mapVideo(row) {
  if (!row) return null;
  const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
  return {
    id: row.id,
    title: row.title,
    creator: row.creator,
    description: row.description,
    licenseCode: row.license_code,
    storageName: row.storage_name,
    originalFilename: row.original_filename,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    container: row.container ?? (row.media_type === 'video/webm' ? 'webm' : 'mp4'),
    videoCodec: row.video_codec ?? 'unknown',
    audioCodec: row.audio_codec ?? null,
    playbackStrategy: row.playback_strategy ?? 'native',
    validationStatus: row.validation_status ?? 'ready',
    sha256: row.sha256 ?? null,
    durationSeconds: row.duration_seconds ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    frameRate: row.frame_rate ?? null,
    validationWarningCount: row.validation_warning_count ?? 0,
    validationSummary: parseJsonObject(row.validation_summary),
    validationStartedAt: row.validation_started_at ?? null,
    validatedAt: row.validated_at ?? null,
    sourceContainer: row.source_container ?? null,
    sourceVideoCodec: row.source_video_codec ?? null,
    sourceAudioCodec: row.source_audio_codec ?? null,
    ingestOperation: row.ingest_operation ?? 'unknown',
    userId: deleted ? null : (row.user_id ?? null),
    accountUsername: deleted ? null : (row.account_username ?? null),
    accountDisplayName: deleted ? null : (row.account_display_name ?? null),
    accountAvatarStorageName: deleted ? null : (row.account_avatar_storage_name ?? null),
    accountAvatarMediaType: deleted ? null : (row.account_avatar_media_type ?? null),
    categoryId: row.category_id ?? null,
    categorySlug: row.category_slug ?? null,
    categoryName: row.category_name ?? null,
    coverStorageName: row.cover_storage_name ?? null,
    coverMediaType: row.cover_media_type ?? null,
    coverSource: row.cover_source ?? null,
    visibility: row.visibility ?? 'public',
    moderationStatus: row.moderation_status ?? 'visible',
    moderationVersion: row.moderation_version ?? 0,
    tags: typeof row.tag_list === 'string' && row.tag_list
      ? row.tag_list.split('\u001f').map((entry) => {
        const [slug, name] = entry.split('\u001e');
        return { slug, name };
      }).filter((entry) => entry.slug && entry.name)
      : [],
    upvoteCount: row.upvote_count ?? 0,
    downvoteCount: row.downvote_count ?? 0,
    discussionCount: row.discussion_count ?? 0,
    viewerVote: row.viewer_vote ?? 0,
    archivePublic: row.archive_public === 1,
    withdrawnAt: row.withdrawn_at ?? null,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at
  };
}

function mapFileDeletion(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    storageName: row.storage_name,
    attemptCount: row.attempt_count,
    lastError: row.last_error ?? null,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseJsonObject(value) {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapDiscussion(row) {
  if (!row) return null;
  const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
  return {
    id: row.id,
    videoId: row.video_id,
    nickname: row.nickname,
    bodyMarkdown: row.body_markdown,
    userId: deleted ? null : (row.user_id ?? null),
    accountUsername: deleted ? null : (row.account_username ?? null),
    accountDisplayName: deleted ? null : (row.account_display_name ?? null),
    accountAvatarStorageName: deleted ? null : (row.account_avatar_storage_name ?? null),
    accountAvatarMediaType: deleted ? null : (row.account_avatar_media_type ?? null),
    title: row.title ?? null,
    parentId: row.parent_id ?? null,
    editedAt: row.edited_at ?? null,
    editCount: row.edit_count ?? 0,
    deletedAt: row.deleted_at ?? null,
    moderationStatus: row.moderation_status ?? 'visible',
    moderationVersion: row.moderation_version ?? 0,
    videoTitle: row.video_title ?? null,
    replyCount: row.reply_count ?? 0,
    upvoteCount: row.upvote_count ?? 0,
    downvoteCount: row.downvote_count ?? 0,
    viewerVote: row.viewer_vote ?? 0,
    createdAt: row.created_at
  };
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    bio: row.bio ?? '',
    avatarStorageName: row.avatar_storage_name ?? null,
    avatarMediaType: row.avatar_media_type ?? null,
    role: row.role ?? 'member',
    status: row.status ?? 'active',
    governanceVersion: row.governance_version ?? 0,
    updatedAt: row.updated_at ?? row.created_at,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at
  };
}

function mapNotificationPreferences(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    reply: row.reply === 1,
    videoVote: row.video_vote === 1,
    system: row.system === 1,
    updatedAt: row.updated_at
  };
}

function mapNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    recipientUserId: row.recipient_user_id,
    type: row.type,
    actorUserId: row.actor_user_id ?? null,
    actorDisplayName: row.actor_display_name ?? null,
    videoId: row.video_id ?? null,
    videoTitle: row.video_title ?? null,
    discussionId: row.discussion_id ?? null,
    count: row.event_count,
    isRead: row.is_read === 1,
    systemTitle: row.system_title ?? null,
    systemBody: row.system_body ?? null,
    systemLink: row.system_link ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readAt: row.read_at ?? null
  };
}

function normalizePagination(options = {}) {
  const limit = Number.isSafeInteger(options.limit)
    ? Math.min(Math.max(options.limit, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const offset = Number.isSafeInteger(options.offset) ? Math.max(options.offset, 0) : 0;
  return { limit, offset };
}

function mapSession(row) {
  if (!row) return null;
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    csrfTokenHash: row.csrf_token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    cmsVerifiedAt: row.cms_verified_at ?? null,
    user: {
      id: row.user_id,
      username: row.account_username,
      displayName: row.account_display_name,
      bio: row.account_bio ?? '',
      avatarStorageName: row.account_avatar_storage_name ?? null,
      avatarMediaType: row.account_avatar_media_type ?? null,
      role: row.account_role ?? 'member',
      status: row.account_status ?? 'active',
      governanceVersion: row.account_governance_version ?? 0,
      updatedAt: row.account_updated_at ?? row.account_created_at,
      deletedAt: row.account_deleted_at ?? null,
      createdAt: row.account_created_at
    }
  };
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info('${table}')`).all().some((entry) => entry.name === column);
}

function hasTable(database, table) {
  return database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table) !== undefined;
}

function validateFileDeletionTarget(kind, storageName) {
  if (!FILE_DELETION_KINDS.has(kind)) {
    throw new TypeError('文件删除类型必须是 video、cover 或 avatar');
  }
  if (
    typeof storageName !== 'string'
    || storageName.length < 1
    || storageName.length > 255
    || storageName.includes('/')
    || storageName.includes('\\')
    || storageName === '.'
    || storageName === '..'
    || storageName.includes('\0')
  ) {
    throw new TypeError('待删除文件名必须是安全的存储文件名');
  }
}

function governanceRetentionCutoff(deletedAt, suppliedCutoff) {
  if (typeof suppliedCutoff === 'string' && Number.isFinite(Date.parse(suppliedCutoff))) return suppliedCutoff;
  const timestamp = Date.parse(deletedAt);
  if (!Number.isFinite(timestamp)) throw new TypeError('删除时间无效');
  return new Date(timestamp - DEFAULT_GOVERNANCE_RETENTION_MS).toISOString();
}

function nextFileDeletionAttemptAt(failedAt, attemptCount) {
  const failedAtMs = Date.parse(failedAt);
  if (!Number.isFinite(failedAtMs)) {
    throw new TypeError('文件删除失败时间必须是有效时间');
  }
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 32);
  const delayMs = Math.min(
    FILE_DELETION_INITIAL_BACKOFF_MS * (2 ** exponent),
    FILE_DELETION_MAX_BACKOFF_MS
  );
  return new Date(failedAtMs + delayMs).toISOString();
}

function migrateToV1(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(username) BETWEEN 3 AND 32),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
        password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 512),
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token_hash TEXT NOT NULL CHECK (length(csrf_token_hash) = 64),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        creator TEXT NOT NULL CHECK (length(creator) BETWEEN 1 AND 80),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
        license_code TEXT NOT NULL CHECK (license_code IN ('CC0-1.0', 'CC-BY-4.0', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-ND-4.0')),
        storage_name TEXT NOT NULL UNIQUE,
        original_filename TEXT NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type = 'video/mp4'),
        byte_size INTEGER NOT NULL CHECK (byte_size > 0),
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS discussions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL,
        body_markdown TEXT NOT NULL CHECK (length(body_markdown) BETWEEN 1 AND 5000),
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);

    if (!hasColumn(database, 'videos', 'user_id')) {
      database.exec('ALTER TABLE videos ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    }
    if (!hasColumn(database, 'discussions', 'user_id')) {
      database.exec('ALTER TABLE discussions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    }

    database.exec('CREATE INDEX IF NOT EXISTS idx_videos_created_at_id ON videos(created_at DESC, id DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_videos_user_id ON videos(user_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_discussions_video_created_at_id ON discussions(video_id, created_at ASC, id ASC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_discussions_user_id ON discussions(user_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)');
    database.exec('PRAGMA user_version = 1');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateToV2(database) {
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE videos_v2 (
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
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    database.exec(`
      INSERT INTO videos_v2 (
        id, title, creator, description, license_code, storage_name, original_filename,
        media_type, byte_size, container, video_codec, audio_codec, playback_strategy,
        validation_status, validation_warning_count, validation_summary,
        ingest_operation, user_id, created_at
      )
      SELECT
        id, title, creator, description, license_code, storage_name, original_filename,
        media_type, byte_size, 'mp4', 'unknown', NULL, 'native',
        'ready', 0, '{"legacyUnverified":true}',
        'unknown', user_id, created_at
      FROM videos;
    `);
    database.exec('DROP TABLE videos');
    database.exec('ALTER TABLE videos_v2 RENAME TO videos');
    database.exec('CREATE INDEX idx_videos_created_at_id ON videos(created_at DESC, id DESC)');
    database.exec('CREATE INDEX idx_videos_user_id ON videos(user_id)');
    database.exec('CREATE INDEX idx_videos_validation_status_created_at ON videos(validation_status, created_at ASC, id ASC)');
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length > 0) throw new Error('数据库 v2 迁移后的外键检查失败');
    database.exec('PRAGMA user_version = 2');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

function migrateToV3(database) {
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
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
    `);
    database.exec(`
      INSERT INTO categories (id, slug, name, description, parent_id, sort_order, created_at, updated_at) VALUES
        (1, 'knowledge', '知识与学习', '解释世界、传递方法与长期有效的知识。', NULL, 10, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (2, 'public-life', '社会与公共生活', '关于共同生活、公共议题与现实观察。', NULL, 20, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (3, 'culture', '文化与艺术', '创作、审美、记忆与文化表达。', NULL, 30, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (4, 'science-technology', '科学与技术', '', 1, 11, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (5, 'education-tutorials', '教育与教程', '', 1, 12, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (6, 'humanities-history', '人文与历史', '', 1, 13, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (7, 'society', '社会议题', '', 2, 21, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (8, 'nature-environment', '自然与环境', '', 2, 22, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (9, 'documentary-archives', '纪录与档案', '', 3, 31, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (10, 'arts-creation', '艺术与创作', '', 3, 32, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
        (11, 'other', '其他', '暂时无法归入现有分类的作品。', NULL, 90, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z');
    `);
    database.exec(`
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(slug) BETWEEN 1 AND 48),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE video_tags (
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (video_id, tag_id)
      ) STRICT;
    `);

    database.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'administrator'))");
    database.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled'))");
    database.exec('ALTER TABLE videos ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL');
    database.exec('ALTER TABLE videos ADD COLUMN cover_storage_name TEXT');
    database.exec("ALTER TABLE videos ADD COLUMN cover_media_type TEXT CHECK (cover_media_type IS NULL OR cover_media_type IN ('image/jpeg', 'image/png', 'image/webp'))");
    database.exec("ALTER TABLE videos ADD COLUMN cover_source TEXT CHECK (cover_source IS NULL OR cover_source IN ('uploaded', 'generated'))");
    database.exec("ALTER TABLE videos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted', 'private'))");
    database.exec("ALTER TABLE videos ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK (moderation_status IN ('visible', 'hidden', 'removed'))");
    database.exec('ALTER TABLE discussions ADD COLUMN title TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120)');
    database.exec('ALTER TABLE discussions ADD COLUMN parent_id INTEGER REFERENCES discussions(id) ON DELETE CASCADE');
    database.exec('ALTER TABLE discussions ADD COLUMN edited_at TEXT');
    database.exec('ALTER TABLE discussions ADD COLUMN deleted_at TEXT');

    database.exec(`
      CREATE TABLE video_votes (
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        value INTEGER NOT NULL CHECK (value IN (-1, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (video_id, user_id)
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE discussion_votes (
        discussion_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        value INTEGER NOT NULL CHECK (value IN (-1, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (discussion_id, user_id)
      ) STRICT;
    `);

    database.exec('CREATE UNIQUE INDEX idx_videos_cover_storage_name ON videos(cover_storage_name) WHERE cover_storage_name IS NOT NULL');
    database.exec('CREATE INDEX idx_videos_category_created_at ON videos(category_id, created_at DESC, id DESC)');
    database.exec('CREATE INDEX idx_categories_parent_sort ON categories(parent_id, sort_order, id)');
    database.exec('CREATE INDEX idx_video_tags_tag_video ON video_tags(tag_id, video_id)');
    database.exec('CREATE INDEX idx_discussions_parent_created_at ON discussions(parent_id, created_at ASC, id ASC)');
    database.exec('CREATE INDEX idx_video_votes_video_value ON video_votes(video_id, value)');
    database.exec('CREATE INDEX idx_discussion_votes_discussion_value ON discussion_votes(discussion_id, value)');
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length > 0) throw new Error('数据库 v3 迁移后的外键检查失败');
    database.exec('PRAGMA user_version = 3');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

function migrateToV4(database) {
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 500)");
    database.exec('ALTER TABLE users ADD COLUMN avatar_storage_name TEXT');
    database.exec("ALTER TABLE users ADD COLUMN avatar_media_type TEXT CHECK (avatar_media_type IS NULL OR avatar_media_type IN ('image/jpeg', 'image/png', 'image/webp'))");
    database.exec('ALTER TABLE users ADD COLUMN updated_at TEXT');
    database.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT');
    database.exec('UPDATE users SET updated_at = created_at WHERE updated_at IS NULL');

    database.exec('ALTER TABLE videos ADD COLUMN withdrawn_at TEXT');
    database.exec('ALTER TABLE videos ADD COLUMN deleted_at TEXT');
    database.exec('ALTER TABLE videos ADD COLUMN archive_public INTEGER NOT NULL DEFAULT 0 CHECK (archive_public IN (0, 1))');

    database.exec(`
      CREATE TABLE discussions_v4 (
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
        parent_id INTEGER REFERENCES discussions_v4(id) ON DELETE RESTRICT,
        edited_at TEXT,
        deleted_at TEXT,
        edit_count INTEGER NOT NULL DEFAULT 0 CHECK (edit_count >= 0)
      ) STRICT;
    `);
    database.exec(`
      INSERT INTO discussions_v4 (
        id, video_id, nickname, body_markdown, user_id, created_at,
        title, parent_id, edited_at, deleted_at, edit_count
      )
      SELECT
        id, video_id,
        CASE WHEN deleted_at IS NULL THEN nickname ELSE '已删除用户' END,
        CASE WHEN deleted_at IS NULL THEN body_markdown ELSE '' END,
        CASE WHEN deleted_at IS NULL THEN user_id ELSE NULL END,
        created_at,
        CASE WHEN deleted_at IS NULL THEN title ELSE NULL END,
        parent_id,
        CASE WHEN deleted_at IS NULL THEN edited_at ELSE NULL END,
        deleted_at,
        CASE WHEN deleted_at IS NULL AND edited_at IS NOT NULL THEN 1 ELSE 0 END
      FROM discussions
      ORDER BY id ASC;
    `);
    database.exec('DROP TABLE discussions');
    database.exec('ALTER TABLE discussions_v4 RENAME TO discussions');

    database.exec(`
      CREATE TABLE notification_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        reply INTEGER NOT NULL DEFAULT 1 CHECK (reply IN (0, 1)),
        video_vote INTEGER NOT NULL DEFAULT 1 CHECK (video_vote IN (0, 1)),
        system INTEGER NOT NULL DEFAULT 1 CHECK (system IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    database.exec(`
      INSERT INTO notification_preferences (user_id, reply, video_vote, system, updated_at)
      SELECT id, 1, 1, 1, COALESCE(updated_at, created_at) FROM users;
    `);
    database.exec(`
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
    `);

    database.exec('CREATE UNIQUE INDEX idx_users_avatar_storage_name ON users(avatar_storage_name) WHERE avatar_storage_name IS NOT NULL');
    database.exec('CREATE INDEX idx_users_public_username ON users(username) WHERE status = \'active\' AND deleted_at IS NULL');
    database.exec('CREATE INDEX idx_videos_user_created_at ON videos(user_id, created_at DESC, id DESC)');
    database.exec('CREATE INDEX idx_videos_public_user_created_at ON videos(user_id, created_at DESC, id DESC) WHERE visibility = \'public\' AND moderation_status = \'visible\' AND withdrawn_at IS NULL AND deleted_at IS NULL');
    database.exec('CREATE INDEX idx_discussions_video_created_at_id ON discussions(video_id, created_at ASC, id ASC)');
    database.exec('CREATE INDEX idx_discussions_user_id ON discussions(user_id)');
    database.exec('CREATE INDEX idx_discussions_user_created_at ON discussions(user_id, created_at DESC, id DESC)');
    database.exec('CREATE INDEX idx_discussions_parent_created_at ON discussions(parent_id, created_at ASC, id ASC)');
    database.exec('CREATE INDEX idx_notifications_recipient_created_at ON notifications(recipient_user_id, created_at DESC, id DESC)');
    database.exec('CREATE INDEX idx_notifications_recipient_unread ON notifications(recipient_user_id, is_read, id DESC)');
    database.exec(`
      CREATE UNIQUE INDEX idx_notifications_reply_discussion
      ON notifications(discussion_id)
      WHERE type = 'reply' AND discussion_id IS NOT NULL
    `);
    database.exec(`
      CREATE UNIQUE INDEX idx_notifications_unread_video_vote
      ON notifications(recipient_user_id, type, video_id)
      WHERE is_read = 0 AND type IN ('video_upvote', 'video_downvote') AND video_id IS NOT NULL
    `);

    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length > 0) throw new Error('数据库 v4 迁移后的外键检查失败');
    database.exec('PRAGMA user_version = 4');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

function ensureV4SupplementalSchema(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const hadNotificationVoteActors = hasTable(database, 'notification_vote_actors');
    if (!hasColumn(database, 'videos', 'archive_public')) {
      database.exec('ALTER TABLE videos ADD COLUMN archive_public INTEGER NOT NULL DEFAULT 0 CHECK (archive_public IN (0, 1))');
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS file_deletion_queue (
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
    `);
    if (!hasColumn(database, 'file_deletion_queue', 'next_attempt_at')) {
      database.exec('ALTER TABLE file_deletion_queue ADD COLUMN next_attempt_at TEXT');
    }
    database.exec(`
      UPDATE file_deletion_queue SET next_attempt_at = updated_at
      WHERE next_attempt_at IS NULL
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_file_deletion_queue_updated_at
      ON file_deletion_queue(updated_at ASC, id ASC)
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_file_deletion_queue_next_attempt_at
      ON file_deletion_queue(next_attempt_at ASC, id ASC)
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS notification_vote_actors (
        notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        value INTEGER NOT NULL CHECK (value IN (-1, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (notification_id, actor_user_id)
      ) STRICT;
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_notification_vote_actors_actor_value
      ON notification_vote_actors(actor_user_id, value, notification_id)
    `);
    if (!hadNotificationVoteActors) {
      // Older v4 builds only retained the most recent actor on an aggregated
      // vote notification. The missing actor set cannot be reconstructed from
      // the current net votes without inventing history, so safely close those
      // old unread windows and let future votes start an exact window.
      database.exec(`
        UPDATE notifications
        SET is_read = 1,
            read_at = COALESCE(read_at, updated_at),
            actor_user_id = NULL
        WHERE type IN ('video_upvote', 'video_downvote') AND is_read = 0
      `);
      database.exec(`
        UPDATE notifications SET actor_user_id = NULL
        WHERE type IN ('video_upvote', 'video_downvote')
      `);
    } else {
      // Repair any window produced by the earlier lossy supplemental backfill.
      // Only exact unread windows remain mutable; inconsistent history becomes
      // read-only history rather than allowing event_count to drift forever.
      database.exec(`
        UPDATE notifications AS notification
        SET is_read = 1,
            read_at = COALESCE(read_at, updated_at),
            actor_user_id = NULL
        WHERE notification.type IN ('video_upvote', 'video_downvote')
          AND notification.is_read = 0
          AND (
            notification.event_count != (
              SELECT count(*) FROM notification_vote_actors AS actor
              WHERE actor.notification_id = notification.id
            )
            OR EXISTS (
              SELECT 1 FROM notification_vote_actors AS actor
              WHERE actor.notification_id = notification.id
                AND actor.value != CASE notification.type WHEN 'video_upvote' THEN 1 ELSE -1 END
            )
            OR EXISTS (
              SELECT 1 FROM notification_vote_actors AS actor
              WHERE actor.notification_id = notification.id
                AND NOT EXISTS (
                  SELECT 1 FROM video_votes AS vote
                  WHERE vote.video_id = notification.video_id
                    AND vote.user_id = actor.actor_user_id
                    AND vote.value = actor.value
                )
            )
            OR NOT EXISTS (
              SELECT 1 FROM notification_vote_actors AS actor
              WHERE actor.notification_id = notification.id
                AND actor.actor_user_id = notification.actor_user_id
            )
          )
      `);
    }
    database.exec(`
      DELETE FROM notification_vote_actors
      WHERE notification_id IN (SELECT id FROM notifications WHERE is_read = 1)
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateToV5(database) {
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have completed the migration while this connection
    // waited for the write lock. Re-read the version after BEGIN IMMEDIATE.
    if (database.prepare('PRAGMA user_version').get().user_version >= 5) {
      database.exec('COMMIT');
      return;
    }
    if (!hasColumn(database, 'sessions', 'cms_verified_at')) {
      database.exec('ALTER TABLE sessions ADD COLUMN cms_verified_at TEXT');
    }
    if (!hasColumn(database, 'videos', 'moderation_version')) {
      database.exec('ALTER TABLE videos ADD COLUMN moderation_version INTEGER NOT NULL DEFAULT 0 CHECK (moderation_version >= 0)');
    }
    if (!hasColumn(database, 'discussions', 'moderation_status')) {
      database.exec("ALTER TABLE discussions ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK (moderation_status IN ('visible', 'hidden', 'removed'))");
    }
    if (!hasColumn(database, 'discussions', 'moderation_version')) {
      database.exec('ALTER TABLE discussions ADD COLUMN moderation_version INTEGER NOT NULL DEFAULT 0 CHECK (moderation_version >= 0)');
    }
    if (!hasColumn(database, 'users', 'governance_version')) {
      database.exec('ALTER TABLE users ADD COLUMN governance_version INTEGER NOT NULL DEFAULT 0 CHECK (governance_version >= 0)');
    }
    if (!hasColumn(database, 'tags', 'is_active')) {
      database.exec('ALTER TABLE tags ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))');
    }
    if (!hasColumn(database, 'tags', 'merged_into_id')) {
      database.exec('ALTER TABLE tags ADD COLUMN merged_into_id INTEGER REFERENCES tags(id) ON DELETE RESTRICT');
    }
    if (!hasColumn(database, 'tags', 'updated_at')) {
      database.exec('ALTER TABLE tags ADD COLUMN updated_at TEXT');
    }
    database.exec('UPDATE tags SET updated_at = created_at WHERE updated_at IS NULL');

    database.exec(`
      CREATE TABLE IF NOT EXISTS moderation_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL CHECK (source IN ('report', 'investigation')),
        reporter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        opened_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        video_id TEXT REFERENCES videos(id) ON DELETE RESTRICT,
        discussion_id INTEGER REFERENCES discussions(id) ON DELETE RESTRICT,
        reason_category TEXT NOT NULL CHECK (reason_category IN (
          'spam_fraud', 'harassment_hate', 'illegal_dangerous',
          'privacy_copyright', 'impersonation_metadata', 'other'
        )),
        description TEXT NOT NULL CHECK (length(description) BETWEEN 20 AND 2000),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved')),
        assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('violation_confirmed', 'no_violation')),
        public_explanation TEXT CHECK (public_explanation IS NULL OR length(public_explanation) BETWEEN 1 AND 2000),
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK ((video_id IS NOT NULL) + (discussion_id IS NOT NULL) = 1),
        CHECK ((source = 'report' AND reporter_user_id IS NOT NULL) OR source = 'investigation'),
        CHECK (
          (status != 'resolved' AND resolution IS NULL AND resolved_at IS NULL)
          OR (status = 'resolved' AND resolution IS NOT NULL AND public_explanation IS NOT NULL AND resolved_at IS NOT NULL)
        )
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS case_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL REFERENCES moderation_cases(id) ON DELETE RESTRICT,
        author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS moderation_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER REFERENCES moderation_cases(id) ON DELETE RESTRICT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_label TEXT,
        affected_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        video_id TEXT REFERENCES videos(id) ON DELETE RESTRICT,
        discussion_id INTEGER REFERENCES discussions(id) ON DELETE RESTRICT,
        user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        action TEXT NOT NULL CHECK (action IN (
          'video_hide', 'video_remove', 'video_restore',
          'discussion_hide', 'discussion_remove', 'discussion_restore',
          'user_suspend', 'user_restore', 'user_role', 'user_sessions_revoke', 'appeal_overturn'
        )),
        public_reason TEXT NOT NULL CHECK (length(public_reason) BETWEEN 1 AND 2000),
        internal_note TEXT NOT NULL CHECK (length(internal_note) BETWEEN 1 AND 4000),
        before_json TEXT NOT NULL DEFAULT '{}',
        after_json TEXT NOT NULL DEFAULT '{}',
        before_version INTEGER NOT NULL CHECK (before_version >= 0),
        after_version INTEGER NOT NULL CHECK (after_version >= 0),
        reverses_action_id INTEGER REFERENCES moderation_actions(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        CHECK ((video_id IS NOT NULL) + (discussion_id IS NOT NULL) + (user_id IS NOT NULL) = 1),
        CHECK (actor_user_id IS NOT NULL OR actor_label IS NOT NULL)
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS appeals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        moderation_action_id INTEGER NOT NULL UNIQUE REFERENCES moderation_actions(id) ON DELETE RESTRICT,
        appellant_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 20 AND 2000),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'resolved')),
        result TEXT CHECK (result IS NULL OR result IN ('upheld', 'overturned')),
        reviewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        public_explanation TEXT CHECK (public_explanation IS NULL OR length(public_explanation) BETWEEN 1 AND 2000),
        has_state_conflict INTEGER NOT NULL DEFAULT 0 CHECK (has_state_conflict IN (0, 1)),
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK (
          (status != 'resolved' AND result IS NULL AND resolved_at IS NULL)
          OR (status = 'resolved' AND result IS NOT NULL AND public_explanation IS NOT NULL AND resolved_at IS NOT NULL)
        )
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_label TEXT,
        request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
        action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
        object_type TEXT NOT NULL CHECK (length(object_type) BETWEEN 1 AND 40),
        object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 128),
        before_json TEXT NOT NULL DEFAULT '{}',
        after_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        CHECK (actor_user_id IS NOT NULL OR actor_label IS NOT NULL)
      ) STRICT;
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS cms_media_access_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_token_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        case_id INTEGER NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
        granted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (session_token_hash, case_id, video_id)
      ) STRICT;
    `);

    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_open_video_reporter_case
      ON moderation_cases(reporter_user_id, video_id)
      WHERE source = 'report' AND video_id IS NOT NULL AND status != 'resolved'
    `);
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_open_discussion_reporter_case
      ON moderation_cases(reporter_user_id, discussion_id)
      WHERE source = 'report' AND discussion_id IS NOT NULL AND status != 'resolved'
    `);
    database.exec('CREATE INDEX IF NOT EXISTS idx_cases_status_created ON moderation_cases(status, created_at DESC, id DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_cases_assignee_status ON moderation_cases(assignee_user_id, status, updated_at DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_case_notes_case_created ON case_notes(case_id, created_at ASC, id ASC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_actions_case_created ON moderation_actions(case_id, created_at DESC, id DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_actions_affected_created ON moderation_actions(affected_user_id, created_at DESC, id DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_appeals_status_created ON appeals(status, created_at DESC, id DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC, id DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_audit_actor_created ON audit_events(actor_user_id, created_at DESC, id DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_audit_object_created ON audit_events(object_type, object_id, created_at DESC, id DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_media_grants_lookup ON cms_media_access_grants(session_token_hash, case_id, video_id, expires_at)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tags_active_name ON tags(is_active, name COLLATE NOCASE, id)');

    database.exec(`
      CREATE TRIGGER IF NOT EXISTS case_notes_no_update BEFORE UPDATE ON case_notes
      BEGIN SELECT RAISE(ABORT, 'case notes are append-only'); END
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS case_notes_no_delete BEFORE DELETE ON case_notes
      BEGIN SELECT RAISE(ABORT, 'case notes are append-only'); END
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS moderation_actions_no_update BEFORE UPDATE ON moderation_actions
      BEGIN SELECT RAISE(ABORT, 'moderation actions are append-only'); END
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS moderation_actions_no_delete BEFORE DELETE ON moderation_actions
      BEGIN SELECT RAISE(ABORT, 'moderation actions are append-only'); END
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END
    `);

    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length > 0) throw new Error('数据库 v5 迁移后的外键检查失败');
    database.exec('PRAGMA user_version = 5');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

function ensureV5GovernanceConstraints(database) {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS tags_no_self_merge_insert
    BEFORE INSERT ON tags
    WHEN NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id = NEW.id
    BEGIN SELECT RAISE(ABORT, 'tag cannot merge into itself'); END;

    CREATE TRIGGER IF NOT EXISTS tags_no_self_merge_update
    BEFORE UPDATE OF merged_into_id ON tags
    WHEN NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id = NEW.id
    BEGIN SELECT RAISE(ABORT, 'tag cannot merge into itself'); END;
  `);
}

function migrate(database) {
  let version = database.prepare('PRAGMA user_version').get().user_version;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`数据库结构版本 ${version} 高于程序支持的版本 ${CURRENT_SCHEMA_VERSION}`);
  }
  if (version < 1) {
    migrateToV1(database);
    version = 1;
  }
  if (version < 2) {
    migrateToV2(database);
    version = 2;
  }
  if (version < 3) {
    migrateToV3(database);
    version = 3;
  }
  if (version < 4) {
    migrateToV4(database);
    version = 4;
  }
  ensureV4SupplementalSchema(database);
  if (version < 5) migrateToV5(database);
  ensureV5GovernanceConstraints(database);
}

export function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');

  try {
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }
  database.exec('PRAGMA optimize');

  const videoSelect = `
    SELECT
      v.*,
      CASE WHEN u.deleted_at IS NULL THEN u.username ELSE NULL END AS account_username,
      CASE WHEN u.deleted_at IS NULL THEN u.display_name WHEN u.id IS NOT NULL THEN '已注销用户' ELSE NULL END AS account_display_name,
      CASE WHEN u.deleted_at IS NULL THEN u.avatar_storage_name ELSE NULL END AS account_avatar_storage_name,
      CASE WHEN u.deleted_at IS NULL THEN u.avatar_media_type ELSE NULL END AS account_avatar_media_type,
      c.slug AS category_slug,
      c.name AS category_name,
      (
        SELECT group_concat(tag_row.slug || char(30) || tag_row.name, char(31))
        FROM (
          SELECT t.slug, t.name
          FROM video_tags AS vt
          JOIN tags AS t ON t.id = vt.tag_id
          WHERE vt.video_id = v.id AND t.is_active = 1 AND t.merged_into_id IS NULL
          ORDER BY vt.sort_order ASC, t.id ASC
        ) AS tag_row
      ) AS tag_list,
      (SELECT count(*) FROM video_votes AS vv WHERE vv.video_id = v.id AND vv.value = 1) AS upvote_count,
      (SELECT count(*) FROM video_votes AS vv WHERE vv.video_id = v.id AND vv.value = -1) AS downvote_count,
      (SELECT count(*) FROM discussions AS vd WHERE vd.video_id = v.id AND vd.deleted_at IS NULL) AS discussion_count
    FROM videos AS v
    LEFT JOIN users AS u ON u.id = v.user_id
    LEFT JOIN categories AS c ON c.id = v.category_id AND c.is_active = 1
  `;
  const discussionSelect = `
    SELECT
      d.*,
      CASE WHEN u.deleted_at IS NULL THEN u.username ELSE NULL END AS account_username,
      CASE WHEN u.deleted_at IS NULL THEN u.display_name WHEN u.id IS NOT NULL THEN '已注销用户' ELSE NULL END AS account_display_name,
      CASE WHEN u.deleted_at IS NULL THEN u.avatar_storage_name ELSE NULL END AS account_avatar_storage_name,
      CASE WHEN u.deleted_at IS NULL THEN u.avatar_media_type ELSE NULL END AS account_avatar_media_type,
      v.title AS video_title,
      (SELECT count(*) FROM discussions AS child WHERE child.parent_id = d.id) AS reply_count,
      (SELECT count(*) FROM discussion_votes AS dv WHERE dv.discussion_id = d.id AND dv.value = 1) AS upvote_count,
      (SELECT count(*) FROM discussion_votes AS dv WHERE dv.discussion_id = d.id AND dv.value = -1) AS downvote_count
    FROM discussions AS d
    LEFT JOIN users AS u ON u.id = d.user_id
    JOIN videos AS v ON v.id = d.video_id
  `;
  const sessionSelect = `
    SELECT
      s.*,
      u.username AS account_username,
      u.display_name AS account_display_name,
      u.bio AS account_bio,
      u.avatar_storage_name AS account_avatar_storage_name,
      u.avatar_media_type AS account_avatar_media_type,
      u.role AS account_role,
      u.status AS account_status,
      u.governance_version AS account_governance_version,
      u.updated_at AS account_updated_at,
      u.deleted_at AS account_deleted_at,
      u.created_at AS account_created_at
    FROM sessions AS s
    JOIN users AS u ON u.id = s.user_id
  `;
  const notificationSelect = `
    SELECT
      n.*,
      CASE
        WHEN actor.deleted_at IS NULL THEN actor.display_name
        WHEN actor.id IS NOT NULL THEN '已注销用户'
        ELSE NULL
      END AS actor_display_name,
      v.title AS video_title
    FROM notifications AS n
    LEFT JOIN users AS actor ON actor.id = n.actor_user_id
    LEFT JOIN videos AS v ON v.id = n.video_id
  `;

  const statements = {
    listVideos: database.prepare(`${videoSelect} WHERE v.validation_status IN ('ready', 'ready_with_warnings') AND v.visibility = 'public' AND v.moderation_status = 'visible' AND v.withdrawn_at IS NULL AND v.deleted_at IS NULL ORDER BY v.created_at DESC, v.id DESC`),
    getVideo: database.prepare(`${videoSelect} WHERE v.id = ?`),
    insertVideo: database.prepare(`
      INSERT INTO videos (
        id, title, creator, description, license_code, storage_name, original_filename,
        media_type, byte_size, container, video_codec, audio_codec, playback_strategy,
        validation_status, sha256, duration_seconds, width, height, frame_rate,
        validation_warning_count, validation_summary, validation_started_at, validated_at,
        source_container, source_video_codec, source_audio_codec, ingest_operation,
        user_id, category_id, cover_storage_name, cover_media_type, cover_source,
        visibility, moderation_status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteVideo: database.prepare('DELETE FROM videos WHERE id = ?'),
    nextPendingVideo: database.prepare(`${videoSelect} WHERE v.validation_status = 'pending' AND v.deleted_at IS NULL ORDER BY v.created_at ASC, v.id ASC LIMIT 1`),
    markVideoValidating: database.prepare(`
      UPDATE videos
      SET validation_status = 'validating', validation_started_at = ?, validation_summary = '{}'
      WHERE id = ? AND validation_status = 'pending' AND deleted_at IS NULL
    `),
    resetStaleValidations: database.prepare(`
      UPDATE videos
      SET validation_status = 'pending', validation_started_at = NULL
      WHERE validation_status = 'validating' AND validation_started_at < ? AND deleted_at IS NULL
    `),
    retryFailedValidations: database.prepare(`
      UPDATE videos
      SET validation_status = 'pending', validation_started_at = NULL
      WHERE validation_status = 'validation_failed' AND deleted_at IS NULL
    `),
    completeVideoValidation: database.prepare(`
      UPDATE videos
      SET media_type = ?, container = ?, video_codec = ?, audio_codec = ?, playback_strategy = ?,
          sha256 = ?, duration_seconds = ?, width = ?, height = ?, frame_rate = ?,
          validation_status = ?, validation_warning_count = ?, validation_summary = ?, validated_at = ?
      WHERE id = ? AND validation_status = 'validating' AND validation_started_at = ? AND deleted_at IS NULL
    `),
    setVideoCover: database.prepare(`
      UPDATE videos SET cover_storage_name = ?, cover_media_type = ?, cover_source = ? WHERE id = ? AND deleted_at IS NULL
    `),
    setClaimedVideoCover: database.prepare(`
      UPDATE videos SET cover_storage_name = ?, cover_media_type = ?, cover_source = ?
      WHERE id = ? AND validation_status = 'validating'
        AND validation_started_at = ? AND deleted_at IS NULL
    `),
    renewVideoValidationLease: database.prepare(`
      UPDATE videos SET validation_started_at = ?
      WHERE id = ? AND validation_status = 'validating'
        AND validation_started_at = ? AND deleted_at IS NULL
    `),
    finishVideoValidationFailure: database.prepare(`
      UPDATE videos
      SET validation_status = ?, validation_warning_count = ?, validation_summary = ?, validated_at = ?
      WHERE id = ? AND validation_status = 'validating'
        AND validation_started_at = ? AND deleted_at IS NULL
    `),
    allStorageNames: database.prepare('SELECT storage_name FROM videos WHERE deleted_at IS NULL'),
    allCoverStorageNames: database.prepare('SELECT cover_storage_name FROM videos WHERE cover_storage_name IS NOT NULL AND deleted_at IS NULL'),
    allAvatarStorageNames: database.prepare(`
      SELECT avatar_storage_name FROM users
      WHERE avatar_storage_name IS NOT NULL AND deleted_at IS NULL
    `),
    activeUser: database.prepare(`
      SELECT id FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL
    `),
    writablePublicVideo: database.prepare(`
      SELECT id FROM videos
      WHERE id = ? AND validation_status IN ('ready', 'ready_with_warnings')
        AND visibility = 'public' AND moderation_status = 'visible'
        AND withdrawn_at IS NULL AND deleted_at IS NULL
    `),
    writablePublicDiscussion: database.prepare(`
      SELECT d.id
      FROM discussions AS d
      JOIN videos AS v ON v.id = d.video_id
      WHERE d.id = ? AND d.deleted_at IS NULL
        AND d.moderation_status = 'visible'
        AND v.validation_status IN ('ready', 'ready_with_warnings')
        AND v.visibility = 'public' AND v.moderation_status = 'visible'
        AND v.withdrawn_at IS NULL AND v.deleted_at IS NULL
    `),
    writableDiscussionParent: database.prepare(`
      SELECT id FROM discussions
      WHERE id = ? AND video_id = ? AND deleted_at IS NULL
        AND moderation_status = 'visible'
    `),
    videosMissingCover: database.prepare(`${videoSelect} WHERE v.cover_storage_name IS NULL AND v.deleted_at IS NULL AND v.validation_status IN ('ready', 'ready_with_warnings') ORDER BY v.created_at ASC, v.id ASC`),
    listDiscussions: database.prepare(`${discussionSelect} WHERE d.video_id = ? ORDER BY d.created_at ASC, d.id ASC`),
    insertDiscussion: database.prepare(`
      INSERT INTO discussions (video_id, nickname, body_markdown, user_id, title, parent_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getDiscussion: database.prepare(`${discussionSelect} WHERE d.id = ?`),
    listCategories: database.prepare(`
      SELECT c.*, p.slug AS parent_slug, p.name AS parent_name,
        (SELECT count(*) FROM videos AS v WHERE (v.category_id = c.id OR v.category_id IN (SELECT child.id FROM categories AS child WHERE child.parent_id = c.id)) AND v.validation_status IN ('ready', 'ready_with_warnings') AND v.visibility = 'public' AND v.moderation_status = 'visible' AND v.withdrawn_at IS NULL AND v.deleted_at IS NULL) AS video_count
      FROM categories AS c
      LEFT JOIN categories AS p ON p.id = c.parent_id
      WHERE c.is_active = 1
      ORDER BY c.sort_order ASC, c.id ASC
    `),
    getCategoryBySlug: database.prepare('SELECT * FROM categories WHERE slug = ? AND is_active = 1'),
    listTags: database.prepare(`
      SELECT t.id, t.slug, t.name, count(vt.video_id) AS video_count
      FROM tags AS t
      JOIN video_tags AS vt ON vt.tag_id = t.id
      JOIN videos AS v ON v.id = vt.video_id
      WHERE t.is_active = 1 AND t.merged_into_id IS NULL
        AND v.validation_status IN ('ready', 'ready_with_warnings') AND v.visibility = 'public' AND v.moderation_status = 'visible' AND v.withdrawn_at IS NULL AND v.deleted_at IS NULL
      GROUP BY t.id, t.slug, t.name
      ORDER BY video_count DESC, t.name COLLATE NOCASE ASC
    `),
    getTagBySlug: database.prepare(`
      SELECT t.*, target.slug AS merged_into_slug, target.name AS merged_into_name
      FROM tags AS t LEFT JOIN tags AS target ON target.id = t.merged_into_id
      WHERE t.slug = ? COLLATE NOCASE
    `),
    insertTag: database.prepare(`
      INSERT INTO tags (slug, name, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING
    `),
    insertVideoTag: database.prepare('INSERT OR IGNORE INTO video_tags (video_id, tag_id, sort_order) VALUES (?, ?, ?)'),
    getVideoVote: database.prepare('SELECT value FROM video_votes WHERE video_id = ? AND user_id = ?'),
    getDiscussionVote: database.prepare('SELECT value FROM discussion_votes WHERE discussion_id = ? AND user_id = ?'),
    upsertVideoVote: database.prepare(`
      INSERT INTO video_votes (video_id, user_id, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(video_id, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    deleteVideoVote: database.prepare('DELETE FROM video_votes WHERE video_id = ? AND user_id = ?'),
    upsertDiscussionVote: database.prepare(`
      INSERT INTO discussion_votes (discussion_id, user_id, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(discussion_id, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    deleteDiscussionVote: database.prepare('DELETE FROM discussion_votes WHERE discussion_id = ? AND user_id = ?'),
    createUser: database.prepare(`
      INSERT INTO users (id, username, display_name, password_hash, bio, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getUserById: database.prepare('SELECT * FROM users WHERE id = ?'),
    findUserByUsername: database.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
    updateUserProfile: database.prepare(`
      UPDATE users SET display_name = ?, bio = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND deleted_at IS NULL
    `),
    updateUserAvatar: database.prepare(`
      UPDATE users SET avatar_storage_name = ?, avatar_media_type = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND deleted_at IS NULL
    `),
    updateUserPassword: database.prepare(`
      UPDATE users SET password_hash = ?, updated_at = ?
      WHERE id = ? AND status IN ('active', 'suspended') AND deleted_at IS NULL
    `),
    publicUserProfile: database.prepare(`
      SELECT
        u.id, u.username, u.display_name, u.bio, u.avatar_storage_name, u.avatar_media_type,
        u.created_at, u.updated_at,
        (SELECT count(*) FROM videos AS v
          WHERE v.user_id = u.id AND v.validation_status IN ('ready', 'ready_with_warnings')
            AND v.visibility = 'public' AND v.moderation_status = 'visible'
            AND v.withdrawn_at IS NULL AND v.deleted_at IS NULL) AS video_count,
        (SELECT count(*) FROM discussions AS d
          JOIN videos AS v ON v.id = d.video_id
          WHERE d.user_id = u.id AND d.deleted_at IS NULL AND d.moderation_status = 'visible'
            AND v.validation_status IN ('ready', 'ready_with_warnings')
            AND v.visibility = 'public' AND v.moderation_status = 'visible'
            AND v.withdrawn_at IS NULL AND v.deleted_at IS NULL) AS discussion_count,
        (SELECT count(*) FROM video_votes AS vv
          JOIN videos AS v ON v.id = vv.video_id
          WHERE v.user_id = u.id AND vv.value = 1
            AND v.validation_status IN ('ready', 'ready_with_warnings')
            AND v.visibility = 'public' AND v.moderation_status = 'visible'
            AND v.withdrawn_at IS NULL AND v.deleted_at IS NULL) AS received_upvote_count,
        (SELECT count(*) FROM video_votes AS vv
          JOIN videos AS v ON v.id = vv.video_id
          WHERE v.user_id = u.id AND vv.value = -1
            AND v.validation_status IN ('ready', 'ready_with_warnings')
            AND v.visibility = 'public' AND v.moderation_status = 'visible'
            AND v.withdrawn_at IS NULL AND v.deleted_at IS NULL) AS received_downvote_count
      FROM users AS u
      WHERE u.username = ? COLLATE NOCASE AND u.status = 'active' AND u.deleted_at IS NULL
    `),
    withdrawVideo: database.prepare(`
      UPDATE videos
      SET archive_public = CASE
            WHEN validation_status IN ('ready', 'ready_with_warnings')
              AND visibility = 'public' AND moderation_status = 'visible' THEN 1
            ELSE 0
          END,
          visibility = 'private', withdrawn_at = ?
      WHERE id = ? AND user_id = ? AND withdrawn_at IS NULL AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM users AS owner
          WHERE owner.id = videos.user_id AND owner.status = 'active' AND owner.deleted_at IS NULL
        )
    `),
    republishVideo: database.prepare(`
      UPDATE videos SET visibility = 'public', withdrawn_at = NULL
      WHERE id = ? AND user_id = ? AND withdrawn_at IS NOT NULL AND deleted_at IS NULL
        AND validation_status IN ('ready', 'ready_with_warnings')
        AND moderation_status = 'visible'
        AND EXISTS (
          SELECT 1 FROM users AS owner
          WHERE owner.id = videos.user_id AND owner.status = 'active' AND owner.deleted_at IS NULL
        )
    `),
    getOwnedVideoDeletionSource: database.prepare(`
      SELECT v.id, v.title, v.storage_name, v.cover_storage_name, v.validation_status
      FROM videos AS v
      JOIN users AS owner ON owner.id = v.user_id
      WHERE v.id = ? AND v.user_id = ? AND v.withdrawn_at IS NOT NULL AND v.deleted_at IS NULL
        AND v.moderation_status = 'visible'
        AND owner.status = 'active' AND owner.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM moderation_cases AS c
          WHERE c.video_id = v.id AND c.status != 'resolved'
        )
        AND NOT EXISTS (
          SELECT 1 FROM appeals AS p
          JOIN moderation_actions AS pa ON pa.id = p.moderation_action_id
          WHERE pa.video_id = v.id AND p.status != 'resolved'
        )
        AND NOT EXISTS (
          SELECT 1 FROM moderation_actions AS a
          WHERE a.video_id = v.id
            AND a.action IN ('video_hide', 'video_remove')
            AND a.created_at >= ?
            AND NOT EXISTS (
              SELECT 1 FROM appeals AS resolved_appeal
              WHERE resolved_appeal.moderation_action_id = a.id
                AND resolved_appeal.status = 'resolved'
            )
        )
    `),
    markVideoDeleted: database.prepare(`
      UPDATE videos
      SET archive_public = CASE
            WHEN validation_status IN ('ready', 'ready_with_warnings')
              AND moderation_status = 'visible'
              AND (archive_public = 1 OR visibility = 'public') THEN 1
            ELSE 0
          END,
          title = '作品已删除', creator = '已注销用户', description = '',
          storage_name = ?, original_filename = '已删除', byte_size = 1,
          validation_summary = '{}', sha256 = NULL, duration_seconds = NULL,
          width = NULL, height = NULL, frame_rate = NULL,
          source_container = NULL, source_video_codec = NULL, source_audio_codec = NULL,
          user_id = CASE
            WHEN EXISTS (SELECT 1 FROM moderation_cases AS retained_case WHERE retained_case.video_id = videos.id)
              OR EXISTS (SELECT 1 FROM moderation_actions AS retained_action WHERE retained_action.video_id = videos.id)
              OR EXISTS (SELECT 1 FROM discussions AS retained_discussion WHERE retained_discussion.video_id = videos.id)
            THEN user_id ELSE NULL
          END,
          category_id = NULL, cover_storage_name = NULL,
          cover_media_type = NULL, cover_source = NULL, visibility = 'private',
          moderation_status = 'removed', moderation_version = moderation_version + 1,
          withdrawn_at = COALESCE(withdrawn_at, ?), deleted_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `),
    enqueueFileDeletion: database.prepare(`
      INSERT INTO file_deletion_queue (
        kind, storage_name, attempt_count, last_error, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 0, NULL, ?, ?, ?)
      ON CONFLICT(kind, storage_name) DO NOTHING
    `),
    getFileDeletionByTarget: database.prepare(`
      SELECT * FROM file_deletion_queue WHERE kind = ? AND storage_name = ?
    `),
    getFileDeletionById: database.prepare('SELECT * FROM file_deletion_queue WHERE id = ?'),
    listFileDeletionTargets: database.prepare(`
      SELECT kind, storage_name FROM file_deletion_queue ORDER BY id ASC
    `),
    completeFileDeletion: database.prepare('DELETE FROM file_deletion_queue WHERE id = ?'),
    failFileDeletion: database.prepare(`
      UPDATE file_deletion_queue
      SET attempt_count = attempt_count + 1, last_error = ?,
          next_attempt_at = ?, updated_at = ?
      WHERE id = ?
    `),
    getNotificationPreferences: database.prepare('SELECT * FROM notification_preferences WHERE user_id = ?'),
    updateNotificationPreferences: database.prepare(`
      INSERT INTO notification_preferences (user_id, reply, video_vote, system, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        reply = excluded.reply, video_vote = excluded.video_vote,
        system = excluded.system, updated_at = excluded.updated_at
    `),
    replyNotificationTarget: database.prepare(`
      SELECT parent.user_id AS recipient_user_id, reply.video_id
      FROM discussions AS reply
      JOIN discussions AS parent ON parent.id = reply.parent_id
      JOIN users AS actor ON actor.id = reply.user_id
      JOIN users AS recipient ON recipient.id = parent.user_id
      LEFT JOIN notification_preferences AS preference ON preference.user_id = recipient.id
      WHERE reply.id = ? AND reply.user_id = ? AND parent.deleted_at IS NULL
        AND reply.deleted_at IS NULL
        AND actor.status = 'active' AND actor.deleted_at IS NULL
        AND recipient.status = 'active' AND recipient.deleted_at IS NULL
        AND COALESCE(preference.reply, 1) = 1
    `),
    videoVoteNotificationTarget: database.prepare(`
      SELECT v.user_id AS recipient_user_id
      FROM videos AS v
      JOIN users AS recipient ON recipient.id = v.user_id
      LEFT JOIN notification_preferences AS preference ON preference.user_id = recipient.id
      WHERE v.id = ? AND v.deleted_at IS NULL
        AND recipient.status = 'active' AND recipient.deleted_at IS NULL
        AND COALESCE(preference.video_vote, 1) = 1
    `),
    systemNotificationTarget: database.prepare(`
      SELECT u.id
      FROM users AS u
      LEFT JOIN notification_preferences AS preference ON preference.user_id = u.id
      WHERE u.id = ? AND u.status = 'active' AND u.deleted_at IS NULL
        AND COALESCE(preference.system, 1) = 1
    `),
    insertReplyNotification: database.prepare(`
      INSERT OR IGNORE INTO notifications (
        recipient_user_id, type, actor_user_id, video_id, discussion_id,
        event_count, is_read, created_at, updated_at
      ) VALUES (?, 'reply', ?, ?, ?, 1, 0, ?, ?)
    `),
    insertVoteNotification: database.prepare(`
      INSERT INTO notifications (
        recipient_user_id, type, actor_user_id, video_id,
        event_count, is_read, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 0, ?, ?)
    `),
    insertNotificationVoteActor: database.prepare(`
      INSERT OR IGNORE INTO notification_vote_actors (
        notification_id, actor_user_id, value, created_at
      ) VALUES (?, ?, ?, ?)
    `),
    findUnreadNotificationVoteActor: database.prepare(`
      SELECT n.id, n.event_count
      FROM notification_vote_actors AS actor
      JOIN notifications AS n ON n.id = actor.notification_id
      WHERE actor.actor_user_id = ? AND actor.value = ?
        AND n.video_id = ? AND n.type = ? AND n.is_read = 0
      ORDER BY n.id DESC
      LIMIT 1
    `),
    deleteNotificationVoteActor: database.prepare(`
      DELETE FROM notification_vote_actors
      WHERE notification_id = ? AND actor_user_id = ?
    `),
    insertSystemNotification: database.prepare(`
      INSERT INTO notifications (
        recipient_user_id, type, event_count, is_read,
        system_title, system_body, system_link, created_at, updated_at
      ) VALUES (?, 'system', 1, 0, ?, ?, ?, ?, ?)
    `),
    getNotification: database.prepare(`${notificationSelect} WHERE n.id = ?`),
    getReplyNotification: database.prepare(`${notificationSelect} WHERE n.type = 'reply' AND n.discussion_id = ?`),
    unreadNotificationCount: database.prepare(`
      SELECT count(*) AS count FROM notifications WHERE recipient_user_id = ? AND is_read = 0
    `),
    markNotificationRead: database.prepare(`
      UPDATE notifications SET is_read = 1, read_at = ?, updated_at = ?
      WHERE id = ? AND recipient_user_id = ? AND is_read = 0
    `),
    markAllNotificationsRead: database.prepare(`
      UPDATE notifications SET is_read = 1, read_at = ?, updated_at = ?
      WHERE recipient_user_id = ? AND is_read = 0
    `),
    createSession: database.prepare(`
      INSERT INTO sessions (token_hash, user_id, csrf_token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    getSession: database.prepare(`${sessionSelect} WHERE s.token_hash = ?`),
    findSession: database.prepare(`${sessionSelect} WHERE s.token_hash = ? AND s.expires_at > ? AND u.status IN ('active', 'suspended') AND u.deleted_at IS NULL`),
    sessionEligibleUser: database.prepare(`
      SELECT id FROM users WHERE id = ? AND status IN ('active', 'suspended') AND deleted_at IS NULL
    `),
    updateSessionCsrfToken: database.prepare('UPDATE sessions SET csrf_token_hash = ? WHERE token_hash = ?'),
    revokeSession: database.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    revokeOtherSessions: database.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    revokeAllUserSessions: database.prepare('DELETE FROM sessions WHERE user_id = ?'),
    cleanupExpiredSessions: database.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    health: database.prepare('SELECT 1 AS ok')
  };

  function inImmediateTransaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function cleanupEmptyDiscussionTombstones(startId) {
    let currentId = startId;
    while (currentId !== null && currentId !== undefined) {
      const row = database.prepare(`
        SELECT d.parent_id, d.deleted_at,
          (SELECT count(*) FROM discussions AS child WHERE child.parent_id = d.id) AS child_count
        FROM discussions AS d WHERE d.id = ?
      `).get(currentId);
      const hasGovernanceHistory = database.prepare(`
        SELECT 1
        WHERE EXISTS (SELECT 1 FROM moderation_cases WHERE discussion_id = ?)
           OR EXISTS (SELECT 1 FROM moderation_actions WHERE discussion_id = ?)
      `).get(currentId, currentId);
      if (!row || row.deleted_at === null || row.child_count > 0 || hasGovernanceHistory) break;
      database.prepare(`
        DELETE FROM notifications WHERE type = 'reply' AND discussion_id = ?
      `).run(currentId);
      database.prepare('DELETE FROM discussions WHERE id = ?').run(currentId);
      currentId = row.parent_id;
    }
  }

  function deleteOwnedDiscussionInsideTransaction(id, userId, deletedAt, suppliedGovernanceCutoff) {
    if (!statements.activeUser.get(userId)) return null;
    const governanceCutoff = governanceRetentionCutoff(deletedAt, suppliedGovernanceCutoff);
    const row = database.prepare(`
      SELECT id, parent_id, user_id, deleted_at, moderation_status,
        (SELECT count(*) FROM discussions AS child WHERE child.parent_id = discussions.id) AS child_count
      FROM discussions WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM moderation_cases AS c
          WHERE c.discussion_id = discussions.id AND c.status != 'resolved'
        )
        AND NOT EXISTS (
          SELECT 1 FROM appeals AS p
          JOIN moderation_actions AS pa ON pa.id = p.moderation_action_id
          WHERE pa.discussion_id = discussions.id AND p.status != 'resolved'
        )
        AND NOT EXISTS (
          SELECT 1 FROM moderation_actions AS a
          WHERE a.discussion_id = discussions.id
            AND a.action IN ('discussion_hide', 'discussion_remove')
            AND a.created_at >= ?
            AND NOT EXISTS (
              SELECT 1 FROM appeals AS resolved_appeal
              WHERE resolved_appeal.moderation_action_id = a.id
                AND resolved_appeal.status = 'resolved'
            )
        )
    `).get(id, governanceCutoff);
    if (
      !row
      || row.user_id !== userId
      || row.deleted_at !== null
      || row.moderation_status !== 'visible'
    ) return null;
    database.prepare(`
      DELETE FROM notifications WHERE type = 'reply' AND discussion_id = ?
    `).run(id);
    const hasGovernanceHistory = database.prepare(`
      SELECT 1
      WHERE EXISTS (SELECT 1 FROM moderation_cases WHERE discussion_id = ?)
         OR EXISTS (SELECT 1 FROM moderation_actions WHERE discussion_id = ?)
    `).get(id, id);
    if (row.child_count === 0 && !hasGovernanceHistory) {
      database.prepare('DELETE FROM discussions WHERE id = ?').run(id);
      cleanupEmptyDiscussionTombstones(row.parent_id);
      return { id, mode: 'deleted' };
    }
    database.prepare(`
      UPDATE discussions
      SET nickname = '已删除用户', body_markdown = '',
          user_id = CASE WHEN ? = 1 THEN user_id ELSE NULL END,
          title = NULL, edited_at = NULL, edit_count = 0, deleted_at = ?
      WHERE id = ?
    `).run(hasGovernanceHistory ? 1 : 0, deletedAt, id);
    database.prepare('DELETE FROM discussion_votes WHERE discussion_id = ?').run(id);
    return { id, mode: 'tombstoned' };
  }

  function enqueueFileDeletionInsideTransaction(kind, storageName, createdAt) {
    validateFileDeletionTarget(kind, storageName);
    if (typeof createdAt !== 'string' || createdAt.length === 0) {
      throw new TypeError('文件删除任务时间不能为空');
    }
    statements.enqueueFileDeletion.run(kind, storageName, createdAt, createdAt, createdAt);
    return mapFileDeletion(statements.getFileDeletionByTarget.get(kind, storageName));
  }

  function markVideoDeletedInsideTransaction(row, deletedAt) {
    const tombstoneStorageName = `__deleted__${row.id}`;
    const changed = statements.markVideoDeleted.run(
      tombstoneStorageName,
      deletedAt,
      deletedAt,
      row.id
    ).changes;
    if (changed !== 1) return null;
    database.prepare('DELETE FROM video_votes WHERE video_id = ?').run(row.id);
    database.prepare('DELETE FROM video_tags WHERE video_id = ?').run(row.id);
    database.prepare(`
      DELETE FROM notifications
      WHERE video_id = ? AND type IN ('video_upvote', 'video_downvote')
    `).run(row.id);
    enqueueFileDeletionInsideTransaction('video', row.storage_name, deletedAt);
    if (row.cover_storage_name) {
      enqueueFileDeletionInsideTransaction('cover', row.cover_storage_name, deletedAt);
    }
    return {
      videoId: row.id,
      title: row.title,
      storageName: row.storage_name,
      coverStorageName: row.cover_storage_name ?? null,
      validationStatus: row.validation_status
    };
  }

  function createReplyNotificationInsideTransaction(replyDiscussionId, actorUserId, createdAt) {
    if (
      !statements.activeUser.get(actorUserId)
      || !statements.writablePublicDiscussion.get(replyDiscussionId)
    ) return null;
    const target = statements.replyNotificationTarget.get(replyDiscussionId, actorUserId);
    if (!target || target.recipient_user_id === actorUserId) return null;
    statements.insertReplyNotification.run(
      target.recipient_user_id,
      actorUserId,
      target.video_id,
      replyDiscussionId,
      createdAt,
      createdAt
    );
    return mapNotification(statements.getReplyNotification.get(replyDiscussionId));
  }

  function removeActorFromUnreadVoteNotification(videoId, actorUserId, value, changedAt) {
    if (value !== 1 && value !== -1) return;
    const type = value === 1 ? 'video_upvote' : 'video_downvote';
    const existing = statements.findUnreadNotificationVoteActor.get(
      actorUserId,
      value,
      videoId,
      type
    );
    if (!existing) return;
    if (statements.deleteNotificationVoteActor.run(existing.id, actorUserId).changes !== 1) return;
    if (existing.event_count <= 1) {
      database.prepare('DELETE FROM notifications WHERE id = ?').run(existing.id);
      return;
    }
    database.prepare(`
      UPDATE notifications
      SET event_count = event_count - 1,
          actor_user_id = (
            SELECT actor_user_id FROM notification_vote_actors
            WHERE notification_id = ?
            ORDER BY created_at DESC, actor_user_id ASC
            LIMIT 1
          ),
          updated_at = ?
      WHERE id = ?
    `).run(existing.id, changedAt, existing.id);
  }

  function createVideoVoteNotificationInsideTransaction(
    videoId,
    actorUserId,
    value,
    createdAt,
    previousValue = 0
  ) {
    if (!statements.activeUser.get(actorUserId) || !statements.writablePublicVideo.get(videoId)) {
      return null;
    }
    if (previousValue !== value) {
      removeActorFromUnreadVoteNotification(videoId, actorUserId, previousValue, createdAt);
    }
    if (value !== 1 && value !== -1) return null;
    const target = statements.videoVoteNotificationTarget.get(videoId);
    if (!target || target.recipient_user_id === actorUserId) return null;
    const type = value === 1 ? 'video_upvote' : 'video_downvote';
    const existing = database.prepare(`
      SELECT id FROM notifications
      WHERE recipient_user_id = ? AND type = ? AND video_id = ? AND is_read = 0
    `).get(target.recipient_user_id, type, videoId);
    let notificationId;
    if (existing) {
      const actorInserted = statements.insertNotificationVoteActor.run(
        existing.id,
        actorUserId,
        value,
        createdAt
      ).changes;
      if (actorInserted === 1) {
        database.prepare(`
          UPDATE notifications
          SET actor_user_id = ?, event_count = event_count + 1, updated_at = ?
          WHERE id = ?
        `).run(actorUserId, createdAt, existing.id);
      }
      notificationId = existing.id;
    } else {
      const result = statements.insertVoteNotification.run(
        target.recipient_user_id,
        type,
        actorUserId,
        videoId,
        createdAt,
        createdAt
      );
      notificationId = result.lastInsertRowid;
      statements.insertNotificationVoteActor.run(notificationId, actorUserId, value, createdAt);
    }
    return mapNotification(statements.getNotification.get(notificationId));
  }

  return {
    raw: database,
    governance: createGovernanceStore(database),
    getSchemaVersion() {
      return database.prepare('PRAGMA user_version').get().user_version;
    },
    listVideos(filters = {}) {
      const query = typeof filters.query === 'string' ? filters.query.trim() : '';
      const categorySlug = typeof filters.categorySlug === 'string' ? filters.categorySlug.trim() : '';
      const tagSlug = typeof filters.tagSlug === 'string' ? filters.tagSlug.trim() : '';
      const limit = Number.isSafeInteger(filters.limit) ? Math.min(Math.max(filters.limit, 1), 100) : 60;
      if (!query && !categorySlug && !tagSlug && limit === 60) {
        return statements.listVideos.all().map(mapVideo);
      }
      const clauses = [
        "v.validation_status IN ('ready', 'ready_with_warnings')",
        "v.visibility = 'public'",
        "v.moderation_status = 'visible'",
        'v.withdrawn_at IS NULL',
        'v.deleted_at IS NULL'
      ];
      const values = [];
      if (query) {
        const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        clauses.push(`(
          v.title LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR v.creator LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR v.description LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR EXISTS (
            SELECT 1 FROM video_tags AS search_vt
            JOIN tags AS search_t ON search_t.id = search_vt.tag_id
            WHERE search_vt.video_id = v.id
              AND search_t.is_active = 1 AND search_t.merged_into_id IS NULL
              AND search_t.name LIKE ? ESCAPE '\\' COLLATE NOCASE
          )
        )`);
        values.push(pattern, pattern, pattern, pattern);
      }
      if (categorySlug) {
        clauses.push('(c.slug = ? OR c.parent_id = (SELECT id FROM categories WHERE slug = ?))');
        values.push(categorySlug, categorySlug);
      }
      if (tagSlug) {
        clauses.push(`EXISTS (
          SELECT 1 FROM video_tags AS filter_vt
          JOIN tags AS filter_t ON filter_t.id = filter_vt.tag_id
          WHERE filter_vt.video_id = v.id
            AND filter_t.is_active = 1 AND filter_t.merged_into_id IS NULL
            AND filter_t.slug = ? COLLATE NOCASE
        )`);
        values.push(tagSlug);
      }
      const sql = `${videoSelect} WHERE ${clauses.join(' AND ')} ORDER BY v.created_at DESC, v.id DESC LIMIT ?`;
      values.push(limit);
      return database.prepare(sql).all(...values).map(mapVideo);
    },
    getVideo(id, viewerUserId = null) {
      const video = mapVideo(statements.getVideo.get(id));
      if (video && viewerUserId) {
        video.viewerVote = statements.getVideoVote.get(id, viewerUserId)?.value ?? 0;
      }
      return video;
    },
    insertVideo(video) {
      const container = video.container ?? (video.mediaType === 'video/webm' ? 'webm' : 'mp4');
      const validationStatus = video.validationStatus ?? 'ready';
      const categoryId = video.categoryId ?? (video.categorySlug
        ? statements.getCategoryBySlug.get(video.categorySlug)?.id ?? null
        : null);
      database.exec('BEGIN IMMEDIATE');
      try {
        if (video.userId !== undefined && video.userId !== null && !statements.activeUser.get(video.userId)) {
          database.exec('COMMIT');
          return null;
        }
        statements.insertVideo.run(
          video.id,
          video.title,
          video.creator,
          video.description,
          video.licenseCode,
          video.storageName,
          video.originalFilename,
          video.mediaType,
          video.byteSize,
          container,
          video.videoCodec ?? 'unknown',
          video.audioCodec ?? null,
          video.playbackStrategy ?? 'native',
          validationStatus,
          video.sha256 ?? null,
          video.durationSeconds ?? null,
          video.width ?? null,
          video.height ?? null,
          video.frameRate ?? null,
          video.validationWarningCount ?? 0,
          JSON.stringify(video.validationSummary ?? {}),
          video.validationStartedAt ?? null,
          video.validatedAt ?? null,
          video.sourceContainer ?? null,
          video.sourceVideoCodec ?? null,
          video.sourceAudioCodec ?? null,
          video.ingestOperation ?? 'unknown',
          video.userId ?? null,
          categoryId,
          video.coverStorageName ?? null,
          video.coverMediaType ?? null,
          video.coverSource ?? null,
          video.visibility ?? 'public',
          video.moderationStatus ?? 'visible',
          video.createdAt
        );
        for (const [index, tag] of (video.tags ?? []).entries()) {
          statements.insertTag.run(tag.slug, tag.name, video.userId ?? null, video.createdAt, video.createdAt);
          const storedTag = statements.getTagBySlug.get(tag.slug);
          if (!storedTag || storedTag.is_active !== 1 || storedTag.merged_into_id !== null) {
            throw new Error(`标签 ${tag.slug} 已停用或合并，不能用于新稿件`);
          }
          statements.insertVideoTag.run(video.id, storedTag.id, index);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return this.getVideo(video.id);
    },
    deleteVideo(id) {
      return statements.deleteVideo.run(id).changes;
    },
    claimNextVideoForValidation(startedAt) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const video = mapVideo(statements.nextPendingVideo.get());
        if (!video) {
          database.exec('COMMIT');
          return null;
        }
        const changed = statements.markVideoValidating.run(startedAt, video.id).changes;
        database.exec('COMMIT');
        return changed === 1 ? this.getVideo(video.id) : null;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    resetStaleValidations(cutoffIso) {
      return statements.resetStaleValidations.run(cutoffIso).changes;
    },
    retryFailedValidations() {
      return statements.retryFailedValidations.run().changes;
    },
    completeVideoValidation(id, result, validatedAt, claimStartedAt) {
      if (typeof claimStartedAt !== 'string' || claimStartedAt.length === 0) return 0;
      const status = result.warningCount > 0 ? 'ready_with_warnings' : 'ready';
      return statements.completeVideoValidation.run(
        result.mediaType,
        result.container,
        result.videoCodec,
        result.audioCodec ?? null,
        result.playbackStrategy,
        result.sha256,
        result.durationSeconds,
        result.width,
        result.height,
        result.frameRate,
        status,
        result.warningCount,
        JSON.stringify(result.summary ?? {}),
        validatedAt,
        id,
        claimStartedAt
      ).changes;
    },
    setVideoCover(id, { storageName, mediaType, source }, claimStartedAt = null) {
      if (claimStartedAt !== null) {
        return statements.setClaimedVideoCover.run(
          storageName,
          mediaType,
          source,
          id,
          claimStartedAt
        ).changes;
      }
      return statements.setVideoCover.run(storageName, mediaType, source, id).changes;
    },
    renewVideoValidationLease(id, claimStartedAt, renewedAt) {
      if (
        typeof claimStartedAt !== 'string' || claimStartedAt.length === 0
        || typeof renewedAt !== 'string' || renewedAt.length === 0
      ) return 0;
      return statements.renewVideoValidationLease.run(renewedAt, id, claimStartedAt).changes;
    },
    rejectVideoValidation(id, summary, validatedAt, claimStartedAt, warningCount = 0) {
      if (typeof claimStartedAt !== 'string' || claimStartedAt.length === 0) return 0;
      return inImmediateTransaction(() => {
        const asset = database.prepare(`
          SELECT storage_name, cover_storage_name FROM videos
          WHERE id = ? AND validation_status = 'validating'
            AND validation_started_at = ? AND deleted_at IS NULL
        `).get(id, claimStartedAt);
        if (!asset) return 0;
        const changed = statements.finishVideoValidationFailure.run(
          'rejected', warningCount, JSON.stringify(summary ?? {}), validatedAt, id, claimStartedAt
        ).changes;
        if (changed !== 1) return 0;
        database.prepare(`
          UPDATE videos
          SET cover_storage_name = NULL, cover_media_type = NULL, cover_source = NULL
          WHERE id = ?
        `).run(id);
        enqueueFileDeletionInsideTransaction('video', asset.storage_name, validatedAt);
        if (asset.cover_storage_name) {
          enqueueFileDeletionInsideTransaction('cover', asset.cover_storage_name, validatedAt);
        }
        return 1;
      });
    },
    failVideoValidation(id, summary, validatedAt, claimStartedAt) {
      if (typeof claimStartedAt !== 'string' || claimStartedAt.length === 0) return 0;
      return statements.finishVideoValidationFailure.run(
        'validation_failed', 0, JSON.stringify(summary ?? {}), validatedAt, id, claimStartedAt
      ).changes;
    },
    listVideoStorageNames() {
      return statements.allStorageNames.all().map((row) => row.storage_name);
    },
    listCoverStorageNames() {
      return statements.allCoverStorageNames.all().map((row) => row.cover_storage_name);
    },
    listAvatarStorageNames() {
      return statements.allAvatarStorageNames.all().map((row) => row.avatar_storage_name);
    },
    listFileDeletionTargets() {
      return statements.listFileDeletionTargets.all().map((row) => ({
        kind: row.kind,
        storageName: row.storage_name
      }));
    },
    listVideosMissingCover() {
      return statements.videosMissingCover.all().map(mapVideo);
    },
    enqueueFileDeletion({ kind, storageName, createdAt = new Date().toISOString() }) {
      return inImmediateTransaction(() => enqueueFileDeletionInsideTransaction(
        kind,
        storageName,
        createdAt
      ));
    },
    listPendingFileDeletions(options = {}) {
      const limit = Number.isSafeInteger(options.limit)
        ? Math.min(Math.max(options.limit, 1), MAX_PAGE_SIZE)
        : MAX_PAGE_SIZE;
      let eligibleAt = null;
      if (options.eligibleAt !== undefined && options.eligibleAt !== null) {
        const eligibleAtMs = Date.parse(options.eligibleAt);
        if (!Number.isFinite(eligibleAtMs)) {
          throw new TypeError('文件删除任务查询时间必须是有效时间');
        }
        eligibleAt = new Date(eligibleAtMs).toISOString();
      }
      const eligibleClause = eligibleAt === null ? '' : 'WHERE next_attempt_at <= ?';
      const values = eligibleAt === null ? [limit] : [eligibleAt, limit];
      return database.prepare(`
        SELECT * FROM file_deletion_queue
        ${eligibleClause}
        ORDER BY CASE WHEN attempt_count = 0 THEN 0 ELSE 1 END ASC,
          updated_at ASC, id ASC
        LIMIT ?
      `).all(...values).map(mapFileDeletion);
    },
    completeFileDeletion(id) {
      return statements.completeFileDeletion.run(id).changes;
    },
    failFileDeletion(id, error, updatedAt = new Date().toISOString()) {
      const rawMessage = error instanceof Error ? error.message : String(error ?? '未知删除错误');
      const message = (rawMessage || '未知删除错误').slice(0, MAX_FILE_DELETION_ERROR_LENGTH);
      return inImmediateTransaction(() => {
        const current = statements.getFileDeletionById.get(id);
        if (!current) return null;
        const nextAttemptAt = nextFileDeletionAttemptAt(updatedAt, current.attempt_count + 1);
        const changed = statements.failFileDeletion.run(
          message,
          nextAttemptAt,
          updatedAt,
          id
        ).changes;
        return changed === 1 ? mapFileDeletion(statements.getFileDeletionById.get(id)) : null;
      });
    },
    listUserVideos(userId, options = {}) {
      const { limit, offset } = normalizePagination(options);
      const items = database.prepare(`
        ${videoSelect}
        WHERE v.user_id = ?
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT ? OFFSET ?
      `).all(userId, limit, offset).map(mapVideo);
      const total = database.prepare('SELECT count(*) AS count FROM videos WHERE user_id = ?')
        .get(userId).count;
      return { items, total, limit, offset };
    },
    listPublicUserVideos(userId, options = {}) {
      const { limit, offset } = normalizePagination(options);
      const publicWhere = `
        v.user_id = ? AND v.validation_status IN ('ready', 'ready_with_warnings')
        AND v.visibility = 'public' AND v.moderation_status = 'visible'
        AND v.withdrawn_at IS NULL AND v.deleted_at IS NULL
      `;
      const items = database.prepare(`
        ${videoSelect} WHERE ${publicWhere}
        ORDER BY v.created_at DESC, v.id DESC LIMIT ? OFFSET ?
      `).all(userId, limit, offset).map(mapVideo);
      const total = database.prepare(`SELECT count(*) AS count FROM videos AS v WHERE ${publicWhere}`)
        .get(userId).count;
      return { items, total, limit, offset };
    },
    withdrawVideo(id, userId, withdrawnAt) {
      return inImmediateTransaction(() => {
        const changed = statements.withdrawVideo.run(withdrawnAt, id, userId).changes;
        return changed === 1 ? this.getVideo(id, userId) : null;
      });
    },
    republishVideo(id, userId) {
      return inImmediateTransaction(() => {
        const changed = statements.republishVideo.run(id, userId).changes;
        return changed === 1 ? this.getVideo(id, userId) : null;
      });
    },
    markVideoPermanentlyDeleted(id, userId, deletedAt, governanceCutoff) {
      return inImmediateTransaction(() => {
        const cutoff = governanceRetentionCutoff(deletedAt, governanceCutoff);
        const row = statements.getOwnedVideoDeletionSource.get(id, userId, cutoff);
        if (!row) return null;
        return markVideoDeletedInsideTransaction(row, deletedAt);
      });
    },
    listDiscussions(videoId, viewerUserId = null) {
      return statements.listDiscussions.all(videoId).map((row) => {
        const discussion = mapDiscussion(row);
        if (viewerUserId) {
          discussion.viewerVote = statements.getDiscussionVote.get(discussion.id, viewerUserId)?.value ?? 0;
        }
        return discussion;
      });
    },
    insertDiscussion(discussion) {
      return inImmediateTransaction(() => {
        if (
          (discussion.userId !== undefined && discussion.userId !== null
            && !statements.activeUser.get(discussion.userId))
          || !statements.writablePublicVideo.get(discussion.videoId)
          || (discussion.parentId !== undefined && discussion.parentId !== null
            && !statements.writableDiscussionParent.get(discussion.parentId, discussion.videoId))
        ) return null;
        const result = statements.insertDiscussion.run(
          discussion.videoId,
          discussion.nickname,
          discussion.bodyMarkdown,
          discussion.userId ?? null,
          discussion.title ?? null,
          discussion.parentId ?? null,
          discussion.createdAt
        );
        const inserted = mapDiscussion(statements.getDiscussion.get(result.lastInsertRowid));
        if (inserted.parentId !== null && inserted.userId !== null && discussion.notifyParent !== false) {
          createReplyNotificationInsideTransaction(inserted.id, inserted.userId, discussion.createdAt);
        }
        return inserted;
      });
    },
    getDiscussion(id, viewerUserId = null) {
      const discussion = mapDiscussion(statements.getDiscussion.get(id));
      if (discussion && viewerUserId) {
        discussion.viewerVote = statements.getDiscussionVote.get(id, viewerUserId)?.value ?? 0;
      }
      return discussion;
    },
    listUserDiscussions(userId, options = {}) {
      const { limit, offset } = normalizePagination(options);
      const items = database.prepare(`
        ${discussionSelect}
        WHERE d.user_id = ? AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ? OFFSET ?
      `).all(userId, limit, offset).map(mapDiscussion);
      const total = database.prepare(`
        SELECT count(*) AS count FROM discussions
        WHERE user_id = ? AND deleted_at IS NULL
      `).get(userId).count;
      return { items, total, limit, offset };
    },
    editDiscussion(id, userId, changes, suppliedGovernanceCutoff) {
      return inImmediateTransaction(() => {
        const governanceCutoff = governanceRetentionCutoff(changes.editedAt, suppliedGovernanceCutoff);
        const current = database.prepare(`
          SELECT d.title, d.body_markdown
          FROM discussions AS d
          JOIN videos AS v ON v.id = d.video_id
          JOIN users AS author ON author.id = d.user_id
          WHERE d.id = ? AND d.user_id = ? AND d.deleted_at IS NULL
            AND d.moderation_status = 'visible'
            AND v.deleted_at IS NULL
            AND author.status = 'active' AND author.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM moderation_cases AS c
              WHERE c.discussion_id = d.id AND c.status != 'resolved'
            )
            AND NOT EXISTS (
              SELECT 1 FROM appeals AS p
              JOIN moderation_actions AS pa ON pa.id = p.moderation_action_id
              WHERE pa.discussion_id = d.id AND p.status != 'resolved'
            )
            AND NOT EXISTS (
              SELECT 1 FROM moderation_actions AS a
              WHERE a.discussion_id = d.id
                AND a.action IN ('discussion_hide', 'discussion_remove')
                AND a.created_at >= ?
                AND NOT EXISTS (
                  SELECT 1 FROM appeals AS resolved_appeal
                  WHERE resolved_appeal.moderation_action_id = a.id
                    AND resolved_appeal.status = 'resolved'
                )
            )
        `).get(id, userId, governanceCutoff);
        if (!current) return null;
        const title = changes.title ?? null;
        const bodyMarkdown = changes.bodyMarkdown;
        if (current.title === title && current.body_markdown === bodyMarkdown) {
          return this.getDiscussion(id, userId);
        }
        database.prepare(`
          UPDATE discussions
          SET title = ?, body_markdown = ?, edited_at = ?, edit_count = edit_count + 1
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        `).run(title, bodyMarkdown, changes.editedAt, id, userId);
        return this.getDiscussion(id, userId);
      });
    },
    deleteDiscussion(id, userId, deletedAt, governanceCutoff) {
      return inImmediateTransaction(() => deleteOwnedDiscussionInsideTransaction(
        id,
        userId,
        deletedAt,
        governanceCutoff
      ));
    },
    listCategories() {
      return statements.listCategories.all().map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        parentId: row.parent_id ?? null,
        parentSlug: row.parent_slug ?? null,
        parentName: row.parent_name ?? null,
        sortOrder: row.sort_order,
        videoCount: row.video_count ?? 0
      }));
    },
    getCategoryBySlug(slug) {
      const row = statements.getCategoryBySlug.get(slug);
      return row ? { id: row.id, slug: row.slug, name: row.name, description: row.description, parentId: row.parent_id ?? null } : null;
    },
    listTags() {
      return statements.listTags.all().map((row) => ({ id: row.id, slug: row.slug, name: row.name, videoCount: row.video_count }));
    },
    getTagBySlug(slug) {
      const row = statements.getTagBySlug.get(slug);
      return row ? {
        id: row.id,
        slug: row.slug,
        name: row.name,
        isActive: row.is_active === 1,
        mergedIntoId: row.merged_into_id ?? null,
        mergedIntoSlug: row.merged_into_slug ?? null,
        mergedIntoName: row.merged_into_name ?? null,
        updatedAt: row.updated_at ?? row.created_at
      } : null;
    },
    setVideoVote(videoId, userId, value, changedAt, options = {}) {
      return inImmediateTransaction(() => {
        if (!statements.activeUser.get(userId)) return null;
        const previousValue = statements.getVideoVote.get(videoId, userId)?.value ?? 0;
        if (!statements.writablePublicVideo.get(videoId)) {
          if (value === 0 && previousValue !== 0) {
            statements.deleteVideoVote.run(videoId, userId);
            if (options.notifyOwner !== false) {
              removeActorFromUnreadVoteNotification(videoId, userId, previousValue, changedAt);
            }
          }
          return null;
        }
        if (value === 0) statements.deleteVideoVote.run(videoId, userId);
        else statements.upsertVideoVote.run(videoId, userId, value, changedAt, changedAt);
        if (value !== previousValue && options.notifyOwner !== false) {
          createVideoVoteNotificationInsideTransaction(
            videoId,
            userId,
            value,
            changedAt,
            previousValue
          );
        }
        return this.getVideo(videoId, userId);
      });
    },
    setDiscussionVote(discussionId, userId, value, changedAt) {
      return inImmediateTransaction(() => {
        if (!statements.activeUser.get(userId)) return null;
        const previousValue = statements.getDiscussionVote.get(discussionId, userId)?.value ?? 0;
        if (!statements.writablePublicDiscussion.get(discussionId)) {
          if (value === 0 && previousValue !== 0) {
            statements.deleteDiscussionVote.run(discussionId, userId);
          }
          return null;
        }
        if (value === 0) statements.deleteDiscussionVote.run(discussionId, userId);
        else statements.upsertDiscussionVote.run(discussionId, userId, value, changedAt, changedAt);
        return this.getDiscussion(discussionId, userId);
      });
    },
    createUser(user) {
      return inImmediateTransaction(() => {
        statements.createUser.run(
          user.id,
          user.username,
          user.displayName,
          user.passwordHash,
          user.bio ?? '',
          user.createdAt,
          user.createdAt
        );
        statements.updateNotificationPreferences.run(user.id, 1, 1, 1, user.createdAt);
        return mapUser(statements.getUserById.get(user.id));
      });
    },
    getUserById(id) {
      return mapUser(statements.getUserById.get(id));
    },
    findUserByUsername(username) {
      return mapUser(statements.findUserByUsername.get(username));
    },
    updateUserProfile(userId, { displayName, bio, updatedAt }) {
      const changed = statements.updateUserProfile.run(displayName, bio, updatedAt, userId).changes;
      return changed === 1 ? mapUser(statements.getUserById.get(userId)) : null;
    },
    updateUserAvatar(userId, { storageName, mediaType, updatedAt }) {
      return inImmediateTransaction(() => {
        const current = statements.getUserById.get(userId);
        if (!current || current.status !== 'active' || current.deleted_at !== null) return null;
        const changed = statements.updateUserAvatar.run(
          storageName ?? null,
          mediaType ?? null,
          updatedAt,
          userId
        ).changes;
        if (changed !== 1) return null;
        if (current.avatar_storage_name && current.avatar_storage_name !== (storageName ?? null)) {
          enqueueFileDeletionInsideTransaction('avatar', current.avatar_storage_name, updatedAt);
        }
        return {
          user: mapUser(statements.getUserById.get(userId)),
          previousAvatarStorageName: current.avatar_storage_name ?? null
        };
      });
    },
    updateUserPassword(userId, passwordHash, updatedAt) {
      return statements.updateUserPassword.run(passwordHash, updatedAt, userId).changes;
    },
    getPublicUserProfile(username) {
      const row = statements.publicUserProfile.get(username);
      if (!row) return null;
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        bio: row.bio,
        avatarStorageName: row.avatar_storage_name ?? null,
        avatarMediaType: row.avatar_media_type ?? null,
        videoCount: row.video_count,
        discussionCount: row.discussion_count,
        receivedUpvoteCount: row.received_upvote_count,
        receivedDownvoteCount: row.received_downvote_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },
    getNotificationPreferences(userId) {
      return mapNotificationPreferences(statements.getNotificationPreferences.get(userId));
    },
    updateNotificationPreferences(userId, preferences, updatedAt) {
      return inImmediateTransaction(() => {
        if (!statements.activeUser.get(userId)) return null;
        statements.updateNotificationPreferences.run(
          userId,
          preferences.reply ? 1 : 0,
          preferences.videoVote ? 1 : 0,
          preferences.system ? 1 : 0,
          updatedAt
        );
        return mapNotificationPreferences(statements.getNotificationPreferences.get(userId));
      });
    },
    createReplyNotification({ replyDiscussionId, actorUserId, createdAt }) {
      return inImmediateTransaction(() => createReplyNotificationInsideTransaction(
        replyDiscussionId,
        actorUserId,
        createdAt
      ));
    },
    createVideoVoteNotification({ videoId, actorUserId, value, previousValue = 0, createdAt }) {
      return inImmediateTransaction(() => createVideoVoteNotificationInsideTransaction(
        videoId,
        actorUserId,
        value,
        createdAt,
        previousValue
      ));
    },
    createSystemNotification({ recipientUserId, title, body = '', link = null, createdAt }) {
      return inImmediateTransaction(() => {
        if (!statements.systemNotificationTarget.get(recipientUserId)) return null;
        const result = statements.insertSystemNotification.run(
          recipientUserId,
          title,
          body,
          link,
          createdAt,
          createdAt
        );
        return mapNotification(statements.getNotification.get(result.lastInsertRowid));
      });
    },
    listNotifications(userId, options = {}) {
      const { limit, offset } = normalizePagination(options);
      const unreadOnly = options.unreadOnly === true;
      const unreadClause = unreadOnly ? ' AND n.is_read = 0' : '';
      const items = database.prepare(`
        ${notificationSelect}
        WHERE n.recipient_user_id = ?${unreadClause}
        ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?
      `).all(userId, limit, offset).map(mapNotification);
      const total = database.prepare(`
        SELECT count(*) AS count FROM notifications
        WHERE recipient_user_id = ?${unreadOnly ? ' AND is_read = 0' : ''}
      `).get(userId).count;
      return {
        items,
        total,
        unreadCount: this.getUnreadNotificationCount(userId),
        limit,
        offset
      };
    },
    pollNotifications(userId, options = {}) {
      const limit = Number.isSafeInteger(options.limit)
        ? Math.min(Math.max(options.limit, 1), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;
      return {
        items: database.prepare(`
          ${notificationSelect}
          WHERE n.recipient_user_id = ? AND n.is_read = 0
          ORDER BY n.updated_at DESC, n.id DESC LIMIT ?
        `).all(userId, limit).map(mapNotification),
        unreadCount: this.getUnreadNotificationCount(userId)
      };
    },
    getUnreadNotificationCount(userId) {
      return database.prepare(`
        SELECT COALESCE(sum(event_count), 0) AS count
        FROM notifications WHERE recipient_user_id = ? AND is_read = 0
      `).get(userId).count;
    },
    markNotificationRead(id, userId, readAt) {
      const changed = statements.markNotificationRead.run(readAt, readAt, id, userId).changes;
      return changed === 1 ? mapNotification(statements.getNotification.get(id)) : null;
    },
    markAllNotificationsRead(userId, readAt) {
      return statements.markAllNotificationsRead.run(readAt, readAt, userId).changes;
    },
    deleteAccount(userId, options) {
      const deletedAt = options.deletedAt;
      return inImmediateTransaction(() => {
        const user = statements.getUserById.get(userId);
        if (!user || user.status !== 'active' || user.deleted_at !== null) return null;
        if (
          user.role === 'administrator'
          && database.prepare(`
            SELECT count(*) AS count FROM users
            WHERE role = 'administrator' AND status = 'active' AND deleted_at IS NULL
          `).get().count <= 1
        ) return null;
        const assets = [];
        if (options.deleteVideos === true) {
          const cutoff = governanceRetentionCutoff(deletedAt, options.governanceCutoff);
          const protectedVideo = database.prepare(`
            SELECT v.id FROM videos AS v
            WHERE v.user_id = ? AND v.deleted_at IS NULL
              AND (
                v.moderation_status != 'visible'
                OR EXISTS (
                  SELECT 1 FROM moderation_cases AS c
                  WHERE c.video_id = v.id AND c.status != 'resolved'
                )
                OR EXISTS (
                  SELECT 1 FROM appeals AS p
                  JOIN moderation_actions AS pa ON pa.id = p.moderation_action_id
                  WHERE pa.video_id = v.id AND p.status != 'resolved'
                )
                OR EXISTS (
                  SELECT 1 FROM moderation_actions AS a
                  WHERE a.video_id = v.id
                    AND a.action IN ('video_hide', 'video_remove')
                    AND a.created_at >= ?
                    AND NOT EXISTS (
                      SELECT 1 FROM appeals AS resolved_appeal
                      WHERE resolved_appeal.moderation_action_id = a.id
                        AND resolved_appeal.status = 'resolved'
                    )
                )
              )
            LIMIT 1
          `).get(userId, cutoff);
          if (protectedVideo) return null;
          const rows = database.prepare(`
            SELECT id, title, storage_name, cover_storage_name, validation_status
            FROM videos WHERE user_id = ? AND deleted_at IS NULL
            ORDER BY id ASC
          `).all(userId);
          for (const row of rows) {
            const asset = markVideoDeletedInsideTransaction(row, deletedAt);
            if (asset) assets.push(asset);
          }
        }
        if (options.deleteDiscussions === true) {
          const ids = database.prepare(`
            SELECT id FROM discussions
            WHERE user_id = ? AND deleted_at IS NULL
            ORDER BY id DESC
          `).all(userId);
          for (const { id } of ids) {
            deleteOwnedDiscussionInsideTransaction(id, userId, deletedAt, options.governanceCutoff);
          }
        }
        database.prepare("UPDATE discussions SET nickname = '已注销用户' WHERE user_id = ?").run(userId);
        const currentVideoVotes = database.prepare(`
          SELECT video_id, value FROM video_votes WHERE user_id = ?
        `).all(userId);
        for (const vote of currentVideoVotes) {
          removeActorFromUnreadVoteNotification(vote.video_id, userId, vote.value, deletedAt);
        }
        database.prepare('DELETE FROM video_votes WHERE user_id = ?').run(userId);
        database.prepare('DELETE FROM discussion_votes WHERE user_id = ?').run(userId);
        database.prepare('DELETE FROM notification_vote_actors WHERE actor_user_id = ?').run(userId);
        database.prepare('DELETE FROM notifications WHERE recipient_user_id = ?').run(userId);
        database.prepare('UPDATE notifications SET actor_user_id = NULL WHERE actor_user_id = ?').run(userId);
        database.prepare('DELETE FROM notification_preferences WHERE user_id = ?').run(userId);
        statements.revokeAllUserSessions.run(userId);
        if (user.avatar_storage_name) {
          enqueueFileDeletionInsideTransaction('avatar', user.avatar_storage_name, deletedAt);
        }
        database.prepare(`
          UPDATE users
          SET display_name = '已注销用户', password_hash = ?, bio = '',
              avatar_storage_name = NULL, avatar_media_type = NULL,
              status = 'disabled', governance_version = governance_version + 1,
              updated_at = ?, deleted_at = ?
          WHERE id = ?
        `).run(`disabled:${userId}:${deletedAt}`, deletedAt, deletedAt, userId);
        return {
          userId,
          username: user.username,
          avatarStorageName: user.avatar_storage_name ?? null,
          assets,
          deletedAt
        };
      });
    },
    createSession(session) {
      const tokenHash = requireSha256Hash(session.tokenHash, '会话令牌');
      const csrfTokenHash = requireSha256Hash(session.csrfTokenHash, 'CSRF 令牌');
      return inImmediateTransaction(() => {
        if (!statements.sessionEligibleUser.get(session.userId)) return null;
        statements.createSession.run(
          tokenHash,
          session.userId,
          csrfTokenHash,
          session.createdAt,
          session.expiresAt
        );
        return mapSession(statements.getSession.get(tokenHash));
      });
    },
    findSessionByTokenHash(tokenHash, nowIso = new Date().toISOString()) {
      if (!SHA256_HEX_PATTERN.test(tokenHash)) return null;
      return mapSession(statements.findSession.get(tokenHash, nowIso));
    },
    updateSessionCsrfToken(tokenHash, csrfTokenHash) {
      const checkedTokenHash = requireSha256Hash(tokenHash, '会话令牌');
      const checkedCsrfTokenHash = requireSha256Hash(csrfTokenHash, 'CSRF 令牌');
      return statements.updateSessionCsrfToken.run(checkedCsrfTokenHash, checkedTokenHash).changes;
    },
    revokeSession(tokenHash) {
      if (!SHA256_HEX_PATTERN.test(tokenHash)) return 0;
      return statements.revokeSession.run(tokenHash).changes;
    },
    revokeOtherSessions(userId, currentTokenHash) {
      const checkedTokenHash = requireSha256Hash(currentTokenHash, '当前会话令牌');
      return statements.revokeOtherSessions.run(userId, checkedTokenHash).changes;
    },
    revokeAllUserSessions(userId) {
      return statements.revokeAllUserSessions.run(userId).changes;
    },
    cleanupExpiredSessions(nowIso = new Date().toISOString()) {
      return statements.cleanupExpiredSessions.run(nowIso).changes;
    },
    health() {
      return statements.health.get().ok === 1;
    },
    close() {
      database.close();
    }
  };
}
