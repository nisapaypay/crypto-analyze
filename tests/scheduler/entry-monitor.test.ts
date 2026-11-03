import { describe, expect, it, vi } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { createLogger } from '../../src/app/logger/logger.js';
import type { PairMarketData } from '../../src/market/market-data-service.js';
import type { Candle } from '../../src/market/types.js';
import { chaseLimitFrom, type ActiveBuy, type ActiveBuyReader } from '../../src/scheduler/active-buys.js';
import { ClockNotValidError } from '../../src/scheduler/clock-guard.js';
import { assess, EntryMonitor, type AdviceRequest } from '../../src/scheduler/entry-monitor.js';
import { JobRunner } from '../../src/scheduler/job-runner.js';
import { InMemorySchedulerRepository } from '../../src/scheduler/scheduler-repository.js';
import { STRATEGY_DEFAULTS } from '../../src/strategy/config.js';
import { evaluateStrategy } from '../../src/strategy/strategy-engine.js';
import { engineInput } from '../helpers/strategy.js';

const logger = createLogger({ level: 'silent' });
const T = (min: number) => new Date(Date.UTC(2026, 10, 3, 14, 0) + min * 60_000); // 21:00 WIB + min

const SIGNAL: ActiveBuy = {
  id: 7,
  pair: 'xrp_idr',
  createdAt: T(1.5),
  expiresAt: T(30), // candle 21:00–21:15 → valid until 21:30 WIB
  candleOpenTime: new Date(T(0).getTime() - 15 * 60_000),
  entryMin: new Dec('41000'),
  entryMax: new Dec('41100'),
  stopLoss: new Dec('40600'),
  chaseLimit: new Dec('41250'),
};

const candle = (openMin: number, low: string, volume = '10'): Candle => ({
  pair: 'xrp_idr',
  timeframe: '15',
  openTime: T(openMin),
  open: new Dec('41200'),
  high: new Dec('41300'),
  low: new Dec(low),
  close: new Dec('41200'),
  volume: new Dec(volume),
});

function market(o: { bid?: string; ask?: string; status?: 'OK' | 'DEGRADED' | 'UNAVAILABLE'; codes?: string[]; maintenance?: boolean; candles?: Candle[]; pending?: Candle | null; snapshotId?: bigint | null } = {}): PairMarketData {
  return {
    pair: 'xrp_idr',
    timeframe: '15',
    pairInfo: { isMaintenance: o.maintenance ?? false, isSuspended: false } as PairMarketData['pairInfo'],
    metrics: o.bid || o.ask ? ({ bestBid: new Dec(o.bid ?? '41150'), bestAsk: new Dec(o.ask ?? '41160') } as PairMarketData['metrics']) : ({ bestBid: new Dec('41150'), bestAsk: new Dec('41160') } as PairMarketData['metrics']),
    ticker: null,
    quality: { status: o.status ?? 'OK', issues: (o.codes ?? []).map((code) => ({ code, severity: 'critical', message: code })), checkedAt: T(2) },
    finalCandles: o.candles ?? [candle(-15, '41050')], // the signal candle itself may be below entry max: not counted
    pendingCandle: o.pending ?? candle(0, '41150'),
    snapshotId: o.snapshotId === undefined ? 99n : o.snapshotId,
  } as unknown as PairMarketData;
}

