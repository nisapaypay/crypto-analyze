import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/app/logger/logger.js';
import { ClockGuard, ClockNotValidError, type TimeSample } from '../../src/scheduler/clock-guard.js';
import { SCHEDULER_DEFAULTS } from '../../src/scheduler/config.js';
import { InMemoryGapRepository } from '../../src/scheduler/data-gaps.js';
import { JobRunner } from '../../src/scheduler/job-runner.js';
import { ScanScheduler, type SchedulerSettings, type SlotTaskReport } from '../../src/scheduler/scan-scheduler.js';
import { InMemorySchedulerRepository } from '../../src/scheduler/scheduler-repository.js';
import { ServerClock, ServerTimeUntrustedError } from '../../src/scheduler/server-clock.js';
import { collectReport } from '../../src/scheduler/tasks.js';
import type { PairMarketData } from '../../src/market/market-data-service.js';

const wib = (hhmmss: string, day = '2026-11-03') => new Date(`${day}T${hhmmss}+07:00`);
const logger = createLogger({ level: 'silent' });
const PAIRS = ['doge_idr', 'xrp_idr'];
const okReport = (pairs: string[]): SlotTaskReport => ({ items: pairs.map((pair) => ({ pair, status: 'OK' as const, marketSnapshotId: 1n })) });

interface HarnessOpts {
  now: Date;
  settings?: Partial<SchedulerSettings>;
  /** Local clock error (seconds): affects only the local-clock gate. */
  skewSec?: number;
  preflightFails?: boolean;
  /** Preflight responses with an unusable cache age → server time cannot be trusted. */
  badServerTime?: boolean;
  lockHeld?: boolean;
  pairs?: string[];
}

function harness(opts: HarnessOpts) {
  let now = opts.now;
  let skewSec = opts.skewSec ?? 0;
  const repo = new InMemorySchedulerRepository();
  const gaps = new InMemoryGapRepository();
  const clock = new ClockGuard({ maxSkewMs: 30_000, validChecks: 2 });
  // Monotonic time follows the (true) test time.
  const serverClock = new ServerClock({ maxDriftMs: 5_000, maxAnchorAgeMs: 20 * 60_000, maxCacheAgeSec: 120, mono: () => now.getTime() });
  const sample = (): TimeSample => ({
    serverTime: now,
    cacheAgeSec: opts.badServerTime ? 9_999 : 0,
    fetchedAt: new Date(now.getTime() + skewSec * 1000),
  });
  // Both gates established at start (as after a successful startup check).
  for (let i = 0; i < 2; i++) {
    clock.observe({ serverTime: now, cacheAgeSec: 0, fetchedAt: now });
    serverClock.observe({ serverTime: now, cacheAgeSec: 0, fetchedAt: now });
  }
  const settings: SchedulerSettings = { scanningEnabled: true, intervalMinutes: 15, activeHours: { start: '09:00', end: '22:00' }, ...opts.settings };
  const preflight = vi.fn(async () => {
    if (opts.preflightFails) throw new Error('Gagal menghubungi Indodax /api/ticker');
    return sample();
  });
  const strategyScan = vi.fn(async (pairs: string[]) => okReport(pairs));
  const collect = vi.fn(async (pairs: string[]) => okReport(pairs));
  const continuity = { maintain: vi.fn(async () => undefined) };
  const sleep = vi.fn(async () => undefined);
  const scheduler = new ScanScheduler({
    repo,
    runner: new JobRunner(repo, logger, { watchdogMs: 60_000, now: () => now }),
    clock,
    serverClock,
    preflight,
    settings: async () => settings,
    watchlist: async () => opts.pairs ?? PAIRS,
    strategyScan,
    collect,
    gaps,
    continuity,
    isLockHeld: () => opts.lockHeld ?? true,
    logger,
    timeZone: 'Asia/Jakarta',
    config: SCHEDULER_DEFAULTS,
    now: () => now,
    sleep,
  });
  return {
    scheduler, repo, gaps, clock, serverClock, preflight, strategyScan, collect, continuity, sleep, settings,
    setNow: (d: Date) => (now = d),
    setSkew: (s: number) => (skewSec = s),
  };
}

const runsOf = (repo: InMemorySchedulerRepository) => repo.runs.map((r) => `${r.kind}:${r.status}${r.cause ? `:${r.cause}` : ''}`);
const gapsOf = (g: InMemoryGapRepository) => g.gaps.map((x) => `${x.kind}:${x.pair}:${x.cause}:${x.status}:${x.gapStart.toISOString()}→${x.gapEnd.toISOString()}`);

