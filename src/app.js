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
  normalizeUsername,
  verifyCsrfToken,
  verifyPassword
} from './auth.js';
import { loadConfig } from './config.js';
import { AVATAR_RULES, validateAvatarImage } from './avatar-image.js';
import { CapacityGate } from './capacity-gate.js';
import { validateCoverImage } from './cover-image.js';
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
  validateDiscussionTitle,
  validateCategorySlug,
  validateTags,
  validateVoteValue,
  validateLoginFields,
  validatePassword,
  validateProfileFields,
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

function pageNumber(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 1;
}

function checked(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').toLowerCase());
}

function positiveDiscussionId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

async function removeVideoAssets(config, assets) {
  for (const asset of assets ?? []) {
    const candidates = [];
    if (asset?.storageName) {
      // Delete the quarantined source before the public target. This ordering
      // closes the validator's pending -> public rename race: either the rename
      // already happened and the public file is removed next, or removing the
      // pending name makes the later rename fail.
      candidates.push(pendingVideoPath(config, asset.storageName));
      candidates.push(publicVideoPath(config, asset.storageName));
    }
    if (asset?.coverStorageName) candidates.push(coverPath(config, asset.coverStorageName));
    for (const candidate of candidates) {
      try {
        await safeUnlink(candidate);
      } catch (error) {
        console.error(`永久删除媒体文件失败：${candidate}`, error);
      }
    }
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

function coverPath(config, storageName) {
  if (typeof storageName !== 'string' || path.basename(storageName) !== storageName) {
    throw new AppError('封面存储记录无效', 500, 'INVALID_COVER_RECORD');
  }
  return path.join(config.coverStoragePath, storageName);
}

function avatarPath(config, storageName) {
  if (typeof storageName !== 'string' || path.basename(storageName) !== storageName) {
    throw new AppError('头像存储记录无效', 500, 'INVALID_AVATAR_RECORD');
  }
  return path.join(config.avatarStoragePath, storageName);
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

function buildDiscussionTree(discussions) {
  const nodes = new Map(discussions.map((discussion) => [discussion.id, { ...discussion, replies: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

function categoryTree(categories) {
  const byId = new Map(categories.map((category) => [category.id, { ...category, children: [] }]));
  const roots = [];
  for (const category of byId.values()) {
    const parent = category.parentId ? byId.get(category.parentId) : null;
    if (parent) parent.children.push(category);
    else roots.push(category);
  }
  return roots;
}

function discussionTitleFromBody(body) {
  return body
    .replace(/[`*_>#\[\]$]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '未命名讨论';
}

function paginationView(result, page) {
  const total = Number(result?.total) || 0;
  const limit = Number(result?.limit) || 20;
  return {
    page,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasPrevious: page > 1,
    hasNext: page * limit < total
  };
}

function notificationView(notification) {
  const base = {
    id: notification.id,
    type: notification.type,
    count: notification.count,
    isRead: notification.isRead,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
    readAt: notification.readAt
  };
  const actor = notification.actorDisplayName || '已注销用户';
  const videoTitle = notification.videoTitle || '相关作品';
  if (notification.type === 'reply') {
    const summary = `来自《${videoTitle}》的讨论`;
    const link = notification.videoId && notification.discussionId
      ? `/videos/${notification.videoId}#discussion-${notification.discussionId}`
      : '/account/discussions';
    return {
      ...base,
      actorDisplayName: actor,
      title: `${actor} 回复了你的讨论`,
      summary,
      body: summary,
      link,
      url: link
    };
  }
  if (notification.type === 'video_upvote' || notification.type === 'video_downvote') {
    const label = notification.type === 'video_upvote' ? '认同' : '反对';
    const summary = '投票者身份不会公开';
    const link = notification.videoId ? `/videos/${notification.videoId}` : '/account/videos';
    return {
      ...base,
      title: `《${videoTitle}》新增 ${notification.count} 个${label}`,
      summary,
      body: summary,
      link,
      url: link
    };
  }
  const link = safeNextPath(notification.systemLink, '/account/notifications');
  return {
    ...base,
    title: notification.systemTitle || '系统通知',
    summary: notification.systemBody || '',
    body: notification.systemBody || '',
    link,
    url: link
  };
}

export function createApp(options = {}) {
  const config = options.config ?? loadConfig(options.env, options.cwd);
  const now = options.now ?? (() => Date.now());
  const nowIso = () => new Date(now()).toISOString();
  fs.mkdirSync(config.videoStoragePath, { recursive: true });
  fs.mkdirSync(config.temporaryStoragePath, { recursive: true });
  fs.mkdirSync(config.pendingStoragePath, { recursive: true });
  fs.mkdirSync(config.coverStoragePath, { recursive: true });
  fs.mkdirSync(config.avatarStoragePath, { recursive: true });
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
  const imageNormalizationLimiter = options.imageNormalizationLimiter ?? new DiscussionRateLimiter({
    cooldownSeconds: config.imageNormalizationCooldownSeconds,
    now
  });
  const imageNormalizationGate = options.imageNormalizationGate ?? new CapacityGate({
    limit: config.imageNormalizationConcurrency,
    cooldownSeconds: config.imageNormalizationCooldownSeconds
  });
  database.cleanupExpiredSessions?.(nowIso());

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));

  app.use((request, response, next) => {
    const securityHeaders = {
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    };
    if (request.secure) securityHeaders['Cross-Origin-Opener-Policy'] = 'same-origin';
    response.set(securityHeaders);
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
    const session = database.createSession({
      tokenHash: hashSessionToken(sessionToken),
      userId: user.id,
      csrfTokenHash: hashCsrfToken(csrfToken),
      createdAt,
      expiresAt
    });
    if (!session) {
      throw new AppError('账号状态已经变化，请重新登录', 409, 'ACCOUNT_SESSION_CONFLICT');
    }
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
      response.locals.notificationUnreadCount = request.currentUser
        ? (database.getUnreadNotificationCount?.(request.currentUser.id) ?? 0)
        : 0;
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

  const normalizeUploadedImage = async (request, response, action) => {
    const clientIp = getClientIp(request, config.clientIpMode);
    const keys = [
      `image:user:${request.currentUser.id}`,
      `image:ip:${clientIp}`
    ];
    const limits = keys.map((key) => imageNormalizationLimiter.check(key));
    const retryAfterSeconds = Math.max(...limits.map((limit) => limit.retryAfterSeconds));
    if (limits.some((limit) => !limit.allowed)) {
      response.set('Retry-After', String(retryAfterSeconds));
      throw new AppError(
        `图片处理得有点快，请在 ${retryAfterSeconds} 秒后重试`,
        429,
        'IMAGE_NORMALIZATION_RATE_LIMITED'
      );
    }
    keys.forEach((key) => imageNormalizationLimiter.consume(key));
    try {
      return await imageNormalizationGate.run(action);
    } catch (error) {
      if (Number.isSafeInteger(error?.retryAfterSeconds)) {
        response.set('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }
  };

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, config.temporaryStoragePath),
      filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
    }),
    limits: {
      fileSize: config.maxUploadBytes,
      files: 2,
      fields: 16,
      fieldNameSize: 64,
      fieldSize: 32 * 1024
    }
  });

  const avatarUpload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, config.temporaryStoragePath),
      filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.avatar-upload`)
    }),
    limits: {
      fileSize: AVATAR_RULES.maxBytes,
      files: 1,
      fields: 8,
      fieldNameSize: 64,
      fieldSize: 8 * 1024
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

  const catalogLocals = () => {
    const categories = database.listCategories();
    return { categories, categoryTree: categoryTree(categories), popularTags: database.listTags().slice(0, 16) };
  };

  const renderVideoListing = (request, response, next, overrides = {}) => {
    try {
      const query = String(overrides.query ?? request.query.q ?? '').trim().slice(0, 120);
      const categorySlug = String(overrides.categorySlug ?? request.query.category ?? '').trim().slice(0, 48);
      const tagSlug = String(overrides.tagSlug ?? request.query.tag ?? '').trim().slice(0, 48);
      const videos = database.listVideos({ query, categorySlug, tagSlug }).map((video) => ({
        ...video,
        licenseLabel: getLicense(video.licenseCode)?.code ?? video.licenseCode
      }));
      response.render('index', {
        videos,
        filters: { query, categorySlug, tagSlug },
        listingTitle: overrides.listingTitle ?? (query ? `“${query}”的搜索结果` : '最近发布'),
        ...catalogLocals()
      });
    } catch (error) {
      next(error);
    }
  };

  app.get('/', (request, response, next) => renderVideoListing(request, response, next));
  app.get('/search', (request, response, next) => renderVideoListing(request, response, next));
  app.get('/categories/:slug', (request, response, next) => {
    const category = database.getCategoryBySlug(request.params.slug);
    if (!category) {
      next(new AppError('找不到这个分类', 404, 'CATEGORY_NOT_FOUND'));
      return;
    }
    renderVideoListing(request, response, next, { categorySlug: category.slug, listingTitle: category.name });
  });
  app.get('/tags/:slug', (request, response, next) => {
    const tag = database.getTagBySlug(request.params.slug);
    if (!tag) {
      next(new AppError('找不到这个标签', 404, 'TAG_NOT_FOUND'));
      return;
    }
    renderVideoListing(request, response, next, { tagSlug: tag.slug, listingTitle: `#${tag.name}` });
  });
  app.get('/categories', (_request, response) => response.render('categories', catalogLocals()));
  app.get('/tags', (_request, response) => response.render('tags', catalogLocals()));
  app.get('/about', (_request, response) => response.render('about', catalogLocals()));
  app.get('/algorithm', (_request, response) => response.render('algorithm', catalogLocals()));

  const accountFlash = (value) => ({
    profile: '个人资料已更新。',
    avatarRemoved: '头像已移除。',
    password: '密码已更新，其他设备上的登录会话已经退出。',
    notifications: '通知偏好已保存。',
    withdrawn: '稿件已撤回，只有你可以查看。',
    republished: '稿件已重新公开。',
    deleted: '稿件媒体已永久删除，已有讨论保留为档案。',
    discussionEdited: '讨论已更新。',
    discussionDeleted: '讨论已删除。'
  })[value] ?? '';

  const accountBaseLocals = (request, extra = {}) => ({
    ...catalogLocals(),
    currentPath: request.path,
    flash: accountFlash(request.query.saved),
    error: '',
    ...extra
  });

  const freshAccount = (request) => database.getUserById(request.currentUser.id);
  const accountStats = (account) => database.getPublicUserProfile(account.username) ?? {
    videoCount: 0,
    discussionCount: 0,
    receivedUpvoteCount: 0,
    receivedDownvoteCount: 0
  };

  const renderAccountProfile = (request, response, { status = 200, error = '', form = null } = {}) => {
    const account = freshAccount(request);
    response.status(status).render('account-profile', accountBaseLocals(request, {
      account,
      stats: accountStats(account),
      form: form ?? account,
      error,
      avatarRules: AVATAR_RULES
    }));
  };

  const renderAccountSettings = (request, response, { status = 200, error = '', form = null } = {}) => {
    const account = freshAccount(request);
    response.status(status).render('account-settings', accountBaseLocals(request, {
      account,
      stats: accountStats(account),
      notificationPreferences: database.getNotificationPreferences(account.id),
      form: form ?? {},
      error
    }));
  };

  app.get('/users/:username/avatar', async (request, response, next) => {
    try {
      const account = database.getPublicUserProfile(normalizeUsername(request.params.username));
      if (!account?.avatarStorageName || !account.avatarMediaType) {
        throw new AppError('头像不存在', 404, 'AVATAR_NOT_FOUND');
      }
      const filePath = avatarPath(config, account.avatarStorageName);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new AppError('头像不存在', 404, 'AVATAR_NOT_FOUND');
      response.set({
        'Content-Type': account.avatarMediaType,
        'Content-Length': String(fileStat.size),
        'Cache-Control': response.hasHeader('Set-Cookie') ? 'private, no-store' : 'public, max-age=86400'
      });
      await pipeline(createReadStream(filePath), response);
    } catch (error) {
      if (error?.code === 'ENOENT') next(new AppError('头像不存在', 404, 'AVATAR_NOT_FOUND'));
      else next(error);
    }
  });

  app.get('/users/:username', (request, response, next) => {
    try {
      const account = database.getPublicUserProfile(normalizeUsername(request.params.username));
      if (!account) throw new AppError('找不到这个用户', 404, 'USER_NOT_FOUND');
      const page = pageNumber(request.query.page);
      const result = database.listPublicUserVideos(account.id, { offset: (page - 1) * 20, limit: 20 });
      response.render('public-profile', {
        account,
        profile: account,
        stats: account,
        videos: result.items,
        pagination: paginationView(result, page),
        currentPath: request.path,
        ...catalogLocals()
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/account', requireAuthentication, (_request, response) => response.redirect(303, '/account/profile'));

  app.get('/account/profile', requireAuthentication, (request, response, next) => {
    try {
      renderAccountProfile(request, response);
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/profile', requireAuthentication, (request, response, next) => {
    avatarUpload.single('avatar')(request, response, async (uploadError) => {
      const avatarFile = request.file;
      let temporaryPath = avatarFile?.path;
      let normalizedPath;
      let storedPath;
      try {
        if (uploadError) {
          const tooLarge = uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE';
          throw new AppError(
            tooLarge ? '头像不能超过 2 MiB' : '头像上传无法处理，请检查文件和表单字段',
            tooLarge ? 413 : 400,
            uploadError.code ?? 'AVATAR_UPLOAD_ERROR'
          );
        }
        assertCsrf(request);
        const fields = validateProfileFields(request.body);
        let avatarInfo = null;
        let storageName = null;
        if (avatarFile) {
          avatarInfo = await normalizeUploadedImage(
            request,
            response,
            () => validateAvatarImage(avatarFile, { ffmpegPath: config.ffmpegPath })
          );
          normalizedPath = avatarInfo.normalizedPath;
          storageName = `${crypto.randomUUID()}${avatarInfo.extension}`;
          storedPath = avatarPath(config, storageName);
          await rename(normalizedPath, storedPath);
          normalizedPath = undefined;
          await safeUnlink(temporaryPath);
          temporaryPath = undefined;
        }

        const updated = database.updateUserProfile(request.currentUser.id, {
          ...fields,
          updatedAt: nowIso()
        });
        if (!updated) throw new AppError('账号当前不能修改', 409, 'ACCOUNT_NOT_EDITABLE');
        if (avatarInfo) {
          const avatarUpdate = database.updateUserAvatar(request.currentUser.id, {
            storageName,
            mediaType: avatarInfo.mediaType,
            updatedAt: nowIso()
          });
          if (!avatarUpdate) throw new AppError('头像当前不能修改', 409, 'AVATAR_NOT_EDITABLE');
          if (avatarUpdate.previousAvatarStorageName) {
            try {
              await safeUnlink(avatarPath(config, avatarUpdate.previousAvatarStorageName));
            } catch (cleanupError) {
              console.error('旧头像清理失败：', cleanupError);
            }
          }
          storedPath = undefined;
        }
        response.redirect(303, '/account/profile?saved=profile');
      } catch (error) {
        for (const cleanupPath of [temporaryPath, normalizedPath, storedPath]) {
          try {
            await safeUnlink(cleanupPath);
          } catch (cleanupError) {
            console.error('头像临时文件清理失败：', cleanupError);
          }
        }
        if (error instanceof AppError) {
          try {
            renderAccountProfile(request, response, {
              status: error.status,
              error: error.message,
              form: request.body ?? {}
            });
          } catch (renderError) {
            next(renderError);
          }
          return;
        }
        next(error);
      }
    });
  });

  app.post('/account/avatar/delete', requireAuthentication, async (request, response, next) => {
    try {
      assertCsrf(request);
      const result = database.updateUserAvatar(request.currentUser.id, {
        storageName: null,
        mediaType: null,
        updatedAt: nowIso()
      });
      if (!result) throw new AppError('头像当前不能修改', 409, 'AVATAR_NOT_EDITABLE');
      if (result.previousAvatarStorageName) {
        try {
          await safeUnlink(avatarPath(config, result.previousAvatarStorageName));
        } catch (cleanupError) {
          console.error('头像文件清理失败：', cleanupError);
        }
      }
      response.redirect(303, '/account/profile?saved=avatarRemoved');
    } catch (error) {
      next(error);
    }
  });

  app.get('/account/videos', requireAuthentication, (request, response, next) => {
    try {
      const page = pageNumber(request.query.page);
      const result = database.listUserVideos(request.currentUser.id, { offset: (page - 1) * 20, limit: 20 });
      response.render('account-videos', accountBaseLocals(request, {
        account: freshAccount(request),
        videos: result.items,
        pagination: paginationView(result, page)
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/videos/:id/withdraw', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const video = database.getVideo(request.params.id, request.currentUser.id);
      if (!video || video.userId !== request.currentUser.id) {
        throw new AppError('找不到这段稿件', 404, 'VIDEO_NOT_FOUND');
      }
      if (video.deletedAt || video.withdrawnAt) throw new AppError('稿件当前不能撤回', 409, 'VIDEO_NOT_WITHDRAWABLE');
      if (!database.withdrawVideo(video.id, request.currentUser.id, nowIso())) {
        throw new AppError('稿件当前不能撤回', 409, 'VIDEO_NOT_WITHDRAWABLE');
      }
      response.redirect(303, '/account/videos?saved=withdrawn');
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/videos/:id/republish', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const video = database.getVideo(request.params.id, request.currentUser.id);
      if (!video || video.userId !== request.currentUser.id) {
        throw new AppError('找不到这段稿件', 404, 'VIDEO_NOT_FOUND');
      }
      if (!video.withdrawnAt || video.deletedAt || !['ready', 'ready_with_warnings'].includes(video.validationStatus)) {
        throw new AppError('只有验证通过且已撤回的稿件才能重新发布', 409, 'VIDEO_NOT_REPUBLISHABLE');
      }
      if (!database.republishVideo(video.id, request.currentUser.id)) {
        throw new AppError('稿件当前不能重新发布', 409, 'VIDEO_NOT_REPUBLISHABLE');
      }
      response.redirect(303, '/account/videos?saved=republished');
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/videos/:id/delete', requireAuthentication, async (request, response, next) => {
    try {
      assertCsrf(request);
      const video = database.getVideo(request.params.id, request.currentUser.id);
      if (!video || video.userId !== request.currentUser.id) {
        throw new AppError('找不到这段稿件', 404, 'VIDEO_NOT_FOUND');
      }
      if (!video.withdrawnAt || video.deletedAt) {
        throw new AppError('请先撤回稿件，再执行永久删除', 409, 'VIDEO_MUST_BE_WITHDRAWN');
      }
      if (String(request.body?.confirmTitle ?? '') !== video.title) {
        throw new ValidationError('请输入完整且完全一致的稿件标题以确认删除', 'VIDEO_TITLE_CONFIRMATION_MISMATCH');
      }
      const asset = database.markVideoPermanentlyDeleted(video.id, request.currentUser.id, nowIso());
      if (!asset) throw new AppError('稿件当前不能永久删除', 409, 'VIDEO_NOT_DELETABLE');
      await removeVideoAssets(config, [asset]);
      response.redirect(303, '/account/videos?saved=deleted');
    } catch (error) {
      next(error);
    }
  });

  app.get('/account/discussions', requireAuthentication, (request, response, next) => {
    try {
      const page = pageNumber(request.query.page);
      const result = database.listUserDiscussions(request.currentUser.id, { offset: (page - 1) * 20, limit: 20 });
      response.render('account-discussions', accountBaseLocals(request, {
        account: freshAccount(request),
        discussions: result.items.map(discussionView),
        pagination: paginationView(result, page),
        includeMathEditor: true
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/discussions/:id/edit', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const id = positiveDiscussionId(request.params.id);
      const current = id ? database.getDiscussion(id, request.currentUser.id) : null;
      if (!current || current.userId !== request.currentUser.id || current.deletedAt) {
        throw new AppError('找不到这条讨论', 404, 'DISCUSSION_NOT_FOUND');
      }
      const bodyMarkdown = validateDiscussionBody(request.body?.body);
      renderMarkdown(bodyMarkdown);
      const title = validateDiscussionTitle(request.body?.title, { required: current.parentId === null }) || null;
      const updated = database.editDiscussion(id, request.currentUser.id, {
        title,
        bodyMarkdown,
        editedAt: nowIso()
      });
      if (!updated) throw new AppError('讨论当前不能修改', 409, 'DISCUSSION_NOT_EDITABLE');
      const fallback = `/videos/${current.videoId}#discussion-${current.id}`;
      response.redirect(303, safeNextPath(request.body?.returnTo, fallback));
    } catch (error) {
      if (error instanceof AppError && wantsJson(request)) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post('/discussions/:id/delete', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const id = positiveDiscussionId(request.params.id);
      const current = id ? database.getDiscussion(id, request.currentUser.id) : null;
      if (!current || current.userId !== request.currentUser.id || current.deletedAt) {
        throw new AppError('找不到这条讨论', 404, 'DISCUSSION_NOT_FOUND');
      }
      const result = database.deleteDiscussion(id, request.currentUser.id, nowIso());
      if (!result) throw new AppError('讨论当前不能删除', 409, 'DISCUSSION_NOT_DELETABLE');
      const fallback = `/videos/${current.videoId}#discussions`;
      response.redirect(303, safeNextPath(request.body?.returnTo, fallback));
    } catch (error) {
      if (error instanceof AppError && wantsJson(request)) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get('/account/notifications', requireAuthentication, (request, response, next) => {
    try {
      const page = pageNumber(request.query.page);
      const result = database.listNotifications(request.currentUser.id, { offset: (page - 1) * 20, limit: 20 });
      response.render('account-notifications', accountBaseLocals(request, {
        account: freshAccount(request),
        notifications: result.items.map(notificationView),
        notificationUnreadCount: result.unreadCount,
        pagination: paginationView(result, page)
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/account/notifications/poll', requireAuthentication, (request, response, next) => {
    try {
      const result = database.pollNotifications(request.currentUser.id, { limit: 40 });
      const items = result.items.map(notificationView);
      const after = Number(request.query.after);
      const afterId = Number.isSafeInteger(after) && after > 0 ? after : 0;
      const cursor = items.reduce((maximum, item) => Math.max(maximum, item.id), afterId);
      response.status(200).json({
        items,
        notifications: items,
        newItems: items.filter((item) => item.id > afterId),
        unreadCount: result.unreadCount,
        cursor,
        polledAt: nowIso()
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/notifications/:id/read', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const id = positiveDiscussionId(request.params.id);
      if (!id || !database.markNotificationRead(id, request.currentUser.id, nowIso())) {
        throw new AppError('找不到这条通知', 404, 'NOTIFICATION_NOT_FOUND');
      }
      if (wantsJson(request)) {
        response.status(200).json({ ok: true, unreadCount: database.getUnreadNotificationCount(request.currentUser.id) });
        return;
      }
      response.redirect(303, safeNextPath(request.body?.next, '/account/notifications'));
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/notifications/read-all', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      database.markAllNotificationsRead(request.currentUser.id, nowIso());
      if (wantsJson(request)) {
        response.status(200).json({ ok: true, unreadCount: 0 });
        return;
      }
      response.redirect(303, '/account/notifications');
    } catch (error) {
      next(error);
    }
  });

  app.get('/account/settings', requireAuthentication, (request, response, next) => {
    try {
      renderAccountSettings(request, response);
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/settings/notifications', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const preferences = database.updateNotificationPreferences(request.currentUser.id, {
        reply: checked(request.body?.replyEnabled),
        videoVote: checked(request.body?.videoVoteEnabled),
        system: checked(request.body?.systemEnabled)
      }, nowIso());
      if (!preferences) {
        throw new AppError('账号状态已经变化，通知设置未保存', 409, 'ACCOUNT_NOT_EDITABLE');
      }
      response.redirect(303, '/account/settings?saved=notifications');
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/settings/password', requireAuthentication, async (request, response, next) => {
    try {
      assertCsrf(request);
      const currentPassword = validatePassword(request.body?.currentPassword);
      const newPassword = validatePassword(request.body?.newPassword);
      if (newPassword !== request.body?.confirmPassword) throw new ValidationError('两次输入的新密码不一致');
      if (newPassword === currentPassword) throw new ValidationError('新密码不能与当前密码相同');
      const account = freshAccount(request);
      if (!await verifyPassword(currentPassword, account.passwordHash)) {
        throw new AppError('当前密码不正确', 401, 'CURRENT_PASSWORD_INCORRECT');
      }
      const passwordHash = await hashPassword(newPassword);
      if (database.updateUserPassword(account.id, passwordHash, nowIso()) !== 1) {
        throw new AppError('密码当前不能修改', 409, 'PASSWORD_NOT_EDITABLE');
      }
      database.revokeOtherSessions(account.id, request.authSession.tokenHash);
      response.redirect(303, '/account/settings?saved=password');
    } catch (error) {
      if (error instanceof AppError) {
        try {
          renderAccountSettings(request, response, { status: error.status, error: error.message });
        } catch (renderError) {
          next(renderError);
        }
        return;
      }
      next(error);
    }
  });

  app.post('/account/delete', requireAuthentication, async (request, response, next) => {
    try {
      assertCsrf(request);
      if (!checked(request.body?.confirmDeletion)) throw new ValidationError('请确认你理解账号删除不可恢复');
      const account = freshAccount(request);
      if (normalizeUsername(request.body?.username) !== account.username) {
        throw new ValidationError('请输入完整用户名以确认删除账号');
      }
      const currentPassword = validatePassword(request.body?.currentPassword);
      if (!await verifyPassword(currentPassword, account.passwordHash)) {
        throw new AppError('当前密码不正确', 401, 'CURRENT_PASSWORD_INCORRECT');
      }
      const result = database.deleteAccount(account.id, {
        deleteVideos: checked(request.body?.deleteVideos),
        deleteDiscussions: checked(request.body?.deleteDiscussions),
        deletedAt: nowIso()
      });
      if (!result) throw new AppError('账号当前不能删除', 409, 'ACCOUNT_NOT_DELETABLE');
      await removeVideoAssets(config, result.assets);
      if (result.avatarStorageName) {
        try {
          await safeUnlink(avatarPath(config, result.avatarStorageName));
        } catch (cleanupError) {
          console.error('注销账号头像清理失败：', cleanupError);
        }
      }
      clearAuthCookies(response);
      response.redirect(303, '/?accountDeleted=1');
    } catch (error) {
      if (error instanceof AppError) {
        try {
          renderAccountSettings(request, response, {
            status: error.status,
            error: error.message,
            form: request.body ?? {}
          });
        } catch (renderError) {
          next(renderError);
        }
        return;
      }
      next(error);
    }
  });

  app.get('/upload', requireAuthentication, (_request, response) => {
    response.render('upload', { form: {}, error: '', maxUploadMb: config.maxUploadMb, ...catalogLocals() });
  });

  app.post('/videos', requireAuthentication, (request, response, next) => {
    upload.fields([{ name: 'video', maxCount: 1 }, { name: 'cover', maxCount: 1 }])(request, response, async (uploadError) => {
      const videoFile = request.files?.video?.[0];
      const coverFile = request.files?.cover?.[0];
      let temporaryPath = videoFile?.path;
      let coverTemporaryPath = coverFile?.path;
      let normalizedCoverPath;
      let stagedPath;
      let storedCoverPath;
      let videoInserted = false;
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
        const categorySlug = validateCategorySlug(request.body?.category);
        const selectedCategory = database.getCategoryBySlug(categorySlug);
        if (!selectedCategory) throw new ValidationError('请选择有效的视频分类', 'INVALID_CATEGORY');
        const tags = validateTags(request.body?.tags);
        if (!videoFile) throw new ValidationError('请选择一个视频文件', 'VIDEO_REQUIRED');
        const canonical = validateCanonicalUploadMetadata(videoFile.originalname, videoFile.mimetype);
        await validateCanonicalUploadHeader(temporaryPath, canonical.container);

        let coverInfo = null;
        let coverStorageName = null;
        if (coverFile) {
          coverInfo = await normalizeUploadedImage(
            request,
            response,
            () => validateCoverImage(coverFile, { ffmpegPath: config.ffmpegPath })
          );
          normalizedCoverPath = coverInfo.normalizedPath;
          coverStorageName = `${crypto.randomUUID()}${coverInfo.extension}`;
          storedCoverPath = coverPath(config, coverStorageName);
          await rename(normalizedCoverPath, storedCoverPath);
          normalizedCoverPath = undefined;
          await safeUnlink(coverTemporaryPath);
          coverTemporaryPath = undefined;
        }

        const license = normalizeLicense(request.body);
        const id = crypto.randomUUID();
        const storageName = `${crypto.randomUUID()}.${canonical.container}`;
        stagedPath = pendingVideoPath(config, storageName);
        await rename(temporaryPath, stagedPath);
        temporaryPath = undefined;

        const insertedVideo = database.insertVideo({
            id,
            userId: request.currentUser.id,
            ...fields,
            categoryId: selectedCategory.id,
            tags,
            coverStorageName,
            coverMediaType: coverInfo?.mediaType ?? null,
            coverSource: coverInfo ? 'uploaded' : null,
            licenseCode: license.id,
            storageName,
            originalFilename: normalizeSourceFilename(request.body?.sourceFilename, videoFile.originalname),
            mediaType: canonical.mediaType,
            byteSize: videoFile.size,
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
        if (!insertedVideo) {
          throw new AppError('账号状态已经变化，稿件未发布', 409, 'ACCOUNT_NOT_WRITABLE');
        }
        videoInserted = true;

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
        const cleanupPaths = [temporaryPath, coverTemporaryPath, normalizedCoverPath];
        if (!videoInserted) cleanupPaths.push(stagedPath, storedCoverPath);
        for (const cleanupPath of cleanupPaths) {
          try {
            await safeUnlink(cleanupPath);
          } catch (cleanupError) {
            error.cleanupError = cleanupError;
            console.error('上传临时文件清理失败：', cleanupError);
          }
        }
        if (error instanceof AppError) {
          if (wantsJson(request)) {
            response.status(error.status).json({ error: error.message, code: error.code });
            return;
          }
          response.status(error.status).render('upload', {
            form: request.body ?? {},
            error: error.message,
            maxUploadMb: config.maxUploadMb,
            ...catalogLocals()
          });
          return;
        }
        next(error);
      }
    });
  });

  app.get('/videos/:id', (request, response, next) => {
    try {
      const video = database.getVideo(request.params.id, request.currentUser?.id);
      if (!video) throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      if (video.deletedAt) {
        if (!video.archivePublic) {
          throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
        }
        const discussions = database.listDiscussions(video.id, request.currentUser?.id).map(discussionView);
        response.render('video', {
          video,
          license: getLicense(video.licenseCode),
          discussions,
          discussionTree: buildDiscussionTree(discussions),
          validationStatus: publicValidationStatus(video.validationStatus),
          discussionError: '',
          discussionCooldownSeconds: config.discussionCooldownSeconds,
          archived: true,
          ...catalogLocals()
        });
        return;
      }
      const isReady = ['ready', 'ready_with_warnings'].includes(video.validationStatus);
      const isOwner = request.currentUser?.id === video.userId;
      if ((!isReady || video.visibility !== 'public' || video.moderationStatus !== 'visible' || video.withdrawnAt) && !isOwner) {
        throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      }
      const license = getLicense(video.licenseCode);
      if (!license) throw new AppError('视频许可证记录无效', 500, 'INVALID_LICENSE_RECORD');
      const discussions = isReady
        ? database.listDiscussions(video.id, request.currentUser?.id).map(discussionView)
        : [];
      response.render('video', {
        video,
        license,
        discussions,
        discussionTree: buildDiscussionTree(discussions),
        validationStatus: publicValidationStatus(video.validationStatus),
        discussionError: '',
        discussionCooldownSeconds: config.discussionCooldownSeconds,
        ...catalogLocals()
      });
    } catch (error) {
      next(error);
    }
  });

  const serveMedia = async (request, response, next) => {
    try {
      const video = database.getVideo(request.params.id, request.currentUser?.id);
      if (!video) throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      const isOwner = request.currentUser?.id === video.userId;
      if (
        video.deletedAt
        || ((video.visibility !== 'public' || video.moderationStatus !== 'visible' || video.withdrawnAt) && !isOwner)
      ) throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
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
        'Cache-Control': (isOwner && (video.visibility !== 'public' || video.moderationStatus !== 'visible' || video.withdrawnAt))
          || response.hasHeader('Set-Cookie')
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

  app.get('/videos/:id/cover', async (request, response, next) => {
    try {
      const video = database.getVideo(request.params.id, request.currentUser?.id);
      if (!video || !video.coverStorageName || !['ready', 'ready_with_warnings'].includes(video.validationStatus)) {
        throw new AppError('视频封面尚不可用', 404, 'COVER_NOT_FOUND');
      }
      const isOwner = request.currentUser?.id === video.userId;
      if (
        video.deletedAt
        || ((video.visibility !== 'public' || video.moderationStatus !== 'visible' || video.withdrawnAt) && !isOwner)
      ) {
        throw new AppError('视频封面尚不可用', 404, 'COVER_NOT_FOUND');
      }
      const filePath = coverPath(config, video.coverStorageName);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new AppError('视频封面尚不可用', 404, 'COVER_NOT_FOUND');
      response.set({
        'Content-Type': video.coverMediaType,
        'Content-Length': String(fileStat.size),
        'Cache-Control': (isOwner && (video.visibility !== 'public' || video.moderationStatus !== 'visible' || video.withdrawnAt))
          || response.hasHeader('Set-Cookie')
          ? 'private, no-store'
          : 'public, max-age=86400'
      });
      await pipeline(createReadStream(filePath), response);
    } catch (error) {
      if (error?.code === 'ENOENT') next(new AppError('视频封面尚不可用', 404, 'COVER_NOT_FOUND'));
      else next(error);
    }
  });

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
      if (
        !['ready', 'ready_with_warnings'].includes(video.validationStatus)
        || video.visibility !== 'public'
        || video.moderationStatus !== 'visible'
        || video.withdrawnAt
        || video.deletedAt
      ) {
        throw new AppError('视频通过验证后才能参与讨论', 409, 'MEDIA_NOT_READY');
      }
      const bodyMarkdown = validateDiscussionBody(request.body?.body);
      renderMarkdown(bodyMarkdown);
      const parentId = request.body?.parentId === undefined || request.body?.parentId === ''
        ? null
        : Number(request.body.parentId);
      let parent = null;
      if (parentId !== null) {
        if (!Number.isSafeInteger(parentId) || parentId < 1) throw new ValidationError('回复目标无效');
        parent = database.getDiscussion(parentId);
        if (!parent || parent.videoId !== video.id || parent.deletedAt) throw new ValidationError('回复目标不存在');
      }
      const title = parent
        ? (validateDiscussionTitle(request.body?.title, { required: false }) || null)
        : validateDiscussionTitle(request.body?.title || discussionTitleFromBody(bodyMarkdown));
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
        const discussions = database.listDiscussions(video.id, request.currentUser.id).map(discussionView);
        response.status(429).render('video', {
          video,
          license: getLicense(video.licenseCode),
          discussions,
          discussionTree: buildDiscussionTree(discussions),
          discussionError: message,
          discussionCooldownSeconds: config.discussionCooldownSeconds,
          ...catalogLocals()
        });
        return;
      }

      const discussion = database.insertDiscussion({
        videoId: video.id,
        userId: request.currentUser.id,
        nickname: request.currentUser.displayName,
        bodyMarkdown,
        title,
        parentId,
        createdAt: nowIso()
      });
      if (!discussion) {
        throw new AppError('账号或讨论目标的状态已经变化，请刷新后重试', 409, 'DISCUSSION_STATE_CONFLICT');
      }
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
      response.redirect(303, `/videos/${video.id}#discussion-${discussion.id}`);
    } catch (error) {
      if (error instanceof AppError && wantsJson(request)) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post('/videos/:id/vote', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const video = database.getVideo(request.params.id);
      if (
        !video
        || !['ready', 'ready_with_warnings'].includes(video.validationStatus)
        || video.visibility !== 'public'
        || video.moderationStatus !== 'visible'
        || video.withdrawnAt
        || video.deletedAt
      ) {
        throw new AppError('找不到这段视频', 404, 'VIDEO_NOT_FOUND');
      }
      const value = validateVoteValue(request.body?.value);
      const updated = database.setVideoVote(video.id, request.currentUser.id, value, nowIso());
      if (!updated) {
        throw new AppError('账号或视频状态已经变化，请刷新后重试', 409, 'VIDEO_VOTE_STATE_CONFLICT');
      }
      if (wantsJson(request)) {
        response.status(200).json({ upvotes: updated.upvoteCount, downvotes: updated.downvoteCount, viewerVote: updated.viewerVote });
        return;
      }
      response.redirect(303, `/videos/${video.id}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/discussions/:id/vote', requireAuthentication, (request, response, next) => {
    try {
      assertCsrf(request);
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw new AppError('找不到这条讨论', 404, 'DISCUSSION_NOT_FOUND');
      const discussion = database.getDiscussion(id);
      if (!discussion || discussion.deletedAt) throw new AppError('找不到这条讨论', 404, 'DISCUSSION_NOT_FOUND');
      const video = database.getVideo(discussion.videoId);
      if (
        !video
        || video.visibility !== 'public'
        || video.moderationStatus !== 'visible'
        || video.withdrawnAt
        || video.deletedAt
      ) throw new AppError('找不到这条讨论', 404, 'DISCUSSION_NOT_FOUND');
      const value = validateVoteValue(request.body?.value);
      const updated = database.setDiscussionVote(id, request.currentUser.id, value, nowIso());
      if (!updated) {
        throw new AppError('账号或讨论状态已经变化，请刷新后重试', 409, 'DISCUSSION_VOTE_STATE_CONFLICT');
      }
      if (wantsJson(request)) {
        response.status(200).json({ upvotes: updated.upvoteCount, downvotes: updated.downvoteCount, viewerVote: updated.viewerVote });
        return;
      }
      response.redirect(303, `/videos/${discussion.videoId}#discussion-${discussion.id}`);
    } catch (error) {
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
