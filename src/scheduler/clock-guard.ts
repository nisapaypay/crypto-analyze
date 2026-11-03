export type ClockStatus = 'UNKNOWN' | 'VALID' | 'INVALID';

/** One observation of Indodax time: when we received it, what it said, and how long Cloudflare cached it. */
export interface TimeSample {
  fetchedAt: Date;
  serverTime: Date;
  cacheAgeSec: number | null;
}

export class ClockNotValidError extends Error {
  constructor(status: ClockStatus, skewMs: number | null) {
    super(
      status === 'UNKNOWN'
        ? 'Waktu komputer belum terverifikasi terhadap Indodax: keputusan trading dan penyimpanan data ditahan.'
        : `Waktu komputer tidak valid (selisih ${Math.round((skewMs ?? 0) / 1000)} dtk dari Indodax): keputusan trading dan penyimpanan data ditahan.`,
    );
    this.name = 'ClockNotValidError';
  }
}

export interface ClockGuardOptions {
  maxSkewMs: number;
  /** Consecutive good samples needed to become VALID (also at startup: fail-closed). */
  validChecks: number;
  onChange?: (status: ClockStatus, skewMs: number | null) => void;
}

/**
 * Candle finality and signal expiry depend on the local clock. Until the clock
 * agrees with Indodax (server_time + Cloudflare Age, ±1 s), nothing may decide
 * or store market data. Starts UNKNOWN; one bad sample makes it INVALID; it
 * returns to VALID only after `validChecks` good samples in a row.
 */
export class ClockGuard {
  private state: ClockStatus = 'UNKNOWN';
  private skew: number | null = null;
  private streak = 0;
  private lastSampleAt: Date | null = null;

  constructor(private readonly opts: ClockGuardOptions) {}

  get status(): ClockStatus {
    return this.state;
  }

  get skewMs(): number | null {
    return this.skew;
  }

  get lastCheckedAt(): Date | null {
    return this.lastSampleAt;
  }

  get isValid(): boolean {
    return this.state === 'VALID';
  }

  /** Skew = local receive time − Indodax time at that moment. Positive: local clock is ahead. */
  static skewOf(s: TimeSample): number {
    return s.fetchedAt.getTime() - (s.serverTime.getTime() + (s.cacheAgeSec ?? 0) * 1000);
  }

  observe(sample: TimeSample): ClockStatus {
    const skew = ClockGuard.skewOf(sample);
    this.skew = skew;
    this.lastSampleAt = sample.fetchedAt;
    const previous = this.state;
    if (Math.abs(skew) > this.opts.maxSkewMs) {
      this.streak = 0;
      this.state = 'INVALID';
    } else {
      this.streak++;
      if (this.state !== 'VALID' && this.streak >= this.opts.validChecks) this.state = 'VALID';
    }
    if (this.state !== previous) this.opts.onChange?.(this.state, skew);
    return this.state;
  }

  assertValid(): void {
    if (this.state !== 'VALID') throw new ClockNotValidError(this.state, this.skew);
  }
}
