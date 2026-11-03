export interface HeartbeatOptions {
  intervalMs: number;
  /** A gap between ticks larger than this means the process did not run (sleep / stall). */
  sleepDetectMs: number;
  onTick: (now: Date) => Promise<void> | void;
  onWake: (from: Date, to: Date) => Promise<void> | void;
  now?: () => Date;
}

/**
 * Periodic tick that detects lost time. Node has no sleep/wake event, but a
 * timer that fires much later than scheduled means the machine was asleep or
 * the process was stalled; `onWake` receives the missing interval.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private last: Date | null = null;
  private stopped = true;

  constructor(private readonly opts: HeartbeatOptions) {}

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  start(): void {
    this.stopped = false;
    this.last = this.now();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const now = this.now();
    const previous = this.last ?? now;
    this.last = now;
    try {
      if (now.getTime() - previous.getTime() > this.opts.sleepDetectMs) await this.opts.onWake(previous, now);
      await this.opts.onTick(now);
    } finally {
      this.schedule();
    }
  }
}
