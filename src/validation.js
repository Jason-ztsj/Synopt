import { ValidationError } from './errors.js';
import { normalizeUsername } from './auth.js';

export const FIELD_LIMITS = Object.freeze({
  title: 120,
  creator: 80,
  description: 2000,
  discussion: 5000,
  discussionTitle: 120,
  tag: 32,
  tagCount: 8,
  usernameMin: 3,
  username: 32,
  displayName: 40,
  passwordMin: 8,
  password: 128
});

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateText(value, { name, required, max }) {
  const text = textValue(value);
  if (required && text.length === 0) throw new ValidationError(`请填写${name}`);
  if (text.length > max) throw new ValidationError(`${name}不能超过 ${max.toLocaleString('zh-CN')} 个字符`);
  if (/\u0000/.test(text)) throw new ValidationError(`${name}包含非法字符`);
  return text;
}

export function validateVideoFields(input = {}) {
  return {
    title: validateText(input.title, { name: '视频标题', required: true, max: FIELD_LIMITS.title }),
    creator: validateText(input.creator, { name: '创作者署名', required: true, max: FIELD_LIMITS.creator }),
    description: validateText(input.description, { name: '作品描述', required: false, max: FIELD_LIMITS.description })
  };
}

export function validateDiscussionBody(value) {
  return validateText(value, { name: '讨论正文', required: true, max: FIELD_LIMITS.discussion });
}

export function validateDiscussionTitle(value, { required = true } = {}) {
  return validateText(value, { name: '讨论标题', required, max: FIELD_LIMITS.discussionTitle });
}

export function validateCategorySlug(value) {
  const slug = textValue(value).toLowerCase();
  if (!slug) throw new ValidationError('请选择视频分类');
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) throw new ValidationError('视频分类无效');
  return slug;
}

function tagSlug(name) {
  return name.normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replace(/[\s_]+/gu, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function validateTags(value) {
  const rawValues = Array.isArray(value) ? value : String(value ?? '').split(/[,，]/u);
  const tags = [];
  const seen = new Set();
  for (const raw of rawValues) {
    const name = textValue(raw).normalize('NFC');
    if (!name) continue;
    if (Array.from(name).length > FIELD_LIMITS.tag) {
      throw new ValidationError(`每个标签不能超过 ${FIELD_LIMITS.tag} 个字符`);
    }
    const slug = tagSlug(name);
    if (!slug || Array.from(slug).length > 48) throw new ValidationError(`标签“${name}”格式无效`);
    if (seen.has(slug)) continue;
    seen.add(slug);
    tags.push({ slug, name });
  }
  if (tags.length > FIELD_LIMITS.tagCount) {
    throw new ValidationError(`每个视频最多添加 ${FIELD_LIMITS.tagCount} 个标签`);
  }
  return tags;
}

export function validateVoteValue(value) {
  const parsed = Number(value);
  if (![1, 0, -1].includes(parsed)) throw new ValidationError('投票值无效');
  return parsed;
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (username.length === 0) throw new ValidationError('请填写用户名');
  if (username.length < FIELD_LIMITS.usernameMin || username.length > FIELD_LIMITS.username) {
    throw new ValidationError(`用户名必须为 ${FIELD_LIMITS.usernameMin}–${FIELD_LIMITS.username} 个字符`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(username)) {
    throw new ValidationError('用户名须以字母或数字开头，且只能包含英文字母、数字、下划线和连字符');
  }
  return username;
}

export function validateDisplayName(value) {
  const displayName = textValue(value).normalize('NFC');
  if (displayName.length === 0) throw new ValidationError('请填写显示名称');
  if (Array.from(displayName).length > FIELD_LIMITS.displayName) {
    throw new ValidationError(`显示名称不能超过 ${FIELD_LIMITS.displayName} 个字符`);
  }
  if (/\u0000/.test(displayName)) throw new ValidationError('显示名称包含非法字符');
  return displayName;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError('请填写密码');
  }
  if (/\u0000/.test(value)) throw new ValidationError('密码包含非法字符');
  const length = Array.from(value).length;
  if (length < FIELD_LIMITS.passwordMin || length > FIELD_LIMITS.password) {
    throw new ValidationError(`密码必须为 ${FIELD_LIMITS.passwordMin}–${FIELD_LIMITS.password} 个字符`);
  }
  return value;
}

export function validateRegistrationFields(input = {}) {
  return {
    username: validateUsername(input.username),
    displayName: validateDisplayName(input.displayName),
    password: validatePassword(input.password)
  };
}

export function validateLoginFields(input = {}) {
  return {
    username: validateUsername(input.username),
    password: validatePassword(input.password)
  };
}
