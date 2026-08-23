import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 3;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function requireSha256Hash(value, name) {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
    throw new TypeError(`${name} 必须是 SHA-256 十六进制摘要`);
  }
  return value;
}

function mapVideo(row) {
  if (!row) return null;
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
    userId: row.user_id ?? null,
    accountUsername: row.account_username ?? null,
    accountDisplayName: row.account_display_name ?? null,
    categoryId: row.category_id ?? null,
    categorySlug: row.category_slug ?? null,
    categoryName: row.category_name ?? null,
    coverStorageName: row.cover_storage_name ?? null,
    coverMediaType: row.cover_media_type ?? null,
    coverSource: row.cover_source ?? null,
    visibility: row.visibility ?? 'public',
    moderationStatus: row.moderation_status ?? 'visible',
    tags: typeof row.tag_list === 'string' && row.tag_list
      ? row.tag_list.split('\u001f').map((entry) => {
        const [slug, name] = entry.split('\u001e');
        return { slug, name };
      }).filter((entry) => entry.slug && entry.name)
      : [],
    upvoteCount: row.upvote_count ?? 0,
    downvoteCount: row.downvote_count ?? 0,
    viewerVote: row.viewer_vote ?? 0,
    createdAt: row.created_at
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
  return {
    id: row.id,
    videoId: row.video_id,
    nickname: row.nickname,
    bodyMarkdown: row.body_markdown,
    userId: row.user_id ?? null,
    accountUsername: row.account_username ?? null,
    accountDisplayName: row.account_display_name ?? null,
    title: row.title ?? null,
    parentId: row.parent_id ?? null,
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null,
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
    role: row.role ?? 'member',
    status: row.status ?? 'active',
    createdAt: row.created_at
  };
}