describe('assess (pure)', () => {
  it('price above entry max but within the chase limit: keep monitoring, no advice', () => {
    expect(assess(SIGNAL, market({ bid: '41150', ask: '41200' }))).toEqual({ action: 'continue' });
  });

  it('price traded inside the entry range after the signal candle: stop (possibly filled), never advise', () => {
    expect(assess(SIGNAL, market({ pending: candle(0, '41080') }))).toEqual({ action: 'stop', why: 'ENTRY_RANGE_TOUCHED' });
    expect(assess(SIGNAL, market({ pending: candle(0, '41080', '0') }))).toEqual({ action: 'continue' }); // zero-volume: no trade
    // Even with bid below SL afterwards, a possible fill means no "do not enter".
    expect(assess(SIGNAL, market({ pending: candle(0, '41080'), bid: '40500' }))).toEqual({ action: 'stop', why: 'ENTRY_RANGE_TOUCHED' });
  });

  it('best ask above the chase limit → CHASE_LIMIT_EXCEEDED', () => {
    expect(assess(SIGNAL, market({ bid: '41240', ask: '41251' }))).toEqual({ action: 'advise', reason: 'CHASE_LIMIT_EXCEEDED' });
    expect(assess(SIGNAL, market({ bid: '41240', ask: '41250' }))).toEqual({ action: 'continue' });
  });

  it('bid at or below the stop loss before any fill → BELOW_STOP_LOSS', () => {
    expect(assess(SIGNAL, market({ bid: '40600', ask: '40700', pending: candle(0, '41150') }))).toEqual({ action: 'advise', reason: 'BELOW_STOP_LOSS' });
  });

  it('data UNAVAILABLE → DATA_UNAVAILABLE; maintenance / suspend → PAIR_MAINTENANCE (takes precedence)', () => {
    expect(assess(SIGNAL, market({ status: 'UNAVAILABLE', codes: ['ORDERBOOK_STALE'] }))).toEqual({ action: 'advise', reason: 'DATA_UNAVAILABLE' });
    expect(assess(SIGNAL, market({ status: 'UNAVAILABLE', codes: ['PAIR_MAINTENANCE'] }))).toEqual({ action: 'advise', reason: 'PAIR_MAINTENANCE' });
    expect(assess(SIGNAL, market({ maintenance: true }))).toEqual({ action: 'advise', reason: 'PAIR_MAINTENANCE' });
  });
});

describe('chase limit reconstruction', () => {
  it('equals the M4 plan.chaseLimit exactly, from stored entry max + indicator snapshot', () => {
    const d = evaluateStrategy(engineInput());
    expect(d.decision).toBe('BUY_CANDIDATE');
    const stored = JSON.parse(JSON.stringify(d.indicators)) as unknown; // as persisted in trading_signals.indicator_snapshot
    expect(chaseLimitFrom(d.plan!.entry.max, stored, STRATEGY_DEFAULTS.signal.chaseAtr)!.eq(d.plan!.chaseLimit)).toBe(true);
    expect(chaseLimitFrom(d.plan!.entry.max, {}, 0.5)).toBeNull();
  });
});

/** Reader with the same filter as the Prisma one: ACTIVE and not expired. */
class FakeReader implements ActiveBuyReader {
  constructor(public rows: (ActiveBuy & { lifecycle: string })[]) {}
  async activeBuys(now: Date) {
    return this.rows.filter((r) => r.lifecycle === 'ACTIVE' && r.expiresAt > now);
  }
}

function harness(opts: { refresh?: (pair: string) => Promise<PairMarketData>; paused?: boolean; maxTicks?: number }) {
  let now = T(2);
  const reader = new FakeReader([{ ...SIGNAL, lifecycle: 'ACTIVE' }]);
  const repo = new InMemorySchedulerRepository();
  const advice: AdviceRequest[] = [];
  const refresh = vi.fn(opts.refresh ?? (async () => market()));
  const runner = new JobRunner(repo, logger, { watchdogMs: 5_000, now: () => now });
  const m = new EntryMonitor({
    buys: reader,
    refresh,
    advise: async (a) => void advice.push(a),
    repo,
    runner,
    isPaused: async () => opts.paused ?? false,
    isLockHeld: () => true,
    logger,
    tickMs: 60_000,
    maxTicksPerSignal: opts.maxTicks ?? 31,
    now: () => now,
  });
  const tickAt = (min: number) => ((now = T(min)), m.tick());
  return { m, reader, repo, advice, refresh, runner, tickAt };
}

