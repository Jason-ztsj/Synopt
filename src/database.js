import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
    createdAt: row.created_at
  };
}

function mapDiscussion(row) {
  return {
    id: row.id,
    videoId: row.video_id,
    nickname: row.nickname,
    bodyMarkdown: row.body_markdown,
    createdAt: row.created_at
  };
}

export function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
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
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS discussions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL,
      body_markdown TEXT NOT NULL CHECK (length(body_markdown) BETWEEN 1 AND 5000),
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  database.exec('CREATE INDEX IF NOT EXISTS idx_videos_created_at_id ON videos(created_at DESC, id DESC)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_discussions_video_created_at_id ON discussions(video_id, created_at ASC, id ASC)');
  database.exec('PRAGMA optimize');

  const statements = {
    listVideos: database.prepare('SELECT * FROM videos ORDER BY created_at DESC, id DESC'),
    getVideo: database.prepare('SELECT * FROM videos WHERE id = ?'),
    insertVideo: database.prepare(`
      INSERT INTO videos (id, title, creator, description, license_code, storage_name, original_filename, media_type, byte_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteVideo: database.prepare('DELETE FROM videos WHERE id = ?'),
    listDiscussions: database.prepare('SELECT * FROM discussions WHERE video_id = ? ORDER BY created_at ASC, id ASC'),
    insertDiscussion: database.prepare(`
      INSERT INTO discussions (video_id, nickname, body_markdown, created_at)
      VALUES (?, ?, ?, ?)
    `),
    getDiscussion: database.prepare('SELECT * FROM discussions WHERE id = ?'),
    health: database.prepare('SELECT 1 AS ok')
  };

  return {
    raw: database,
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
        discussion.createdAt
      );
      return mapDiscussion(statements.getDiscussion.get(result.lastInsertRowid));
    },
    health() {
      return statements.health.get().ok === 1;
    },
    close() {
      database.close();
    }
  };
}