describe('slot execution', () => {
  it('active hours: a strategy scan on time, items stored, no gap', async () => {
    const h = harness({ now: wib('09:01:31') });
    await h.scheduler.onSlot(wib('09:01:30'));
    expect(h.strategyScan).toHaveBeenCalledWith(PAIRS);
    expect(h.collect).not.toHaveBeenCalled();
    expect(runsOf(h.repo)).toEqual(['STRATEGY_SCAN:COMPLETED']);
    expect(h.repo.items).toHaveLength(2);
    expect(h.preflight).toHaveBeenCalledTimes(1);
    expect(h.gaps.gaps).toEqual([]);
  });

  it('outside active hours: data collection only — never a strategy scan (22:01:30)', async () => {
    const h = harness({ now: wib('22:01:31') });
    await h.scheduler.onSlot(wib('22:01:30'));
    expect(h.strategyScan).not.toHaveBeenCalled();
    expect(h.collect).toHaveBeenCalledOnce();
    expect(runsOf(h.repo)).toEqual(['COLLECT:COMPLETED']);
  });

  it('last BUY slot 21:46:30 runs on time; when late (22:03 after sleep) it is MISSED and a PERMANENT snapshot gap', async () => {
    const h = harness({ now: wib('21:46:31') });
    await h.scheduler.onSlot(wib('21:46:30'));
    expect(h.strategyScan).toHaveBeenCalledOnce();

    const late = harness({ now: wib('22:03:00') });
    await late.scheduler.onSlot(wib('21:46:30'));
    expect(late.strategyScan).not.toHaveBeenCalled();
    expect(late.preflight).not.toHaveBeenCalled();
    expect(runsOf(late.repo)).toEqual(['STRATEGY_SCAN:MISSED:LATE']);
    expect(gapsOf(late.gaps)).toEqual(PAIRS.map((p) => `SNAPSHOT:${p}:LATE:PERMANENT:2026-11-03T14:46:30.000Z→2026-11-03T15:01:30.000Z`));
  });

  it('/pause: strategy slot SKIPPED (PAUSED), data still collected, no gap', async () => {
    const h = harness({ now: wib('10:01:31'), settings: { scanningEnabled: false } });
    await h.scheduler.onSlot(wib('10:01:30'));
    expect(h.strategyScan).not.toHaveBeenCalled();
    expect(h.collect).toHaveBeenCalledOnce();
    expect(runsOf(h.repo)).toEqual(['STRATEGY_SCAN:SKIPPED:PAUSED', 'COLLECT:COMPLETED']);
    expect(h.gaps.gaps).toEqual([]);
  });

  it('a slot never runs twice', async () => {
    const h = harness({ now: wib('10:01:31') });
    await Promise.all([h.scheduler.onSlot(wib('10:01:30')), h.scheduler.onSlot(wib('10:01:30'))]);
    await h.scheduler.onSlot(wib('10:01:30'));
    expect(h.strategyScan).toHaveBeenCalledOnce();
    expect(h.repo.runs.filter((r) => r.kind === 'STRATEGY_SCAN')).toHaveLength(1);
  });

  it('lost instance lock: nothing runs and no gap is claimed (another instance may collect)', async () => {
    const h = harness({ now: wib('10:01:31'), lockHeld: false });
    await h.scheduler.onSlot(wib('10:01:30'));
    expect(h.preflight).not.toHaveBeenCalled();
    expect(runsOf(h.repo)).toEqual(['STRATEGY_SCAN:SKIPPED:LOCK_LOST']);
    expect(h.gaps.gaps).toEqual([]);
  });

  it('a pair that failed gets its own gap; the other pair is covered', async () => {
    const h = harness({ now: wib('22:16:31') });
    h.collect.mockResolvedValueOnce({ items: [{ pair: 'doge_idr', status: 'OK', marketSnapshotId: 5n }, { pair: 'xrp_idr', status: 'FAILED', error: 'timeout' }] });
    await h.scheduler.onSlot(wib('22:16:30'));
    expect(runsOf(h.repo)).toEqual(['COLLECT:COMPLETED:PARTIAL_1_OF_2']);
    expect(gapsOf(h.gaps)).toEqual(['SNAPSHOT:xrp_idr:FETCH_FAILED:PERMANENT:2026-11-03T15:16:30.000Z→2026-11-03T15:31:30.000Z']);
  });

  it('consecutive gaps with the same cause are merged into one row', async () => {
    const h = harness({ now: wib('23:00:00'), pairs: ['doge_idr'] });
    await h.scheduler.onSlot(wib('22:31:30'));
    await h.scheduler.onSlot(wib('22:46:30'));
    expect(gapsOf(h.gaps)).toEqual(['SNAPSHOT:doge_idr:LATE:PERMANENT:2026-11-03T15:31:30.000Z→2026-11-03T16:01:30.000Z']);
  });
});

