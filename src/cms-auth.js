import { AppError } from './errors.js';
import { hasCmsRole, isAdministrator } from './governance.js';

function safeNext(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) {
    return '/cms';
  }
  const candidate = value.slice(0, 500);
  if (
    !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /%(?:2f|5c)/i.test(candidate)
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) return '/cms';
  let decoded;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return '/cms';
  }
  const decodedPath = decoded.split(/[?#]/, 1)[0];
  if (
    decoded.startsWith('//')
    || decoded.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(decoded)
    || (decodedPath !== '/cms' && !decodedPath.startsWith('/cms/'))
  ) return '/cms';
  return candidate;
}

export function isCmsReauthenticationFresh(session, nowMs, windowMs) {
  if (!session?.cmsVerifiedAt) return false;
  const verifiedAt = Date.parse(session.cmsVerifiedAt);
  return Number.isFinite(verifiedAt) && verifiedAt <= nowMs && nowMs - verifiedAt <= windowMs;
}

export function createCmsAuth({ config, now = () => Date.now() }) {
  const requireCmsRole = (request, response, next) => {
    if (!request.currentUser) {
      response.redirect(303, `/login?next=${encodeURIComponent(safeNext(request.originalUrl))}`);
      return;
    }
    if (!hasCmsRole(request.currentUser)) {
      next(new AppError('没有管理后台访问权限', 403, 'CMS_FORBIDDEN'));
      return;
    }
    next();
  };

  const requireAdministrator = (request, _response, next) => {
    if (!isAdministrator(request.currentUser)) {
      next(new AppError('这项操作仅限管理员', 403, 'ADMINISTRATOR_REQUIRED'));
      return;
    }
    next();
  };

  const requireCmsReauthentication = (request, response, next) => {
    if (isCmsReauthenticationFresh(request.authSession, now(), config.cmsReauthMs)) {
      next();
      return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      response.redirect(303, `/cms/reauth?next=${encodeURIComponent(safeNext(request.originalUrl))}`);
      return;
    }
    next(new AppError('后台密码复核已过期，请重新验证后再提交', 403, 'CMS_REAUTH_REQUIRED'));
  };

  return { requireCmsRole, requireAdministrator, requireCmsReauthentication, safeNext };
}
