import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import multer from 'multer';

import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { AppError, ValidationError } from './errors.js';
import { getClientIp } from './ip.js';
import { getLicense, normalizeLicense } from './license.js';
import { renderMarkdown } from './markdown.js';
import { validateMp4File, validateMp4Metadata } from './mp4.js';
import { randomNickname } from './nickname.js';
import { DiscussionRateLimiter } from './rate-limit.js';
import { validateDiscussionBody, validateVideoFields } from './validation.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, '..');

function wantsJson(request) {
  return request.get('accept')?.includes('application/json')
    || request.get('x-requested-with') === 'XMLHttpRequest';
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function rangeForHeader(header, size) {
  if (!header) return null;
  if (typeof header !== 'string' || header.includes(',')) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return false;

  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
    if (start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

function publicVideoPath(config, storageName) {
  if (typeof storageName !== 'string' || path.basename(storageName) !== storageName) {
    throw new AppError('视频存储记录无效', 500, 'INVALID_STORAGE_RECORD');
  }
  return path.join(config.videoStoragePath, storageName);
}

function discussionView(discussion) {
  return {
    ...discussion,
    renderedBody: renderMarkdown(discussion.bodyMarkdown)
  };
}

export function createApp(options = {}) {
  const config = options.config ?? loadConfig(options.env, options.cwd);
  fs.mkdirSync(config.videoStoragePath, { recursive: true });
  fs.mkdirSync(config.temporaryStoragePath, { recursive: true });
  const database = options.database ?? openDatabase(config.databasePath);
  const ownsDatabase = options.database === undefined;
  const rateLimiter = options.rateLimiter ?? new DiscussionRateLimiter({
    cooldownSeconds: config.discussionCooldownSeconds,
    now: options.now
  });
  const nicknameFactory = options.nicknameFactory ?? randomNickname;

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));

  app.use((_request, response, next) => {
    response.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    next();
  });

  app.use('/static', express.static(path.join(projectRoot, 'public'), { fallthrough: false, maxAge: '1h' }));
  app.use('/assets/katex', express.static(path.join(projectRoot, 'node_modules', 'katex', 'dist'), {
    fallthrough: false,
    immutable: true,
    maxAge: '1y'
  }));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, config.temporaryStoragePath),
      filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
    }),
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 8,
      fieldNameSize: 64,
      fieldSize: 32 * 1024
    }
  });

  app.get('/healthz', (_request, response, next) => {
    try {
      if (!database.health()) throw new Error('数据库健康检查失败');
      response.status(200).json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/', (_request, response, next) => {
    try {
      const videos = database.listVideos().map((video) => ({
        ...video,
        licenseLabel: getLicense(video.licenseCode)?.code ?? video.licenseCode
      }));
      response.render('index', { videos });
    } catch (error) {
      next(error);
    }
  });

  app.get('/upload', (_request, response) => {
    response.render('upload', { form: {}, error: '', maxUploadMb: config.maxUploadMb });
  });

  app.post('/videos', (request, response, next) => {
    upload.single('video')(request, response, async (uploadError) => {
      let temporaryPath = request.file?.path;
      let finalPath;
      try {
        if (uploadError) {
          const tooLarge = uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE';
          throw new AppError(
            tooLarge ? `视频不能超过 ${config.maxUploadMb} MiB` : '上传内容无法处理，请检查文件和表单字段',
            tooLarge ? 413 : 400,
            uploadError.code ?? 'UPLOAD_ERROR'
          );
        }
        const fields = validateVideoFields(request.body);
        if (!request.file) throw new ValidationError('请选择一个 MP4 视频文件', 'VIDEO_REQUIRED');
        validateMp4Metadata(request.file.originalname, request.file.mimetype);
        await validateMp4File(temporaryPath);

        const license = normalizeLicense(request.body);
        const id = crypto.randomUUID();
        const storageName = `${crypto.randomUUID()}.mp4`;
        finalPath = publicVideoPath(config, storageName);
        await rename(temporaryPath, finalPath);
        temporaryPath = undefined;

        try {
          database.insertVideo({
            id,
            ...fields,
            licenseCode: license.id,
            storageName,
            originalFilename: request.file.originalname,
            mediaType: 'video/mp4',
            byteSize: request.file.size,
            createdAt: new Date().toISOString()
          });
        } catch (error) {
          await safeUnlink(finalPath);
          finalPath = undefined;
          throw error;
        }

        response.redirect(303, `/videos/${id}`);
      } catch (error) {
        try {
          await safeUnlink(temporaryPath);
        } catch (cleanupError) {
          error.cleanupError = cleanupError;
          console.error('上传临时文件清理失败：', cleanupError);
        }
        if (error instanceof AppError) {
          response.status(error.status).render('upload', {
            form: request.body ?? {},
            error: error.message,
            maxUploadMb: config.maxUploadMb
          });
          return;
        }
        next(error);
      }
    });
  });

  app.get('/videos/:id', (request, response, next) => {
    try {
      const video = database.getVideo(request.params.id);
      if (!video) throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      const license = getLicense(video.licenseCode);
      if (!license) throw new AppError('视频许可证记录无效', 500, 'INVALID_LICENSE_RECORD');
      const discussions = database.listDiscussions(video.id).map(discussionView);
      response.render('video', {
        video,
        license,
        discussions,
        discussionError: '',
        discussionCooldownSeconds: config.discussionCooldownSeconds
      });
    } catch (error) {
      next(error);
    }
  });

  const serveMedia = async (request, response, next) => {
    try {
      const video = database.getVideo(request.params.id);
      if (!video) throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      const filePath = publicVideoPath(config, video.storageName);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new AppError('视频文件不可用', 404, 'MEDIA_NOT_FOUND');
      const size = fileStat.size;
      const requestedRange = rangeForHeader(request.get('range'), size);

      response.set({
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=3600'
      });
      if (requestedRange === false) {
        response.status(416).set({ 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }).end();
        return;
      }
      if (requestedRange) {
        response.status(206).set({
          'Content-Range': `bytes ${requestedRange.start}-${requestedRange.end}/${size}`,
          'Content-Length': String(requestedRange.length)
        });
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        await pipeline(
          createReadStream(filePath, { start: requestedRange.start, end: requestedRange.end }),
          response
        );
        return;
      }
      response.status(200).set('Content-Length', String(size));
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      await pipeline(createReadStream(filePath), response);
    } catch (error) {
      if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE' && (request.aborted || response.destroyed)) return;
      if (error?.code === 'ENOENT') next(new AppError('视频文件不可用', 404, 'MEDIA_NOT_FOUND'));
      else next(error);
    }
  };

  app.route('/videos/:id/media').get(serveMedia).head(serveMedia);

  app.post('/api/markdown-preview', (request, response, next) => {
    try {
      const body = validateDiscussionBody(request.body?.body ?? request.body?.markdown);
      response.status(200).json({ html: renderMarkdown(body) });
    } catch (error) {
      if (error instanceof AppError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post('/videos/:id/discussions', (request, response, next) => {
    try {
      const video = database.getVideo(request.params.id);
      if (!video) throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      const bodyMarkdown = validateDiscussionBody(request.body?.body);
      renderMarkdown(bodyMarkdown);
      const clientIp = getClientIp(request, config.clientIpMode);
      const limit = rateLimiter.check(clientIp);
      if (!limit.allowed) {
        const message = `发布得有点快，请在 ${limit.retryAfterSeconds} 秒后再试。`;
        response.set('Retry-After', String(limit.retryAfterSeconds));
        if (wantsJson(request)) {
          response.status(429).json({ error: message, retryAfterSeconds: limit.retryAfterSeconds });
          return;
        }
        const discussions = database.listDiscussions(video.id).map(discussionView);
        response.status(429).render('video', {
          video,
          license: getLicense(video.licenseCode),
          discussions,
          discussionError: message,
          discussionCooldownSeconds: config.discussionCooldownSeconds
        });
        return;
      }

      const discussion = database.insertDiscussion({
        videoId: video.id,
        nickname: nicknameFactory(),
        bodyMarkdown,
        createdAt: new Date().toISOString()
      });
      rateLimiter.consume(clientIp);

      if (wantsJson(request)) {
        response.status(201).json({
          ok: true,
          discussion: discussionView(discussion),
          redirect: `/videos/${video.id}#discussion-${discussion.id}`
        });
        return;
      }
      response.redirect(303, `/videos/${video.id}#discussion-list`);
    } catch (error) {
      if (error instanceof AppError && wantsJson(request)) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.use((_request, _response, next) => next(new AppError('找不到这个页面', 404, 'NOT_FOUND')));

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const bodyTooLarge = error?.type === 'entity.too.large';
    const status = bodyTooLarge ? 413 : (Number.isInteger(error?.status) ? error.status : 500);
    const publicMessage = bodyTooLarge
      ? '请求内容过大'
      : (status < 500 ? error.message : '服务暂时无法完成这个请求，请稍后再试。');
    if (status >= 500) console.error(error);
    if (wantsJson(request) || request.path.startsWith('/api/')) {
      response.status(status).json({ error: publicMessage });
      return;
    }
    response.status(status).render('error', {
      status,
      title: status === 404 ? '这里没有这段影像' : (status === 413 ? '上传内容太大' : '放映暂时中断'),
      message: publicMessage
    });
  });

  app.locals.database = database;
  app.locals.config = config;
  app.locals.rateLimiter = rateLimiter;
  app.close = () => {
    if (ownsDatabase) database.close();
  };
  return app;
}

export async function startServer(options = {}) {
  const app = options.app ?? createApp(options);
  const port = options.port ?? app.locals.config.port;
  const host = options.host ?? '0.0.0.0';
  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(port, host, () => resolve(listeningServer));
    listeningServer.once('error', reject);
  });
  return {
    app,
    server,
    address: server.address(),
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      app.close?.();
    }
  };
}

export { rangeForHeader };
