export class DiscussionRateLimiter {
  constructor({ cooldownSeconds = 30, now = () => Date.now() } = {}) {
    this.cooldownMs = cooldownSeconds * 1000;
    this.now = now;
    this.lastPublishedAt = new Map();
  }

  check(key) {
    const current = this.now();
    const previous = this.lastPublishedAt.get(key);
    if (previous === undefined || current - previous >= this.cooldownMs) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const remainingMs = this.cooldownMs - (current - previous);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }

  consume(key) {
    const current = this.now();
    this.lastPublishedAt.set(key, current);
    if (this.lastPublishedAt.size > 10000) {
      const staleBefore = current - this.cooldownMs;
      for (const [storedKey, timestamp] of this.lastPublishedAt) {
        if (timestamp <= staleBefore) this.lastPublishedAt.delete(storedKey);
      }
    }
  }

  clear() {
    this.lastPublishedAt.clear();
  }
}

