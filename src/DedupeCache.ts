const oneDayMs = 1000 * 60 * 60 * 24

export class DedupeCache {
  private cache: Map<string, number> = new Map();
  private cleanupTimer: NodeJS.Timeout;

  constructor(private ttlMs: number = oneDayMs) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    this.cleanupTimer.unref();
  }

  public tryAdd(key: string): boolean {
    if (this.cache.has(key)) {
      return false;
    }
    this.cache.set(key, Date.now() + this.ttlMs);
    return true;
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, expiry] of this.cache.entries()) {
      if (expiry < now) {
        this.cache.delete(key);
      }
    }
  }
}