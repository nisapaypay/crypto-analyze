import { randomUUID } from 'node:crypto';
import type { Logger } from '../app/logger/logger.js';
import type { ClockGuard, TimeSample } from './clock-guard.js';
import type { SchedulerConfig } from './config.js';
import type { JobRunner, RunOutcome } from './job-runner.js';
import type { RunItem, RunKey, SchedulerRepository } from './scheduler-repository.js';
import type { ServerClock } from './server-clock.js';
import { isLate, SLOT_MS, slotAtOrAfter, slotAtOrBefore, slotKind, slotsBetween, type SlotKind } from './slots.js';

export interface SchedulerSettings {
  scanningEnabled: boolean;
  intervalMinutes: number;
  activeHours: { start: string; end: string };
}

/** What one slot task reports back (items link the run to snapshots/signals). */
export interface SlotTaskReport {
  items: RunItem[];
  summary?: Record<string, unknown>;
}

/** Receives every period in which a pair got no market snapshot ([from, to)). */
export interface SnapshotGapSink {
  recordSnapshotGap(pair: string, from: Date, to: Date, cause: string, details?: Record<string, unknown>): Promise<void>;
}

export interface ContinuityMaintainer {
  maintain(pairs: string[], trigger: string): Promise<unknown>;
}

export interface ScanSchedulerDeps {
  repo: SchedulerRepository;
  runner: JobRunner;
  /** Local clock vs Indodax: gates TRADING DECISIONS only. */
  clock: ClockGuard;
  /** Trusted Indodax time: gates DATA COLLECTION (independent of the local clock). */
  serverClock: ServerClock;
  preflight: (pair: string) => Promise<TimeSample>;
  settings: () => Promise<SchedulerSettings>;
  watchlist: () => Promise<string[]>;
  /** M4 StrategyService.scan through the local-clock-guarded market (decisions + data). */
  strategyScan: (pairs: string[]) => Promise<SlotTaskReport>;
  /** Market data only, through the server-clock MarketDataService. */
  collect: (pairs: string[]) => Promise<SlotTaskReport>;
  gaps: SnapshotGapSink;
  continuity?: ContinuityMaintainer;
  isLockHeld: () => boolean;
  logger: Logger;
  timeZone: string;
  config: SchedulerConfig;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface SchedulerStatus {
  started: boolean;
  nextSlotAt: Date | null;
  nextSlotKind: SlotKind | null;
  consecutiveFailures: number;
  breakerOpen: boolean;
  lastRun: { kind: string; status: string; slotAt: Date; cause: string | null } | null;
  serverTime: { trusted: boolean; reason: string | null };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Wall-clock slot scheduler. Each 15m slot (candle close + 90 s) produces one
 * recorded outcome per kind (COMPLETED, FAILED, SKIPPED, MISSED) with a cause,
 * and every pair without a stored snapshot for that slot gets a PERMANENT
 * snapshot gap. Two independent time gates:
 *   - trading decisions need a VALID local clock (ClockGuard);
 *   - data collection needs trusted Indodax server time (ServerClock).
 */
export class ScanScheduler {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private nextSlot: Date | null = null;
  private failures = 0;
  private lastRun: SchedulerStatus['lastRun'] = null;
  private nextKind: SlotKind | null = null;
  private startedAt: Date | null = null;
  readonly instanceId = randomUUID();

  constructor(private readonly d: ScanSchedulerDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private sleep(ms: number): Promise<void> {
    return (this.d.sleep ?? realSleep)(ms);
  }

  status(): SchedulerStatus {
    return {
      started: this.started,
      nextSlotAt: this.nextSlot,
      nextSlotKind: this.nextKind,
      consecutiveFailures: this.failures,
      breakerOpen: this.failures >= this.d.config.circuitBreakerFailures,
      lastRun: this.lastRun,
      serverTime: { trusted: this.d.serverClock.isTrusted, reason: this.d.serverClock.untrustedReason() },
    };
  }

  /**
   * One preflight request; the sample feeds both time gates. While either gate
   * is not yet established, one more sample is taken a moment later (both
   * need two good samples in a row) — at most one extra request.
   */
  private async sample(pair: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const s = await this.d.preflight(pair);
      this.d.clock.observe(s);
      this.d.serverClock.observe(s);
      if (!this.d.clock.isValid || !this.d.serverClock.isTrusted) {
        await this.sleep(2_000);
        const again = await this.d.preflight(pair);
        this.d.clock.observe(again);
        this.d.serverClock.observe(again);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  }

  /** Fail-closed startup check: samples until both gates are established (or attempts run out). */
  async verifyClock(pair: string, attempts = 3): Promise<boolean> {
    for (let i = 0; i < attempts && !(this.d.clock.isValid && this.d.serverClock.isTrusted); i++) {
      const r = await this.sample(pair);
      if (!r.ok) this.d.logger.warn({ err: r.error }, 'Pemeriksaan waktu gagal (Indodax tidak dapat dihubungi)');
    }
    return this.d.clock.isValid;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.recover();
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextSlot = null;
  }

  /**
   * After a restart: interrupted runs closed, every slot between the last
   * recorded slot and now recorded MISSED (OFFLINE) with snapshot gaps, one
   * immediate RECOVERY collection and a candle continuity pass. Strategy
   * decisions wait for the next on-time slot.
   */
  async recover(): Promise<{ interrupted: number; missed: number }> {
    const now = this.now();
    this.startedAt = now;
    const interrupted = await this.d.repo.interruptRunning(now);
    const last = await this.d.repo.lastSlotAt();
    let missed = 0;
    if (last) missed = await this.recordMissed(last, now, 'OFFLINE');
    await this.writeState(now);
    if (interrupted > 0 || missed > 0) {
      this.d.logger.warn({ interrupted, missed }, 'Pemulihan scheduler: run terputus/slot terlewat dicatat');
      await this.runRecoveryCollect(now);
    }
    await this.maintainContinuity('RECOVERY');
    return { interrupted, missed };
  }

  /** Called by the heartbeat when the process did not run between `from` and `to`. */
  async onWake(from: Date, to: Date): Promise<void> {
    // The monotonic clock stood still while asleep: server time must be re-established.
    this.d.serverClock.reset('setelah sleep/stall');
    const missed = await this.recordMissed(from, to, 'SLEEP');
    this.d.logger.warn({ from: from.toISOString(), to: to.toISOString(), missed }, 'Proses tidak berjalan (sleep/stall): slot terlewat dicatat');
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.scheduleNext();
    if (missed > 0) await this.runRecoveryCollect(to);
    await this.maintainContinuity('WAKE');
  }

  /**
   * Heartbeat: persists liveness and, while a time gate is not established,
   * re-checks it (one or two requests per minute only in that state).
   */
  async heartbeat(now: Date, watchlistPair?: string): Promise<void> {
    if (!this.d.clock.isValid || !this.d.serverClock.isTrusted) await this.sample(watchlistPair ?? this.d.config.fallbackClockPair);
    await this.writeState(now);
  }

  private writeState(now: Date): Promise<void> {
    return this.d.repo.writeState({
      instanceId: this.instanceId,
      startedAt: this.startedAt ?? now,
      lastHeartbeatAt: now,
      lastSlotAt: this.lastRun?.slotAt ?? null,
      clockStatus: this.d.clock.status,
      clockSkewMs: this.d.clock.skewMs,
    });
  }

  private rules(s: SchedulerSettings) {
    return { settleSec: this.d.config.settleSec, intervalMinutes: s.intervalMinutes, timeZone: this.d.timeZone, activeHours: s.activeHours };
  }

  private async recordMissed(from: Date, to: Date, cause: string): Promise<number> {
    const floor = new Date(to.getTime() - this.d.config.maxMissedLookbackMs);
    const start = from > floor ? from : floor;
    // A slot still within the stale window runs normally; older ones are missed.
    const cutoff = new Date(to.getTime() - this.d.config.staleSlotSec * 1000);
    const slots = slotsBetween(start, cutoff, this.d.config.settleSec);
    if (slots.length === 0) return 0;
    const s = await this.d.settings();
    let n = 0;
    for (const slot of slots) {
      if (await this.d.repo.recordNotRun({ kind: slotKind(slot, this.rules(s)), scope: 'ALL', slotAt: slot }, 'MISSED', cause, to)) n++;
    }
    // One gap per pair for the whole missed range (merged with adjacent gaps of the same cause).
    const gapFrom = from < floor ? from : slots[0]!;
    await this.recordGaps(await this.d.watchlist().catch(() => []), gapFrom, new Date(slots.at(-1)!.getTime() + SLOT_MS), cause);
    if (from < floor) this.d.logger.warn({ from: from.toISOString() }, 'Periode offline melebihi batas pencatatan slot; seluruh periode dicatat sebagai gap data');
    return n;
  }

  private async recordGaps(pairs: string[], from: Date, to: Date, cause: string, details?: Record<string, unknown>): Promise<void> {
    for (const pair of pairs) {
      await this.d.gaps.recordSnapshotGap(pair, from, to, cause, details).catch((e: unknown) => this.d.logger.error({ pair, err: errText(e) }, 'Gagal mencatat gap data'));
    }
  }

  private scheduleNext(): void {
    if (!this.started) return;
    const now = this.now();
    const next = slotAtOrAfter(new Date(now.getTime() + 1), this.d.config.settleSec);
    this.nextSlot = next;
    void this.d
      .settings()
      .then((s) => (this.nextKind = slotKind(next, this.rules(s))))
      .catch(() => (this.nextKind = null));
    this.timer = setTimeout(() => {
      void this.onSlot(next)
        .catch((error: unknown) => this.d.logger.error({ err: errText(error) }, 'Slot scheduler gagal di luar run'))
        .finally(() => this.scheduleNext());
    }, Math.max(0, next.getTime() - now.getTime()));
  }

  /** Run one slot (public for tests). */
  async onSlot(slot: Date): Promise<void> {
    const now = this.now();
    const settings = await this.d.settings();
    const planned = slotKind(slot, this.rules(settings));
    const slotEnd = new Date(slot.getTime() + SLOT_MS);
    const key = (kind: SlotKind): RunKey => ({ kind, scope: 'ALL', slotAt: slot });

    if (!this.d.isLockHeld()) {
      // Another instance may hold the lock and collect: no gap is claimed here.
      await this.d.repo.recordNotRun(key(planned), 'SKIPPED', 'LOCK_LOST', now);
      return;
    }
    const pairs = await this.d.watchlist();
    if (isLate(slot, now, this.d.config.staleSlotSec)) {
      // Never decide on a stale slot (e.g. 21:46:30 executed at 22:03 after sleep).
      if (await this.d.repo.recordNotRun(key(planned), 'MISSED', 'LATE', now)) await this.recordGaps(pairs, slot, slotEnd, 'LATE');
      return;
    }

    const pre = await this.sample(pairs[0] ?? this.d.config.fallbackClockPair);
    if (!pre.ok) {
      const r = await this.d.runner.run(key(planned), 'SCHEDULED', async () => ({ status: 'FAILED', cause: 'API_ERROR', error: pre.error }));
      if (r.state === 'done') {
        this.note(planned, slot, r.outcome);
        await this.recordGaps(pairs, slot, slotEnd, 'API_ERROR', { error: pre.error });
      }
      return;
    }

    let kind = planned;
    if (kind === 'STRATEGY_SCAN' && !settings.scanningEnabled) {
      // /pause stops decisions only; market data collection continues.
      await this.d.repo.recordNotRun(key(kind), 'SKIPPED', 'PAUSED', now);
      kind = 'COLLECT';
    } else if (kind === 'STRATEGY_SCAN' && !this.d.clock.isValid) {
      // Local clock not valid: no trading decision; data may still be collected on server time.
      await this.d.repo.recordNotRun(key(kind), 'SKIPPED', 'CLOCK_SKEW', now);
      kind = 'COLLECT';
    }
    if (kind === 'COLLECT' && !this.d.serverClock.isTrusted) {
      const reason = this.d.serverClock.untrustedReason();
      if (await this.d.repo.recordNotRun(key(kind), 'SKIPPED', 'SERVER_TIME_UNTRUSTED', now)) {
        await this.recordGaps(pairs, slot, slotEnd, 'SERVER_TIME_UNTRUSTED', { reason });
      }
      return;
    }

    const result = await this.d.runner.run(key(kind), 'SCHEDULED', () => this.slotTask(kind, slot, pairs));
    if (result.state === 'busy') {
      if (await this.d.repo.recordNotRun(key(kind), 'SKIPPED', 'BUSY', this.now())) await this.recordGaps(pairs, slot, slotEnd, 'BUSY');
      return;
    }
    if (result.state === 'duplicate') return;
    this.note(kind, slot, result.outcome);

    // Pairs without a stored snapshot for this slot are gaps (cause per pair).
    const ok = new Set((result.outcome.items ?? []).filter((i) => i.status === 'OK').map((i) => i.pair));
    for (const pair of pairs.filter((p) => !ok.has(p))) {
      const item = result.outcome.items?.find((i) => i.pair === pair);
      const cause = item ? 'FETCH_FAILED' : (result.outcome.cause ?? result.outcome.status);
      await this.recordGaps([pair], slot, slotEnd, cause, { error: item?.error ?? result.outcome.error ?? null });
    }

    // Hourly candle continuity pass (on the slot after each full hour).
    if (new Date(slot.getTime() - this.d.config.settleSec * 1000).getUTCMinutes() === 0) await this.maintainContinuity('HOURLY');
  }

  private note(kind: SlotKind, slot: Date, o: RunOutcome): void {
    this.lastRun = { kind, status: o.status, slotAt: slot, cause: o.cause ?? null };
    if (o.status === 'COMPLETED') this.failures = 0;
    else if (o.status === 'FAILED') this.failures++;
  }

  private async slotTask(kind: SlotKind, slot: Date, pairs: string[]): Promise<RunOutcome> {
    if (pairs.length === 0) return { status: 'COMPLETED', cause: 'EMPTY_WATCHLIST', items: [] };
    const breakerOpen = this.failures >= this.d.config.circuitBreakerFailures;
    const delays = breakerOpen ? [] : [...this.d.config.slotRetryDelaysMs];
    for (let attempt = 0; ; attempt++) {
      try {
        const report = await withTimeout(kind === 'STRATEGY_SCAN' ? this.d.strategyScan(pairs) : this.d.collect(pairs), this.d.config.watchdogMs);
        const failed = report.items.filter((i) => i.status !== 'OK').length;
        return {
          status: 'COMPLETED',
          cause: failed > 0 ? `PARTIAL_${failed}_OF_${report.items.length}` : undefined,
          items: report.items,
          summary: { pairs: pairs.length, ...report.summary },
          retryCount: attempt,
        };
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'ClockNotValidError') return { status: 'SKIPPED', cause: 'CLOCK_SKEW', error: errText(error), retryCount: attempt };
        if (name === 'ServerTimeUntrustedError') return { status: 'SKIPPED', cause: 'SERVER_TIME_UNTRUSTED', error: errText(error), retryCount: attempt };
        const delay = delays.shift();
        if (delay === undefined || isLate(slot, new Date(this.now().getTime() + delay), this.d.config.staleSlotSec)) {
          return { status: 'FAILED', cause: 'TASK_ERROR', error: errText(error), retryCount: attempt };
        }
        this.d.logger.warn({ kind, slot: slot.toISOString(), attempt, err: errText(error) }, 'Slot gagal; dicoba ulang');
        await this.sleep(delay);
        const pre = await this.sample(pairs[0]!);
        if (!pre.ok) return { status: 'FAILED', cause: 'API_ERROR', error: pre.error, retryCount: attempt + 1 };
        if (kind === 'STRATEGY_SCAN' && !this.d.clock.isValid) return { status: 'SKIPPED', cause: 'CLOCK_SKEW', retryCount: attempt + 1 };
        if (kind === 'COLLECT' && !this.d.serverClock.isTrusted) return { status: 'SKIPPED', cause: 'SERVER_TIME_UNTRUSTED', retryCount: attempt + 1 };
      }
    }
  }

  /** Off-slot data collection after a restart/wake. It never fills a missed slot (those stay gaps). */
  private async runRecoveryCollect(now: Date): Promise<void> {
    const pairs = await this.d.watchlist().catch(() => []);
    const pre = await this.sample(pairs[0] ?? this.d.config.fallbackClockPair);
    const result = await this.d.runner.run({ kind: 'COLLECT', scope: 'ALL', slotAt: now }, 'RECOVERY', async () => {
      if (!pre.ok) return { status: 'FAILED', cause: 'API_ERROR', error: pre.error };
      if (!this.d.serverClock.isTrusted) return { status: 'SKIPPED', cause: 'SERVER_TIME_UNTRUSTED', error: this.d.serverClock.untrustedReason() ?? undefined };
      return this.slotTask('COLLECT', slotAtOrBefore(now, this.d.config.settleSec), pairs);
    });
    if (result.state === 'done') this.d.logger.info({ status: result.outcome.status, cause: result.outcome.cause }, 'Pengumpulan data pemulihan selesai');
  }

  private async maintainContinuity(trigger: string): Promise<void> {
    if (!this.d.continuity) return;
    try {
      await this.d.continuity.maintain(await this.d.watchlist(), trigger);
    } catch (error) {
      this.d.logger.error({ trigger, err: errText(error) }, 'Pemeriksaan kontinuitas candle gagal');
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`batas waktu ${Math.round(ms / 1000)} dtk terlampaui`)), ms)));
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