describe('time gates: decisions need the local clock, collection needs server time', () => {
  it('local clock skewed in active hours: NO decision, but data IS collected on server time (no gap)', async () => {
    const h = harness({ now: wib('10:01:31'), skewSec: 45 });
    await h.scheduler.onSlot(wib('10:01:30'));
    expect(h.clock.status).toBe('INVALID');
    expect(h.serverClock.isTrusted).toBe(true);
    expect(h.strategyScan).not.toHaveBeenCalled();
    expect(h.collect).toHaveBeenCalledOnce();
    expect(runsOf(h.repo)).toEqual(['STRATEGY_SCAN:SKIPPED:CLOCK_SKEW', 'COLLECT:COMPLETED']);
    expect(h.gaps.gaps).toEqual([]);
  });

  it('local clock skewed outside hours: collection continues', async () => {
    const h = harness({ now: wib('02:01:31'), skewSec: -120 });
    await h.scheduler.onSlot(wib('02:01:30'));
    expect(h.collect).toHaveBeenCalledOnce();
    expect(runsOf(h.repo)).toEqual(['COLLECT:COMPLETED']);
  });

  it('server time not trustworthy: collection stops and the slot is a PERMANENT gap for every pair', async () => {
    const h = harness({ now: wib('10:01:31'), badServerTime: true });
    await h.scheduler.onSlot(wib('10:01:30'));
    expect(h.serverClock.isTrusted).toBe(false);
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.strategyScan).not.toHaveBeenCalled();
    expect(runsOf(h.repo)).toEqual(['STRATEGY_SCAN:SKIPPED:CLOCK_SKEW', 'COLLECT:SKIPPED:SERVER_TIME_UNTRUSTED']);
    expect(h.gaps.gaps.map((g) => `${g.pair}:${g.cause}:${g.status}`)).toEqual(['doge_idr:SERVER_TIME_UNTRUSTED:PERMANENT', 'xrp_idr:SERVER_TIME_UNTRUSTED:PERMANENT']);
  });

  it('decisions resume only after two valid local clock samples', async () => {
    const h = harness({ now: wib('10:01:31'), skewSec: 45 });
    await h.scheduler.onSlot(wib('10:01:30'));
    expect(h.clock.status).toBe('INVALID');
    h.setSkew(0);
    h.setNow(wib('10:16:31'));
    await h.scheduler.onSlot(wib('10:16:30'));
    // The preflight took a second sample automatically → two good samples → VALID → decision.
    expect(h.clock.isValid).toBe(true);
    expect(h.strategyScan).toHaveBeenCalledOnce();
    expect(h.preflight).toHaveBeenCalledTimes(4);
  });

  it('a clock error raised inside the strategy task is SKIPPED (CLOCK_SKEW) and recorded as a gap', async () => {
    const h = harness({ now: wib('10:01:31') });
    h.strategyScan.mockRejectedValueOnce(new ClockNotValidError('INVALID', 40_000));
    await h.scheduler.onSlot(wib('10:01:30'));
    expect(runsOf(h.repo)).toEqual(['STRATEGY_SCAN:SKIPPED:CLOCK_SKEW']);
    expect(h.gaps.gaps.map((g) => g.cause)).toEqual(['CLOCK_SKEW', 'CLOCK_SKEW']);
  });

  it('a server-time error raised inside the collection is SKIPPED (SERVER_TIME_UNTRUSTED)', async () => {
    const h = harness({ now: wib('23:01:31') });
    h.collect.mockRejectedValueOnce(new ServerTimeUntrustedError('tes'));
    await h.scheduler.onSlot(wib('23:01:30'));
    expect(runsOf(h.repo)).toEqual(['COLLECT:SKIPPED:SERVER_TIME_UNTRUSTED']);
  });
});

