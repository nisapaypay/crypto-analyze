import type { Logger } from '../app/logger/logger.js';
import type { RunItem, RunKey, RunTrigger, SchedulerRepository } from './scheduler-repository.js';

export interface RunOutcome {
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  cause?: string;
  error?: string;
  summary?: unknown;
  items?: RunItem[];
  retryCount?: number;
}

export type RunResult =
  | { state: 'done'; runId: number; outcome: RunOutcome }
  /** Another run of this runner is still in progress (single flight). */
  | { state: 'busy' }
  /** A run for this (kind, scope, slot) already exists. */
  | { state: 'duplicate' };

export class WatchdogTimeout extends Error {
  constructor(ms: number) {
    super(`run melebihi batas waktu ${Math.round(ms / 1000)} dtk`);
    this.name = 'WatchdogTimeout';
  }
}

/**
 * Single-flight executor backed by the run table: at most one run at a time
 * per runner, at most one run per (kind, scope, slot) ever (unique key), every
 * run ends with a final status. The watchdog bounds a run's duration; a task
 * that ignores it keeps running in the background but no longer holds the slot.
 */
export class JobRunner {
  private current: Promise<unknown> | null = null;

  constructor(
    private readonly repo: SchedulerRepository,
    private readonly logger: Logger,
    private readonly opts: { watchdogMs: number; now?: () => Date },
  ) {}

  get busy(): boolean {
    return this.current !== null;
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  async run(key: RunKey, trigger: RunTrigger, task: (runId: number) => Promise<RunOutcome>): Promise<RunResult> {
    if (this.current) return { state: 'busy' };
    let release!: () => void;
    this.current = new Promise<void>((resolve) => (release = resolve));
    try {
      const runId = await this.repo.claim(key, trigger, this.now());
      if (runId === null) return { state: 'duplicate' };
      let outcome: RunOutcome;
      try {
        outcome = await withWatchdog(task(runId), this.opts.watchdogMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = { status: 'FAILED', cause: error instanceof WatchdogTimeout ? 'WATCHDOG' : 'ERROR', error: message };
        this.logger.error({ kind: key.kind, scope: key.scope, slot: key.slotAt.toISOString(), err: message }, 'Run scheduler gagal');
      }
      if (outcome.items?.length) await this.repo.addItems(runId, outcome.items).catch((e: unknown) => this.logger.warn({ err: e instanceof Error ? e.message : e }, 'Gagal menyimpan item run'));
      await this.repo.finish(runId, outcome.status, {
        now: this.now(),
        cause: outcome.cause ?? null,
        error: outcome.error ?? null,
        summary: outcome.summary,
        ...(outcome.retryCount !== undefined ? { retryCount: outcome.retryCount } : {}),
      });
      return { state: 'done', runId, outcome };
    } finally {
      this.current = null;
      release();
    }
  }

  /** Wait for the running job, at most `ms`. True if nothing is running anymore. */
  async drain(ms: number): Promise<boolean> {
    if (!this.current) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
    const done = this.current.then(() => true as const);
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function withWatchdog<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new WatchdogTimeout(ms)), ms)));
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
