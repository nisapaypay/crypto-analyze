import type { Logger } from '../app/logger/logger.js';
import type { AdviceReason } from '../bot/messages/notifications.js';
import { TIMEFRAME_SECONDS } from '../market/types.js';
import type { PairMarketData } from '../market/market-data-service.js';
import type { ActiveBuy, ActiveBuyReader } from './active-buys.js';
import type { JobRunner, RunOutcome } from './job-runner.js';
import type { RunItem, SchedulerRepository } from './scheduler-repository.js';

/**
 * What the monitor may send: a protective advice for one signal. Built by the
 * composition root as an ADVICE_DO_NOT_ENTER notification through the 5C
 * notifier (dedup key per signal + reason, 5C rules for hours/pause).
 */
export interface AdviceRequest {
  signal: ActiveBuy;
  reason: AdviceReason;
  at: Date;
}

export interface EntryMonitorDeps {
  /** Read-only BUY reader. The monitor has no way to write trading_signals. */
  buys: ActiveBuyReader;
  /** Local-clock-guarded market data, refreshed with force (M2, unchanged). */
  refresh: (pair: string) => Promise<PairMarketData>;
  advise: (a: AdviceRequest) => Promise<unknown>;
  repo: SchedulerRepository;
  runner: JobRunner;
  /** /pause stops the entry monitor. */
  isPaused: () => Promise<boolean>;
  isLockHeld: () => boolean;
  logger: Logger;
  tickMs: number;
  /** Hard cap of ticks per signal (request budget: 5 requests × 31 ticks). */
  maxTicksPerSignal: number;
  now?: () => Date;
}

export type SignalCheck =
  | { action: 'advise'; reason: AdviceReason }
  /** Market traded inside the entry range: the BUY may have filled; stop (M4 marks POSSIBLY_FILLED). */
  | { action: 'stop'; why: 'ENTRY_RANGE_TOUCHED' }
  | { action: 'continue' };

/**
 * Pure assessment of one ACTIVE BUY against fresh market data. Never claims
 * "do not enter" once the market has traded inside the entry range (a fill is
 * then possible; the M4 lifecycle takes over).
 */
export function assess(s: ActiveBuy, d: PairMarketData): SignalCheck {
  const codes = new Set(d.quality.issues.map((i) => i.code));
  if (d.pairInfo?.isMaintenance || d.pairInfo?.isSuspended || codes.has('PAIR_MAINTENANCE') || codes.has('PAIR_SUSPENDED')) {
    return { action: 'advise', reason: 'PAIR_MAINTENANCE' };
  }
  if (d.quality.status === 'UNAVAILABLE') return { action: 'advise', reason: 'DATA_UNAVAILABLE' };

  // Any trade at/below entry max after the signal candle (final or still forming) = possibly filled.
  const firstOpen = s.candleOpenTime.getTime() + TIMEFRAME_SECONDS[d.timeframe] * 1000;
  const candles = [...d.finalCandles, ...(d.pendingCandle ? [d.pendingCandle] : [])];
  const touched = candles.some((c) => c.openTime.getTime() >= firstOpen && !c.volume.isZero() && c.low.lte(s.entryMax));
  if (touched) return { action: 'stop', why: 'ENTRY_RANGE_TOUCHED' };

  const bid = d.metrics?.bestBid ?? d.ticker?.bid ?? null;
  const ask = d.metrics?.bestAsk ?? d.ticker?.ask ?? null;
  if (bid && bid.lte(s.stopLoss)) return { action: 'advise', reason: 'BELOW_STOP_LOSS' };
  if (ask && s.chaseLimit && ask.gt(s.chaseLimit)) return { action: 'advise', reason: 'CHASE_LIMIT_EXCEEDED' };
  return { action: 'continue' };
}