describe('preflight, retries, circuit breaker', () => {
  it('preflight failure: 1 request, no fan-out, FAILED (API_ERROR) and a gap', async () => {
    const h = harness({ now: wib('10:01:31'), preflightFails: true });
    await h.scheduler.onSlot(wib('10:01:30'));
    expect(h.preflight).toHaveBeenCalledTimes(1);
    expect(h.strategyScan).not.toHaveBeenCalled();
    expect(runsOf(h.repo)).toEqual(['STRATEGY_SCAN:FAILED:API_ERROR']);
    expect(h.gaps.gaps.map((g) => g.cause)).toEqual(['API_ERROR', 'API_ERROR']);
    expect(h.scheduler.status().consecutiveFailures).toBe(1);
  });

  it('a failed task is retried (+30 s) only after a new successful preflight', async () => {
    const h = harness({ now: wib('10:01:31') });
    h.strategyScan.mockRejectedValueOnce(new Error('database sibuk'));
    await h.scheduler.onSlot(wib('10:01:30'));
    expect(h.sleep).toHaveBeenCalledWith(30_000);
    expect(h.preflight).toHaveBeenCalledTimes(2);
    expect(h.strategyScan).toHaveBeenCalledTimes(2);
    expect(h.repo.runs[0]).toMatchObject({ status: 'COMPLETED', retryCount: 1 });
    expect(h.gaps.gaps).toEqual([]);
  });

  it('after 3 failed slots the circuit breaker stops retries', async () => {
    const h = harness({ now: wib('10:01:31') });
    h.strategyScan.mockRejectedValue(new Error('down'));
    for (const [i, t] of ['10:01:30', '10:16:30', '10:31:30'].entries()) {
      h.setNow(new Date(wib(t).getTime() + 1000));
      await h.scheduler.onSlot(wib(t));
      expect(h.scheduler.status().consecutiveFailures).toBe(i + 1);
    }
    const before = h.strategyScan.mock.calls.length;
    h.setNow(wib('10:46:31'));
    await h.scheduler.onSlot(wib('10:46:30'));
    expect(h.strategyScan.mock.calls.length - before).toBe(1);
    expect(h.scheduler.status().breakerOpen).toBe(true);
  });
});

describe('recovery after restart, power loss and sleep', () => {
  it('restart: RUNNING → INTERRUPTED, missed slots MISSED (OFFLINE), one gap per pair, recovery collection, candle check', async () => {
    const h = harness({ now: wib('12:07:00') });
    await h.repo.claim({ kind: 'STRATEGY_SCAN', scope: 'ALL', slotAt: wib('10:01:30') }, 'SCHEDULED', wib('10:01:31'));
    const r = await h.scheduler.recover();
    expect(r).toEqual({ interrupted: 1, missed: 8 }); // 10:16:30 … 12:01:30
    expect(h.repo.runs.filter((x) => x.status === 'MISSED').every((x) => x.cause === 'OFFLINE')).toBe(true);
    expect(gapsOf(h.gaps)).toEqual(PAIRS.map((p) => `SNAPSHOT:${p}:OFFLINE:PERMANENT:2026-11-03T03:16:30.000Z→2026-11-03T05:16:30.000Z`));
    expect(h.repo.runs.find((x) => x.trigger === 'RECOVERY')).toMatchObject({ kind: 'COLLECT', status: 'COMPLETED' });
    expect(h.strategyScan).not.toHaveBeenCalled();
    expect(h.continuity.maintain).toHaveBeenCalledWith(PAIRS, 'RECOVERY');
  });

  it('recovery collection works even when the local clock is wrong (server time trusted)', async () => {
    const h = harness({ now: wib('12:07:00'), skewSec: 300 });
    await h.repo.recordNotRun({ kind: 'COLLECT', scope: 'ALL', slotAt: wib('11:01:30') }, 'SKIPPED', 'X', wib('11:01:31'));
    await h.scheduler.recover();
    expect(h.collect).toHaveBeenCalledOnce();
    expect(h.clock.isValid).toBe(false);
  });

  it('first ever start (empty history) records no missed slots and no gaps', async () => {
    const h = harness({ now: wib('12:04:00') });
    expect(await h.scheduler.recover()).toEqual({ interrupted: 0, missed: 0 });
    expect(h.gaps.gaps).toEqual([]);
  });

  it('sleep: server time trust is reset and re-established; missed slots MISSED (SLEEP) with gaps', async () => {
    const h = harness({ now: wib('15:10:00') });
    await h.scheduler.start(); // first start: nothing missed
    h.collect.mockClear();
    await h.scheduler.onWake(wib('14:20:00'), wib('15:10:00'));
    h.scheduler.stop();
    const missed = h.repo.runs.filter((x) => x.status === 'MISSED');
    expect(missed.map((x) => x.slotAt)).toEqual([wib('14:31:30'), wib('14:46:30'), wib('15:01:30')]);
    expect(missed.every((x) => x.cause === 'SLEEP')).toBe(true);
    expect(h.gaps.gaps.map((g) => `${g.pair}:${g.cause}`)).toEqual(['doge_idr:SLEEP', 'xrp_idr:SLEEP']);
    // Recovery collection re-sampled server time (two samples) before collecting.
    expect(h.serverClock.isTrusted).toBe(true);
    expect(h.collect).toHaveBeenCalledOnce();
    expect(h.continuity.maintain).toHaveBeenCalledWith(PAIRS, 'WAKE');
  });

  it('hourly candle continuity runs on the slot after each full hour only', async () => {
    const h = harness({ now: wib('10:01:31') });
    await h.scheduler.onSlot(wib('10:01:30'));
    h.setNow(wib('10:16:31'));
    await h.scheduler.onSlot(wib('10:16:30'));
    expect(h.continuity.maintain).toHaveBeenCalledTimes(1);
    expect(h.continuity.maintain).toHaveBeenCalledWith(PAIRS, 'HOURLY');
  });

  it('heartbeat re-checks time only while a gate is not established', async () => {
    const h = harness({ now: wib('10:00:00') });
    await h.scheduler.heartbeat(wib('10:00:00'), 'doge_idr');
    expect(h.preflight).not.toHaveBeenCalled();
    h.serverClock.reset('tes');
    await h.scheduler.heartbeat(wib('10:01:00'), 'doge_idr');
    expect(h.preflight).toHaveBeenCalledTimes(2);
    expect(h.serverClock.isTrusted).toBe(true);
    expect(h.repo.state).toMatchObject({ lastHeartbeatAt: wib('10:01:00'), clockStatus: 'VALID' });
  });
});

