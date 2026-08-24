import { ValidationError } from './errors.js';
import { validateAndNormalizeImage } from './image-normalizer.js';

export const COVER_RULES = Object.freeze({
  minBytes: 24,
  maxBytes: 5 * 1024 * 1024,
  minWidth: 1280,
  minHeight: 720,
  maxWidth: 3840,
  maxHeight: 2160,
  aspectWidth: 16,
  aspectHeight: 9
});

function validateCoverDimensions({ width, height }) {
  if (
    width < COVER_RULES.minWidth
    || height < COVER_RULES.minHeight
    || width > COVER_RULES.maxWidth
    || height > COVER_RULES.maxHeight
    || width * COVER_RULES.aspectHeight !== height * COVER_RULES.aspectWidth
  ) {
    throw new ValidationError(
      '封面必须是严格 16:9，尺寸为 1280×720 至 3840×2160',
      'INVALID_COVER_DIMENSIONS'
    );
  }
}

export async function validateCoverImage(file, { ffmpegPath } = {}) {
  return validateAndNormalizeImage(file, {
    ffmpegPath,
    label: '封面',
    codePrefix: 'COVER',
    minBytes: COVER_RULES.minBytes,
    maxBytes: COVER_RULES.maxBytes,
    validateDimensions: validateCoverDimensions
  });
}
