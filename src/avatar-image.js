import { ValidationError } from './errors.js';
import { validateAndNormalizeImage } from './image-normalizer.js';

export const AVATAR_RULES = Object.freeze({
  minBytes: 24,
  maxBytes: 2 * 1024 * 1024,
  minDimension: 128,
  maxDimension: 1024
});

function validateAvatarDimensions({ width, height }) {
  if (
    width !== height
    || width < AVATAR_RULES.minDimension
    || width > AVATAR_RULES.maxDimension
  ) {
    throw new ValidationError(
      '头像必须是严格正方形，尺寸为 128×128 至 1024×1024',
      'INVALID_AVATAR_DIMENSIONS'
    );
  }
}

export async function validateAvatarImage(file, { ffmpegPath } = {}) {
  return validateAndNormalizeImage(file, {
    ffmpegPath,
    label: '头像',
    codePrefix: 'AVATAR',
    minBytes: AVATAR_RULES.minBytes,
    maxBytes: AVATAR_RULES.maxBytes,
    validateDimensions: validateAvatarDimensions
  });
}
