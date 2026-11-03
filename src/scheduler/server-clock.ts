import type { TimeSample } from './clock-guard.js';

export class ServerTimeUntrustedError extends Error {
  constructor(reason: string) {
    super(`Waktu server Indodax belum dapat dipercaya (${reason}): pengumpulan data ditahan dan dicatat sebagai gap.`);
    this.name = 'ServerTimeUntrustedError';
  }
}

export interface ServerClockOptions {
  /** Two consecutive samples must agree (monotonic prediction vs reported time) within this. */
  maxDriftMs: number;
  /** An anchor older than this (monotonic) is no longer trusted. */
  maxAnchorAgeMs: number;
  /** A response cached longer than this cannot anchor anything. */
  maxCacheAgeSec: number;
  /** Monotonic milliseconds; must not depend on the wall clock. */
  mono?: () => number;
}

/**
 * Indodax time, independent of the computer's clock: anchored to
 * server_time + Cloudflare Age and advanced with the monotonic clock. Used as
 * the `now` of the data-collection MarketDataService (M2 dependency
 * injection, M2 unchanged), so candle finality and snapshot timestamps stay
 * correct even while the local clock is wrong.
 *
 * Trusted only after two consecutive samples agree. On macOS the monotonic
 * clock does not advance during sleep, so a wake resets the trust.
 */
export class ServerClock {
  private anchor: { serverMs: number; mono: number } | null = null;
  private chain = 0;
  private reason = 'belum ada sampel';
  private readonly mono: () => number;

  constructor(private readonly opts: ServerClockOptions) {
    this.mono = opts.mono ?? (() => performance.now());
  }

  get isTrusted(): boolean {
    return this.untrustedReason() === null;
  }

  /** Why the server time is not trusted right now, or null. */
  untrustedReason(): string | null {
    if (!this.anchor || this.chain < 2) return this.reason;
    if (this.mono() - this.anchor.mono > this.opts.maxAnchorAgeMs) return 'sampel waktu server terlalu lama';
    return null;
  }

  observe(sample: TimeSample): boolean {
    const now = this.mono();
    const age = sample.cacheAgeSec ?? 0;
    const serverMs = sample.serverTime.getTime() + age * 1000;
    if (!Number.isFinite(serverMs) || age < 0 || age > this.opts.maxCacheAgeSec) {
      this.chain = 0;
      this.anchor = null;
      this.reason = `sampel tidak valid (cache ${age} dtk)`;
      return false;
    }
    if (this.anchor) {
      const predicted = this.anchor.serverMs + (now - this.anchor.mono);
      const drift = serverMs - predicted;
      if (Math.abs(drift) > this.opts.maxDriftMs) {
        this.chain = 1;
        this.reason = `waktu server tidak konsisten (selisih ${Math.round(drift / 1000)} dtk antar sampel)`;
      } else this.chain++;
    } else {
      this.chain = 1;
      this.reason = 'butuh sampel kedua yang konsisten';
    }
    this.anchor = { serverMs, mono: now };
    return this.isTrusted;
  }

  /** After sleep/wake (monotonic time stood still) or any doubt. */
  reset(reason: string): void {
    this.anchor = null;
    this.chain = 0;
    this.reason = reason;
  }

  /** Trusted Indodax time; throws when not trusted. */
  current(): Date {
    const reason = this.untrustedReason();
    if (reason !== null) throw new ServerTimeUntrustedError(reason);
    return this.estimate();
  }

  /**
   * Best estimate without throwing (used as M2's `now` callback, which is only
   * reached after `current()` succeeded for that refresh). Falls back to the
   * wall clock only when no sample exists at all.
   */
  estimate(): Date {
    return this.anchor ? new Date(this.anchor.serverMs + (this.mono() - this.anchor.mono)) : new Date();
  }
}
