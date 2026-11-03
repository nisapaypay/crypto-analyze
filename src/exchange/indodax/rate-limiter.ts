export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  maxConcurrent: number;
  now?: () => number;
  sleep?: Sleep;
}

/**
 * Sliding-window rate limiter with a concurrency cap. Requests acquire slots
 * in FIFO order, so a burst is spread out instead of exceeding the
 * exchange limit (Indodax public API: 180 requests/minute).
 */
export class RateLimiter {
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private stamps: number[] = [];
  private active = 0;
  private waiters: (() => void)[] = [];
  private gate: Promise<void> = Promise.resolve();
  private total = 0;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Number of requests started since creation. */
  get requestCount(): number {
    return this.total;
  }

  async schedule<T>(task: () => Promise<T>): Promise<T> {
    const acquired = this.gate.then(() => this.acquire());
    this.gate = acquired.catch(() => undefined);
    await acquired;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.stamps = this.stamps.filter((t) => t > now - this.options.windowMs);
      if (this.active >= this.options.maxConcurrent) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
        continue;
      }
      if (this.stamps.length >= this.options.maxRequests) {
        await this.sleep(this.stamps[0]! + this.options.windowMs - now);
        continue;
      }
      this.stamps.push(now);
      this.active++;
      this.total++;
      return;
    }
  }
}

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  /** Delay before retry n is baseDelayMs * 2^(n-1): 1s, 2s, 4s by default. */
  baseDelayMs: number;
  sleep?: Sleep;
}

export async function withRetry<T>(
  task: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= options.retries || !isRetryable(error)) throw error;
      await sleep(options.baseDelayMs * 2 ** attempt);
    }
  }
}
