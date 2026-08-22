import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 2;
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

function migrate(database) {
  let version = database.prepare('PRAGMA user_version').get().user_version;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`数据库结构版本 ${version} 高于程序支持的版本 ${CURRENT_SCHEMA_VERSION}`);
  }
  if (version < 1) {
    migrateToV1(database);
    version = 1;
  }
  if (version < 2) migrateToV2(database);
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
    SELECT v.*, u.username AS account_username, u.display_name AS account_display_name
    FROM videos AS v
    LEFT JOIN users AS u ON u.id = v.user_id
  `;
  const discussionSelect = `
    SELECT d.*, u.username AS account_username, u.display_name AS account_display_name
    FROM discussions AS d
    LEFT JOIN users AS u ON u.id = d.user_id
  `;
  const sessionSelect = `
    SELECT
      s.*,
      u.username AS account_username,
      u.display_name AS account_display_name,
      u.created_at AS account_created_at
    FROM sessions AS s
    JOIN users AS u ON u.id = s.user_id
  `;

  const statements = {
    listVideos: database.prepare(`${videoSelect} WHERE v.validation_status IN ('ready', 'ready_with_warnings') ORDER BY v.created_at DESC, v.id DESC`),
    getVideo: database.prepare(`${videoSelect} WHERE v.id = ?`),
    insertVideo: database.prepare(`
      INSERT INTO videos (
        id, title, creator, description, license_code, storage_name, original_filename,
        media_type, byte_size, container, video_codec, audio_codec, playback_strategy,
        validation_status, sha256, duration_seconds, width, height, frame_rate,
        validation_warning_count, validation_summary, validation_started_at, validated_at,
        source_container, source_video_codec, source_audio_codec, ingest_operation,
        user_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    finishVideoValidationFailure: database.prepare(`
      UPDATE videos
      SET validation_status = ?, validation_warning_count = ?, validation_summary = ?, validated_at = ?
      WHERE id = ? AND validation_status = 'validating'
    `),
    allStorageNames: database.prepare('SELECT storage_name FROM videos'),
    listDiscussions: database.prepare(`${discussionSelect} WHERE d.video_id = ? ORDER BY d.created_at ASC, d.id ASC`),
    insertDiscussion: database.prepare(`
      INSERT INTO discussions (video_id, nickname, body_markdown, user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    getDiscussion: database.prepare(`${discussionSelect} WHERE d.id = ?`),
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
    listVideos() {
      return statements.listVideos.all().map(mapVideo);
    },
    getVideo(id) {
      return mapVideo(statements.getVideo.get(id));
    },
    insertVideo(video) {
      const container = video.container ?? (video.mediaType === 'video/webm' ? 'webm' : 'mp4');
      const validationStatus = video.validationStatus ?? 'ready';
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
        video.createdAt
      );
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
    listDiscussions(videoId) {
      return statements.listDiscussions.all(videoId).map(mapDiscussion);
    },
    insertDiscussion(discussion) {
      const result = statements.insertDiscussion.run(
        discussion.videoId,
        discussion.nickname,
        discussion.bodyMarkdown,
        discussion.userId ?? null,
        discussion.createdAt
      );
      return mapDiscussion(statements.getDiscussion.get(result.lastInsertRowid));
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