/**
 * 1-minute monitoring of ACTIVE BUY recommendations (data + protective advice
 * only). One tick at a time: if the previous tick is still running the next
 * one is skipped (recorded SKIPPED BUSY), never queued. A signal stops being
 * monitored when it is no longer ACTIVE, has expired, was possibly filled,
 * or reached the tick cap. It reads recommendations and writes only its own
 * run records (scheduled_scans / scan_run_items) — never trading_signals.
 */
export class EntryMonitor {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly ticks = new Map<number, number>();
  private readonly stopped = new Set<number>();
  /** Reasons already advised per signal (the notifications table dedup key is the final guarantee). */
  private readonly advised = new Set<string>();

  constructor(private readonly d: EntryMonitorDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) => this.d.logger.error({ err: error instanceof Error ? error.message : error }, 'Tick entry monitor gagal'))
        .finally(() => this.schedule());
    }, this.d.tickMs);
    this.timer.unref?.();
  }

  /** One monitoring tick (public for tests). */
  async tick(): Promise<'idle' | 'paused' | 'busy' | 'duplicate' | 'done' | 'no_lock'> {
    if (!this.d.isLockHeld()) return 'no_lock';
    const now = this.now();
    const buys = (await this.d.buys.activeBuys(now)).filter((b) => !this.stopped.has(b.id) && (this.ticks.get(b.id) ?? 0) < this.d.maxTicksPerSignal);
    if (buys.length === 0) return 'idle';
    if (await this.d.isPaused()) return 'paused';

    const slotAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const key = { kind: 'MONITOR' as const, scope: 'ALL', slotAt };
    if (this.d.runner.busy) {
      // Previous tick still running: skip, do not stack work.
      await this.d.repo.recordNotRun(key, 'SKIPPED', 'BUSY', now);
      return 'busy';
    }
    const result = await this.d.runner.run(key, 'SCHEDULED', () => this.check(buys));
    return result.state === 'busy' ? 'busy' : result.state === 'duplicate' ? 'duplicate' : 'done';
  }

  private async check(buys: ActiveBuy[]): Promise<RunOutcome> {
    const items: RunItem[] = [];
    const outcomes: Record<string, string> = {};
    const byPair = new Map<string, ActiveBuy[]>();
    for (const b of buys) byPair.set(b.pair, [...(byPair.get(b.pair) ?? []), b]);

    for (const [pair, signals] of byPair) {
      let data: PairMarketData;
      try {
        data = await this.d.refresh(pair);
      } catch (error) {
        // Clock not valid / fetch failure: no assessment, no advice this tick.
        const message = error instanceof Error ? error.message : String(error);
        for (const s of signals) {
          items.push({ pair, status: 'FAILED', signalId: s.id, error: message });
          outcomes[`#${s.id}`] = error instanceof Error && error.name === 'ClockNotValidError' ? 'CLOCK_SKEW' : 'FETCH_FAILED';
        }
        continue;
      }
      for (const s of signals) {
        this.ticks.set(s.id, (this.ticks.get(s.id) ?? 0) + 1);
        items.push({ pair, status: data.snapshotId !== null ? 'OK' : 'FAILED', signalId: s.id, marketSnapshotId: data.snapshotId, qualityStatus: data.quality.status });
        const c = assess(s, data);
        if (c.action === 'stop') {
          this.stopped.add(s.id);
          outcomes[`#${s.id}`] = c.why;
        } else if (c.action === 'advise') {
          outcomes[`#${s.id}`] = c.reason;
          const key = `${s.id}:${c.reason}`;
          if (!this.advised.has(key)) {
            this.advised.add(key);
            await this.d.advise({ signal: s, reason: c.reason, at: this.now() });
          }
        } else outcomes[`#${s.id}`] = 'OK';
        if ((this.ticks.get(s.id) ?? 0) >= this.d.maxTicksPerSignal) this.d.logger.warn({ signal: s.id }, 'Batas tick entry monitor tercapai; pemantauan sinyal dihentikan');
      }
    }
    return { status: 'COMPLETED', items, summary: { signals: buys.map((b) => b.id), outcomes } };
  }
}