describe('collection task', () => {
  it('one pair failing does not hide the others; a pair without snapshot is a FAILED item', async () => {
    const ok = { pair: 'doge_idr', snapshotId: 7n, quality: { status: 'OK', issues: [] } } as unknown as PairMarketData;
    const noSnap = { pair: 'qnt_idr', snapshotId: null, quality: { status: 'UNAVAILABLE', issues: [{ message: 'order book basi' }] } } as unknown as PairMarketData;
    const report = await collectReport(async (p) => {
      if (p === 'xrp_idr') throw new Error('timeout');
      return p === 'doge_idr' ? ok : noSnap;
    }, ['doge_idr', 'xrp_idr', 'qnt_idr']);
    expect(report.items).toEqual([
      expect.objectContaining({ pair: 'doge_idr', status: 'OK', marketSnapshotId: 7n }),
      expect.objectContaining({ pair: 'xrp_idr', status: 'FAILED', error: 'timeout' }),
      expect.objectContaining({ pair: 'qnt_idr', status: 'FAILED', error: 'order book basi' }),
    ]);
  });

  it('a time error stops the whole collection', async () => {
    await expect(collectReport(async () => { throw new ClockNotValidError('INVALID', 50_000); }, ['a_idr'])).rejects.toBeInstanceOf(ClockNotValidError);
    await expect(collectReport(async () => { throw new ServerTimeUntrustedError('x'); }, ['a_idr'])).rejects.toBeInstanceOf(ServerTimeUntrustedError);
  });
});

describe('job runner', () => {
  it('watchdog ends a stuck run as FAILED (WATCHDOG) and frees the runner', async () => {
    const repo = new InMemorySchedulerRepository();
    const runner = new JobRunner(repo, logger, { watchdogMs: 20 });
    const r = await runner.run({ kind: 'COLLECT', scope: 'ALL', slotAt: wib('10:01:30') }, 'SCHEDULED', () => new Promise(() => undefined));
    expect(r).toMatchObject({ state: 'done', outcome: { status: 'FAILED', cause: 'WATCHDOG' } });
    expect(runner.busy).toBe(false);
  });

  it('single flight: a second run while one is in progress is refused; drain waits', async () => {
    const repo = new InMemorySchedulerRepository();
    const runner = new JobRunner(repo, logger, { watchdogMs: 1_000 });
    let finish!: () => void;
    const first = runner.run({ kind: 'COLLECT', scope: 'ALL', slotAt: wib('10:01:30') }, 'SCHEDULED', () => new Promise((r) => (finish = () => r({ status: 'COMPLETED' }))));
    await new Promise((r) => setTimeout(r, 5));
    expect(await runner.run({ kind: 'COLLECT', scope: 'ALL', slotAt: wib('10:16:30') }, 'SCHEDULED', async () => ({ status: 'COMPLETED' }))).toEqual({ state: 'busy' });
    expect(await runner.drain(10)).toBe(false);
    finish();
    await first;
    expect(await runner.drain(10)).toBe(true);
  });
});
