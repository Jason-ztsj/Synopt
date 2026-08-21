import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 1;
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
    userId: row.user_id ?? null,
    accountUsername: row.account_username ?? null,
    accountDisplayName: row.account_display_name ?? null,
    createdAt: row.created_at
  };
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

function migrate(database) {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`数据库结构版本 ${version} 高于程序支持的版本 ${CURRENT_SCHEMA_VERSION}`);
  }

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
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
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
    listVideos: database.prepare(`${videoSelect} ORDER BY v.created_at DESC, v.id DESC`),
    getVideo: database.prepare(`${videoSelect} WHERE v.id = ?`),
    insertVideo: database.prepare(`
      INSERT INTO videos (id, title, creator, description, license_code, storage_name, original_filename, media_type, byte_size, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteVideo: database.prepare('DELETE FROM videos WHERE id = ?'),
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
        video.userId ?? null,
        video.createdAt
      );
      return this.getVideo(video.id);
    },
    deleteVideo(id) {
      return statements.deleteVideo.run(id).changes;
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
