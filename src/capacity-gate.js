import { AppError } from './errors.js';

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

export class CapacityGate {
  #active = 0;

  constructor({ limit = 2, cooldownSeconds = 10 } = {}) {
    this.limit = positiveInteger(limit, 'limit');
    this.cooldownSeconds = positiveInteger(cooldownSeconds, 'cooldownSeconds');
  }

  get active() {
    return this.#active;
  }

  async run(action) {
    if (typeof action !== 'function') {
      throw new TypeError('CapacityGate action must be a function');
    }
    if (this.#active >= this.limit) {
      const error = new AppError(
        '图片处理任务较多，请稍后重试',
        503,
        'IMAGE_NORMALIZATION_BUSY'
      );
      error.retryAfterSeconds = this.cooldownSeconds;
      throw error;
    }

    this.#active += 1;
    try {
      return await action();
    } finally {
      this.#active -= 1;
    }
  }
}
