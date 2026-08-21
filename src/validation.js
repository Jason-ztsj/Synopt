import { ValidationError } from './errors.js';

export const FIELD_LIMITS = Object.freeze({
  title: 120,
  creator: 80,
  description: 2000,
  discussion: 5000
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
