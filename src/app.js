import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import multer from 'multer';

import {
  generateCsrfToken,
  generateSessionToken,
  hashCsrfToken,
  hashPassword,
  hashSessionToken,
  verifyCsrfToken,
  verifyPassword
} from './auth.js';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { AppError, ValidationError } from './errors.js';
import { getClientIp } from './ip.js';
import { getLicense, normalizeLicense } from './license.js';
import { renderMarkdown } from './markdown.js';
import {
  normalizeSourceFilename,
  validateCanonicalUploadHeader,
  validateCanonicalUploadMetadata
} from './media-upload.js';
import { DiscussionRateLimiter } from './rate-limit.js';
import {
  validateDiscussionBody,
  validateLoginFields,
  validateRegistrationFields,
  validateVideoFields
} from './validation.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, '..');
const SESSION_COOKIE = 'tongjian_session';
const CSRF_COOKIE = 'tongjian_csrf';

function readCookie(request, name) {
  const header = request.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function cookieValue(name, value, {
  maxAgeSeconds,
  secure = false,
  httpOnly = true
} = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax'
  ];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (Number.isInteger(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, maxAgeSeconds)}`);
  return parts.join('; ');
}

function appendCookie(response, value) {
  response.append('Set-Cookie', value);
}

function safeNextPath(value, fallback = '/') {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (
    candidate.length > 2048
    || !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) return fallback;
  return candidate;
}

function usableOpaqueToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

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

function pendingVideoPath(config, storageName) {
  if (typeof storageName !== 'string' || path.basename(storageName) !== storageName) {
    throw new AppError('视频存储记录无效', 500, 'INVALID_STORAGE_RECORD');
  }
  return path.join(config.pendingStoragePath, storageName);
}

function publicValidationStatus(status) {
  return ({
    pending: { label: '等待验证', terminal: false },
    validating: { label: '正在完整验证', terminal: false },
    ready: { label: '验证通过', terminal: true },
    ready_with_warnings: { label: '验证通过（有轻微警告）', terminal: true },
    rejected: { label: '媒体未通过验证', terminal: true },
    validation_failed: { label: '验证服务暂时失败', terminal: false }
  })[status] ?? { label: '未知状态', terminal: true };
}

function discussionView(discussion) {
  return {
    ...discussion,
    renderedBody: renderMarkdown(discussion.bodyMarkdown)
  };
}

export function createApp(options = {}) {
  const config = options.config ?? loadConfig(options.env, options.cwd);
  const now = options.now ?? (() => Date.now());
  const nowIso = () => new Date(now()).toISOString();
  fs.mkdirSync(config.videoStoragePath, { recursive: true });
  fs.mkdirSync(config.temporaryStoragePath, { recursive: true });
  fs.mkdirSync(config.pendingStoragePath, { recursive: true });
  const database = options.database ?? openDatabase(config.databasePath);
  const ownsDatabase = options.database === undefined;
  const rateLimiter = options.rateLimiter ?? new DiscussionRateLimiter({
    cooldownSeconds: config.discussionCooldownSeconds,
    now
  });
  const registrationLimiter = options.registrationLimiter ?? new DiscussionRateLimiter({
    cooldownSeconds: config.authCooldownSeconds,
    now
  });
  const loginLimiter = options.loginLimiter ?? new DiscussionRateLimiter({
    cooldownSeconds: config.authCooldownSeconds,
    now
  });
  database.cleanupExpiredSessions?.(nowIso());

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));

  app.use((_request, response, next) => {
    response.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'",
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
  app.use('/assets/mathlive', express.static(path.join(projectRoot, 'node_modules', 'mathlive'), {
    fallthrough: false,
    immutable: true,
    maxAge: '1y'
  }));
  app.get('/assets/mediabunny/mediabunny.min.mjs', (_request, response) => {
    response.type('text/javascript').sendFile(
      path.join(projectRoot, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs')
    );
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  const cookieMaxAgeSeconds = Math.floor(config.sessionTtlMs / 1000);
  const setCsrfCookie = (response, csrfToken) => {
    appendCookie(response, cookieValue(CSRF_COOKIE, csrfToken, {
      maxAgeSeconds: cookieMaxAgeSeconds,
      secure: config.sessionCookieSecure
    }));
  };
  const setSessionCookie = (response, sessionToken) => {
    appendCookie(response, cookieValue(SESSION_COOKIE, sessionToken, {
      maxAgeSeconds: cookieMaxAgeSeconds,
      secure: config.sessionCookieSecure
    }));
  };
  const clearAuthCookies = (response) => {
    appendCookie(response, cookieValue(SESSION_COOKIE, '', {
      maxAgeSeconds: 0,
      secure: config.sessionCookieSecure
    }));
    appendCookie(response, cookieValue(CSRF_COOKIE, '', {
      maxAgeSeconds: 0,
      secure: config.sessionCookieSecure
    }));
  };
  const createLoginSession = (response, user) => {
    const sessionToken = generateSessionToken();
    const csrfToken = generateCsrfToken();
    const createdAt = nowIso();
    const expiresAt = new Date(now() + config.sessionTtlMs).toISOString();
    database.cleanupExpiredSessions?.(createdAt);
    database.createSession({
      tokenHash: hashSessionToken(sessionToken),
      userId: user.id,
      csrfTokenHash: hashCsrfToken(csrfToken),
      createdAt,
      expiresAt
    });
    setSessionCookie(response, sessionToken);
    setCsrfCookie(response, csrfToken);
  };

  app.use((request, response, next) => {
    try {
      const rawSessionToken = readCookie(request, SESSION_COOKIE);
      const session = usableOpaqueToken(rawSessionToken)
        ? database.findSessionByTokenHash(hashSessionToken(rawSessionToken), nowIso())
        : null;
      if (rawSessionToken && !session) clearAuthCookies(response);

      request.authSession = session;
      request.currentUser = session?.user ?? null;
      let csrfToken = rawSessionToken && !session ? null : readCookie(request, CSRF_COOKIE);
      const csrfMatchesSession = session
        && usableOpaqueToken(csrfToken)
        && verifyCsrfToken(csrfToken, session.csrfTokenHash);

      if (session && !csrfMatchesSession) {
        csrfToken = generateCsrfToken();
        database.updateSessionCsrfToken(session.tokenHash, hashCsrfToken(csrfToken));
        request.authSession = { ...session, csrfTokenHash: hashCsrfToken(csrfToken) };
        setCsrfCookie(response, csrfToken);
      } else if (!session && !usableOpaqueToken(csrfToken)) {
        csrfToken = generateCsrfToken();
        setCsrfCookie(response, csrfToken);
      }

      request.csrfToken = csrfToken;
      response.locals.currentUser = request.currentUser;
      response.locals.csrfToken = csrfToken;
      // Dynamic pages contain user-specific navigation and CSRF form tokens.
      // Media responses explicitly replace this with their public cache policy.
      response.set('Cache-Control', 'no-store');
      next();
    } catch (error) {
      next(error);
    }
  });

  const assertCsrf = (request) => {
    const supplied = request.body?._csrf ?? request.get('x-csrf-token');
    const expectedHash = request.authSession?.csrfTokenHash ?? hashCsrfToken(request.csrfToken ?? '');
    if (!verifyCsrfToken(supplied, expectedHash)) {
      throw new AppError('页面凭证已失效，请刷新后重试', 403, 'INVALID_CSRF_TOKEN');
    }
  };

  const requireAuthentication = (request, response, next) => {
    if (request.currentUser) {
      next();
      return;
    }
    if (wantsJson(request)) {
      response.status(401).json({ error: '请先登录后再继续' });
      return;
    }
    const nextPath = safeNextPath(request.originalUrl);
    response.redirect(303, `/login?next=${encodeURIComponent(nextPath)}`);
  };

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, config.temporaryStoragePath),
      filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
    }),
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 16,
      fieldNameSize: 64,
      fieldSize: 32 * 1024
    }
  });

  const renderAuthError = (response, view, status, error, form, nextPath = '/') => {
    response.status(status).render(view, {
      form,
      error,
      nextPath: safeNextPath(nextPath)
    });
  };

  app.get('/register', (request, response) => {
    if (request.currentUser) {
      response.redirect(303, '/');
      return;
    }
    response.render('register', {
      form: {},
      error: '',
      nextPath: safeNextPath(request.query.next)
    });
  });

  app.post('/register', async (request, response, next) => {
    const nextPath = safeNextPath(request.body?.next);
    try {
      if (request.currentUser) {
        response.redirect(303, nextPath);
        return;
      }
      assertCsrf(request);
      const clientIp = getClientIp(request, config.clientIpMode);
      const limit = registrationLimiter.check(clientIp);
      if (!limit.allowed) {
        response.set('Retry-After', String(limit.retryAfterSeconds));
        renderAuthError(
          response,
          'register',
          429,
          `操作得有点快，请在 ${limit.retryAfterSeconds} 秒后再试。`,
          request.body,
          nextPath
        );
        return;
      }
      registrationLimiter.consume(clientIp);
      const fields = validateRegistrationFields(request.body);
      if (database.findUserByUsername(fields.username)) {
        renderAuthError(response, 'register', 409, '这个用户名已经被使用', request.body, nextPath);
        return;
      }
      const user = database.createUser({
        id: crypto.randomUUID(),
        username: fields.username,
        displayName: fields.displayName,
        passwordHash: await hashPassword(fields.password),
        createdAt: nowIso()
      });
      createLoginSession(response, user);
      response.redirect(303, nextPath);
    } catch (error) {
      if (error instanceof AppError) {
        renderAuthError(response, 'register', error.status, error.message, request.body ?? {}, nextPath);
        return;
      }
      if (String(error?.code).startsWith('SQLITE_CONSTRAINT')) {
        renderAuthError(response, 'register', 409, '这个用户名已经被使用', request.body ?? {}, nextPath);
        return;
      }
      next(error);
    }
  });

  app.get('/login', (request, response) => {
    if (request.currentUser) {
      response.redirect(303, '/');
      return;
    }
    response.render('login', {
      form: {},
      error: '',
      nextPath: safeNextPath(request.query.next)
    });
  });

  app.post('/login', async (request, response, next) => {
    const nextPath = safeNextPath(request.body?.next);
    try {
      if (request.currentUser) {
        response.redirect(303, nextPath);
        return;
      }
      assertCsrf(request);
      const clientIp = getClientIp(request, config.clientIpMode);
      const limit = loginLimiter.check(clientIp);
      if (!limit.allowed) {
        response.set('Retry-After', String(limit.retryAfterSeconds));
        renderAuthError(
          response,
          'login',
          429,
          `操作得有点快，请在 ${limit.retryAfterSeconds} 秒后再试。`,
          request.body,
          nextPath
        );
        return;
      }
      loginLimiter.consume(clientIp);
      const fields = validateLoginFields(request.body);
      const user = database.findUserByUsername(fields.username);
      const passwordMatches = user
        ? await verifyPassword(fields.password, user.passwordHash)
        : await hashPassword(fields.password).then(() => false);
      if (!user || !passwordMatches) {
        renderAuthError(response, 'login', 401, '用户名或密码不正确', request.body, nextPath);
        return;
      }
      createLoginSession(response, user);
      response.redirect(303, nextPath);
    } catch (error) {
      if (error instanceof AppError) {
        renderAuthError(response, 'login', error.status, error.message, request.body ?? {}, nextPath);
        return;
      }
      next(error);
    }
  });

  app.post('/logout', (request, response, next) => {
    try {
      assertCsrf(request);
      const rawSessionToken = readCookie(request, SESSION_COOKIE);
      if (usableOpaqueToken(rawSessionToken)) {
        database.revokeSession(hashSessionToken(rawSessionToken));
      }
      clearAuthCookies(response);
      response.redirect(303, '/');
    } catch (error) {
      next(error);
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

  app.get('/upload', requireAuthentication, (_request, response) => {
    response.render('upload', { form: {}, error: '', maxUploadMb: config.maxUploadMb });
  });

  app.post('/videos', requireAuthentication, (request, response, next) => {
    upload.single('video')(request, response, async (uploadError) => {
      let temporaryPath = request.file?.path;
      let stagedPath;
      try {
        if (uploadError) {
          const tooLarge = uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE';
          throw new AppError(
            tooLarge ? `视频不能超过 ${config.maxUploadMb} MiB` : '上传内容无法处理，请检查文件和表单字段',
            tooLarge ? 413 : 400,
            uploadError.code ?? 'UPLOAD_ERROR'
          );
        }
        assertCsrf(request);
        const fields = validateVideoFields(request.body);
        if (!request.file) throw new ValidationError('请选择一个视频文件', 'VIDEO_REQUIRED');
        const canonical = validateCanonicalUploadMetadata(request.file.originalname, request.file.mimetype);
        await validateCanonicalUploadHeader(temporaryPath, canonical.container);

        const license = normalizeLicense(request.body);
        const id = crypto.randomUUID();
        const storageName = `${crypto.randomUUID()}.${canonical.container}`;
        stagedPath = pendingVideoPath(config, storageName);
        await rename(temporaryPath, stagedPath);
        temporaryPath = undefined;

        try {
          database.insertVideo({
            id,
            userId: request.currentUser.id,
            ...fields,
            licenseCode: license.id,
            storageName,
            originalFilename: normalizeSourceFilename(request.body?.sourceFilename, request.file.originalname),
            mediaType: canonical.mediaType,
            byteSize: request.file.size,
            container: canonical.container,
            videoCodec: 'unknown',
            audioCodec: null,
            playbackStrategy: 'native',
            validationStatus: 'pending',
            validationSummary: {},
            sourceContainer: /^[a-z0-9-]{1,24}$/.test(request.body?.clientContainer ?? '') ? request.body.clientContainer : null,
            sourceVideoCodec: /^[a-z0-9-]{1,24}$/.test(request.body?.clientVideoCodec ?? '') ? request.body.clientVideoCodec : null,
            sourceAudioCodec: /^[a-z0-9-]{1,24}$/.test(request.body?.clientAudioCodec ?? '') ? request.body.clientAudioCodec : null,
            ingestOperation: ['direct', 'remux'].includes(request.body?.clientOperation) ? request.body.clientOperation : 'unknown',
            createdAt: nowIso()
          });
        } catch (error) {
          await safeUnlink(stagedPath);
          stagedPath = undefined;
          throw error;
        }

        const detailPath = `/videos/${id}`;
        if (wantsJson(request)) {
          response.status(202).json({
            id,
            status: 'pending',
            redirect: detailPath,
            statusUrl: `/api/videos/${id}/status`
          });
          return;
        }
        response.redirect(303, detailPath);
      } catch (error) {
        try {
          await safeUnlink(temporaryPath);
        } catch (cleanupError) {
          error.cleanupError = cleanupError;
          console.error('上传临时文件清理失败：', cleanupError);
        }
        if (error instanceof AppError) {
          if (wantsJson(request)) {
            response.status(error.status).json({ error: error.message, code: error.code });
            return;
          }
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
      const isReady = ['ready', 'ready_with_warnings'].includes(video.validationStatus);
      if (!isReady && request.currentUser?.id !== video.userId) {
        throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      }
      const license = getLicense(video.licenseCode);
      if (!license) throw new AppError('视频许可证记录无效', 500, 'INVALID_LICENSE_RECORD');
      const discussions = isReady ? database.listDiscussions(video.id).map(discussionView) : [];
      response.render('video', {
        video,
        license,
        discussions,
        validationStatus: publicValidationStatus(video.validationStatus),
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
      if (!['ready', 'ready_with_warnings'].includes(video.validationStatus)) {
        throw new AppError('视频仍在验证或未通过验证', 409, 'MEDIA_NOT_READY');
      }
      const filePath = publicVideoPath(config, video.storageName);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new AppError('视频文件不可用', 404, 'MEDIA_NOT_FOUND');
      const size = fileStat.size;
      const requestedRange = rangeForHeader(request.get('range'), size);

      response.set({
        'Accept-Ranges': 'bytes',
        'Content-Type': video.mediaType,
        'Cache-Control': response.hasHeader('Set-Cookie')
          ? 'private, no-store'
          : 'public, max-age=3600'
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

  app.get('/api/videos/:id/status', requireAuthentication, (request, response, next) => {
    try {
      const video = database.getVideo(request.params.id);
      if (!video || video.userId !== request.currentUser.id) {
        throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      }
      const status = publicValidationStatus(video.validationStatus);
      response.status(200).json({
        status: video.validationStatus,
        label: status.label,
        terminal: status.terminal,
        ready: ['ready', 'ready_with_warnings'].includes(video.validationStatus),
        warningCount: video.validationWarningCount
      });
    } catch (error) {
      next(error);
    }
  });

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

  app.post('/videos/:id/discussions', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const video = database.getVideo(request.params.id);
      if (!video) throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      if (!['ready', 'ready_with_warnings'].includes(video.validationStatus)) {
        throw new AppError('视频通过验证后才能参与讨论', 409, 'MEDIA_NOT_READY');
      }
      const bodyMarkdown = validateDiscussionBody(request.body?.body);
      renderMarkdown(bodyMarkdown);
      const clientIp = getClientIp(request, config.clientIpMode);
      const limits = [
        rateLimiter.check(`ip:${clientIp}`),
        rateLimiter.check(`user:${request.currentUser.id}`)
      ];
      const retryAfterSeconds = Math.max(...limits.map((limit) => limit.retryAfterSeconds));
      if (limits.some((limit) => !limit.allowed)) {
        const message = `发布得有点快，请在 ${retryAfterSeconds} 秒后再试。`;
        response.set('Retry-After', String(retryAfterSeconds));
        if (wantsJson(request)) {
          response.status(429).json({ error: message, retryAfterSeconds });
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
        userId: request.currentUser.id,
        nickname: request.currentUser.displayName,
        bodyMarkdown,
        createdAt: nowIso()
      });
      rateLimiter.consume(`ip:${clientIp}`);
      rateLimiter.consume(`user:${request.currentUser.id}`);

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