function mapSession(row) {
  if (!row) return null;
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    csrfTokenHash: row.csrf_token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      username: row.account_username,
      displayName: row.account_display_name,
      role: row.account_role ?? 'member',
      status: row.account_status ?? 'active',
      createdAt: row.account_created_at
    }
  };
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info('${table}')`).all().some((entry) => entry.name === column);
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
  if (version < 3) migrateToV3(database);
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
      u.username AS account_username,
      u.display_name AS account_display_name,
      c.slug AS category_slug,
      c.name AS category_name,
      (
        SELECT group_concat(tag_row.slug || char(30) || tag_row.name, char(31))
        FROM (
          SELECT t.slug, t.name
          FROM video_tags AS vt
          JOIN tags AS t ON t.id = vt.tag_id
          WHERE vt.video_id = v.id
          ORDER BY vt.sort_order ASC, t.id ASC
        ) AS tag_row
      ) AS tag_list,
      (SELECT count(*) FROM video_votes AS vv WHERE vv.video_id = v.id AND vv.value = 1) AS upvote_count,
      (SELECT count(*) FROM video_votes AS vv WHERE vv.video_id = v.id AND vv.value = -1) AS downvote_count
    FROM videos AS v
    LEFT JOIN users AS u ON u.id = v.user_id
    LEFT JOIN categories AS c ON c.id = v.category_id
  `;
  const discussionSelect = `
    SELECT
      d.*,
      u.username AS account_username,
      u.display_name AS account_display_name,
      (SELECT count(*) FROM discussion_votes AS dv WHERE dv.discussion_id = d.id AND dv.value = 1) AS upvote_count,
      (SELECT count(*) FROM discussion_votes AS dv WHERE dv.discussion_id = d.id AND dv.value = -1) AS downvote_count
    FROM discussions AS d
    LEFT JOIN users AS u ON u.id = d.user_id
  `;
  const sessionSelect = `
    SELECT
      s.*,
      u.username AS account_username,
      u.display_name AS account_display_name,
      u.role AS account_role,
      u.status AS account_status,
      u.created_at AS account_created_at
    FROM sessions AS s
    JOIN users AS u ON u.id = s.user_id
  `;

  const statements = {
    listVideos: database.prepare(`${videoSelect} WHERE v.validation_status IN ('ready', 'ready_with_warnings') AND v.visibility = 'public' AND v.moderation_status = 'visible' ORDER BY v.created_at DESC, v.id DESC`),
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
    nextPendingVideo: database.prepare(`${videoSelect} WHERE v.validation_status = 'pending' ORDER BY v.created_at ASC, v.id ASC LIMIT 1`),
    markVideoValidating: database.prepare(`
      UPDATE videos
      SET validation_status = 'validating', validation_started_at = ?, validation_summary = '{}'
      WHERE id = ? AND validation_status = 'pending'
    `),
    resetStaleValidations: database.prepare(`
      UPDATE videos
      SET validation_status = 'pending', validation_started_at = NULL
      WHERE validation_status = 'validating' AND validation_started_at < ?
    `),
    retryFailedValidations: database.prepare(`
      UPDATE videos
      SET validation_status = 'pending', validation_started_at = NULL
      WHERE validation_status = 'validation_failed'
    `),
    completeVideoValidation: database.prepare(`
      UPDATE videos
      SET media_type = ?, container = ?, video_codec = ?, audio_codec = ?, playback_strategy = ?,
          sha256 = ?, duration_seconds = ?, width = ?, height = ?, frame_rate = ?,
          validation_status = ?, validation_warning_count = ?, validation_summary = ?, validated_at = ?
      WHERE id = ? AND validation_status = 'validating'
    `),
    setVideoCover: database.prepare(`
      UPDATE videos SET cover_storage_name = ?, cover_media_type = ?, cover_source = ? WHERE id = ?
    `),
    finishVideoValidationFailure: database.prepare(`
      UPDATE videos
      SET validation_status = ?, validation_warning_count = ?, validation_summary = ?, validated_at = ?
      WHERE id = ? AND validation_status = 'validating'
    `),
    allStorageNames: database.prepare('SELECT storage_name FROM videos'),
    allCoverStorageNames: database.prepare('SELECT cover_storage_name FROM videos WHERE cover_storage_name IS NOT NULL'),
    videosMissingCover: database.prepare(`${videoSelect} WHERE v.cover_storage_name IS NULL AND v.validation_status IN ('ready', 'ready_with_warnings') ORDER BY v.created_at ASC, v.id ASC`),
    listDiscussions: database.prepare(`${discussionSelect} WHERE d.video_id = ? ORDER BY d.created_at ASC, d.id ASC`),
    insertDiscussion: database.prepare(`
      INSERT INTO discussions (video_id, nickname, body_markdown, user_id, title, parent_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getDiscussion: database.prepare(`${discussionSelect} WHERE d.id = ?`),
    listCategories: database.prepare(`
      SELECT c.*, p.slug AS parent_slug, p.name AS parent_name,
        (SELECT count(*) FROM videos AS v WHERE (v.category_id = c.id OR v.category_id IN (SELECT child.id FROM categories AS child WHERE child.parent_id = c.id)) AND v.validation_status IN ('ready', 'ready_with_warnings') AND v.visibility = 'public' AND v.moderation_status = 'visible') AS video_count
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
      WHERE v.validation_status IN ('ready', 'ready_with_warnings') AND v.visibility = 'public' AND v.moderation_status = 'visible'
      GROUP BY t.id, t.slug, t.name
      ORDER BY video_count DESC, t.name COLLATE NOCASE ASC
    `),
    getTagBySlug: database.prepare('SELECT * FROM tags WHERE slug = ? COLLATE NOCASE'),
    insertTag: database.prepare('INSERT INTO tags (slug, name, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING'),
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
      INSERT INTO users (id, username, display_name, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    getUserById: database.prepare('SELECT * FROM users WHERE id = ?'),
    findUserByUsername: database.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
    createSession: database.prepare(`
      INSERT INTO sessions (token_hash, user_id, csrf_token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    getSession: database.prepare(`${sessionSelect} WHERE s.token_hash = ?`),
    findSession: database.prepare(`${sessionSelect} WHERE s.token_hash = ? AND s.expires_at > ?`),
    updateSessionCsrfToken: database.prepare('UPDATE sessions SET csrf_token_hash = ? WHERE token_hash = ?'),
    revokeSession: database.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    cleanupExpiredSessions: database.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    health: database.prepare('SELECT 1 AS ok')
  };

  return {
    raw: database,
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
        "v.moderation_status = 'visible'"
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
            WHERE search_vt.video_id = v.id AND search_t.name LIKE ? ESCAPE '\\' COLLATE NOCASE
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
          WHERE filter_vt.video_id = v.id AND filter_t.slug = ? COLLATE NOCASE
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
          statements.insertTag.run(tag.slug, tag.name, video.userId ?? null, video.createdAt);
          const storedTag = statements.getTagBySlug.get(tag.slug);
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
    completeVideoValidation(id, result, validatedAt) {
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
        id
      ).changes;
    },
    setVideoCover(id, { storageName, mediaType, source }) {
      return statements.setVideoCover.run(storageName, mediaType, source, id).changes;
    },
    rejectVideoValidation(id, summary, validatedAt, warningCount = 0) {
      return statements.finishVideoValidationFailure.run(
        'rejected', warningCount, JSON.stringify(summary ?? {}), validatedAt, id
      ).changes;
    },
    failVideoValidation(id, summary, validatedAt) {
      return statements.finishVideoValidationFailure.run(
        'validation_failed', 0, JSON.stringify(summary ?? {}), validatedAt, id
      ).changes;
    },
    listVideoStorageNames() {
      return statements.allStorageNames.all().map((row) => row.storage_name);
    },
    listCoverStorageNames() {
      return statements.allCoverStorageNames.all().map((row) => row.cover_storage_name);
    },
    listVideosMissingCover() {
      return statements.videosMissingCover.all().map(mapVideo);
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
      const result = statements.insertDiscussion.run(
        discussion.videoId,
        discussion.nickname,
        discussion.bodyMarkdown,
        discussion.userId ?? null,
        discussion.title ?? null,
        discussion.parentId ?? null,
        discussion.createdAt
      );
      return mapDiscussion(statements.getDiscussion.get(result.lastInsertRowid));
    },
    getDiscussion(id, viewerUserId = null) {
      const discussion = mapDiscussion(statements.getDiscussion.get(id));
      if (discussion && viewerUserId) {
        discussion.viewerVote = statements.getDiscussionVote.get(id, viewerUserId)?.value ?? 0;
      }
      return discussion;
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
      return row ? { id: row.id, slug: row.slug, name: row.name } : null;
    },
    setVideoVote(videoId, userId, value, changedAt) {
      if (value === 0) statements.deleteVideoVote.run(videoId, userId);
      else statements.upsertVideoVote.run(videoId, userId, value, changedAt, changedAt);
      return this.getVideo(videoId, userId);
    },
    setDiscussionVote(discussionId, userId, value, changedAt) {
      if (value === 0) statements.deleteDiscussionVote.run(discussionId, userId);
      else statements.upsertDiscussionVote.run(discussionId, userId, value, changedAt, changedAt);
      return this.getDiscussion(discussionId, userId);
    },
    createUser(user) {
      statements.createUser.run(
        user.id,
        user.username,
        user.displayName,
        user.passwordHash,
        user.createdAt
      );
      return mapUser(statements.getUserById.get(user.id));
    },
    getUserById(id) {
      return mapUser(statements.getUserById.get(id));
    },
    findUserByUsername(username) {
      return mapUser(statements.findUserByUsername.get(username));
    },
    createSession(session) {
      const tokenHash = requireSha256Hash(session.tokenHash, '会话令牌');
      const csrfTokenHash = requireSha256Hash(session.csrfTokenHash, 'CSRF 令牌');
      statements.createSession.run(
        tokenHash,
        session.userId,
        csrfTokenHash,
        session.createdAt,
        session.expiresAt
      );
      return mapSession(statements.getSession.get(tokenHash));
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