describe('EntryMonitor', () => {
  it('same reason on every minute → advised once; a new reason → one more advice', async () => {
    let bid = '41150';
    let ask = '41300';
    const h = harness({ refresh: async () => market({ bid, ask }) });
    for (let i = 2; i < 6; i++) expect(await h.tickAt(i)).toBe('done');
    expect(h.advice.map((a) => a.reason)).toEqual(['CHASE_LIMIT_EXCEEDED']);
    bid = '40600';
    ask = '40700';
    await h.tickAt(6);
    await h.tickAt(7);
    expect(h.advice.map((a) => a.reason)).toEqual(['CHASE_LIMIT_EXCEEDED', 'BELOW_STOP_LOSS']);
    expect(h.repo.runs.filter((r) => r.kind === 'MONITOR' && r.status === 'COMPLETED')).toHaveLength(6);
    expect(h.repo.items.every((i) => i.signalId === 7)).toBe(true);
  });

  it('stops automatically when the BUY expires, is no longer ACTIVE, or the entry range was touched', async () => {
    const expired = harness({});
    expect(await expired.tickAt(30)).toBe('idle'); // expiresAt 21:30 reached
    expect(expired.refresh).not.toHaveBeenCalled();

    const filled = harness({});
    filled.reader.rows[0]!.lifecycle = 'POSSIBLY_FILLED';
    expect(await filled.tickAt(5)).toBe('idle');
    expect(filled.refresh).not.toHaveBeenCalled();

    const touched = harness({ refresh: async () => market({ pending: candle(0, '41050') }) });
    expect(await touched.tickAt(3)).toBe('done');
    expect(await touched.tickAt(4)).toBe('idle');
    expect(touched.refresh).toHaveBeenCalledTimes(1);
    expect(touched.advice).toEqual([]);
  });

  it('a tick never stacks: while the previous one runs, the next is SKIPPED (BUSY) without fetching', async () => {
    let release!: () => void;
    const h = harness({ refresh: () => new Promise((r) => (release = () => r(market()))) });
    const first = h.tickAt(2);
    await new Promise((r) => setTimeout(r, 5));
    expect(await h.tickAt(3)).toBe('busy');
    expect(h.refresh).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe('done');
    expect(h.repo.runs.map((r) => `${r.status}${r.cause ? `:${r.cause}` : ''}`)).toEqual(['COMPLETED', 'SKIPPED:BUSY']);
  });

  it('/pause stops the monitor (no fetch)', async () => {
    const h = harness({ paused: true });
    expect(await h.tickAt(3)).toBe('paused');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('request budget: at most 31 ticks (5 requests each) per signal', async () => {
    const h = harness({ maxTicks: 31 });
    h.reader.rows[0]!.expiresAt = T(500);
    for (let i = 2; i < 50; i++) await h.tickAt(i);
    expect(h.refresh).toHaveBeenCalledTimes(31);
  });

  it('invalid clock (or fetch failure): no assessment and no advice that tick', async () => {
    const h = harness({ refresh: async () => { throw new ClockNotValidError('INVALID', 45_000); } });
    expect(await h.tickAt(3)).toBe('done');
    expect(h.advice).toEqual([]);
    expect(h.repo.items[0]).toMatchObject({ status: 'FAILED', signalId: 7 });
    expect(h.repo.runs[0]!.summary).toMatchObject({ outcomes: { '#7': 'CLOCK_SKEW' } });
  });

  it('the monitor has no way to create a BUY or touch a signal: its only outputs are run records and advice', async () => {
    const h = harness({ refresh: async () => market({ bid: '40000', ask: '40100' }) });
    await h.tickAt(3);
    expect(h.advice.every((a) => a.reason !== ('BUY_CANDIDATE' as never))).toBe(true);
    expect(Object.keys(h.reader.rows[0]!).sort()).toEqual(Object.keys({ ...SIGNAL, lifecycle: 'ACTIVE' }).sort());
    expect(h.reader.rows[0]!.lifecycle).toBe('ACTIVE');
  });
});
