import { describe, expect, it, vi } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { createLogger } from '../../src/app/logger/logger.js';
import type { Candle, Timeframe } from '../../src/market/types.js';
import { CandleContinuity, missingRanges, type CandleStore } from '../../src/scheduler/candle-continuity.js';
import { InMemoryGapRepository } from '../../src/scheduler/data-gaps.js';
import { ServerClock } from '../../src/scheduler/server-clock.js';

const STEP = 900_000;
const T0 = Date.UTC(2026, 10, 3, 0, 0, 0);
const at = (i: number) => new Date(T0 + i * STEP);

describe('server clock (data-collection time, independent of the local clock)', () => {
  const mk = () => {
    let mono = 0;
    const c = new ServerClock({ maxDriftMs: 5_000, maxAnchorAgeMs: 20 * 60_000, maxCacheAgeSec: 120, mono: () => mono });
    return { c, advance: (ms: number) => (mono += ms) };
  };
  const sample = (serverMs: number, age = 0) => ({ serverTime: new Date(serverMs), cacheAgeSec: age, fetchedAt: new Date(0) /* local clock irrelevant */ });

  it('needs two consistent samples; then follows monotonic time', () => {
    const { c, advance } = mk();
    expect(c.isTrusted).toBe(false);
    expect(() => c.current()).toThrow(/belum dapat dipercaya/);
    c.observe(sample(T0));
    expect(c.isTrusted).toBe(false);
    advance(2_000);
    c.observe(sample(T0)); // same cached body without an Age header: 2 s off, within the 5 s tolerance
    expect(c.isTrusted).toBe(true);
    advance(10_000);
    expect(c.current()).toEqual(new Date(T0 + 10_000));
  });

  it('corrects Cloudflare Age and stays trusted with consistent samples', () => {
    const { c, advance } = mk();
    c.observe(sample(T0));
    advance(2_000);
    c.observe(sample(T0, 2)); // same cached body, Age 2 s → consistent
    expect(c.isTrusted).toBe(true);
    advance(60_000);
    expect(c.current()).toEqual(new Date(T0 + 62_000));
  });

  it('inconsistent server time breaks the trust chain', () => {
    const { c, advance } = mk();
    c.observe(sample(T0));
    advance(1_000);
    c.observe(sample(T0 + 1_000));
    expect(c.isTrusted).toBe(true);
    advance(1_000);
    c.observe(sample(T0 + 3_600_000)); // server jumped an hour
    expect(c.isTrusted).toBe(false);
    expect(c.untrustedReason()).toMatch(/tidak konsisten/);
  });

  it('an old anchor, an absurd cache age and a reset all remove trust', () => {
    const { c, advance } = mk();
    c.observe(sample(T0));
    c.observe(sample(T0));
    expect(c.isTrusted).toBe(true);
    advance(21 * 60_000);
    expect(c.untrustedReason()).toMatch(/terlalu lama/);
    c.observe(sample(T0 + 21 * 60_000, 500));
    expect(c.untrustedReason()).toMatch(/tidak valid/);
    c.observe(sample(T0 + 21 * 60_000));
    c.observe(sample(T0 + 21 * 60_000));
    expect(c.isTrusted).toBe(true);
    c.reset('setelah sleep');
    expect(c.untrustedReason()).toBe('setelah sleep');
  });
});

describe('missingRanges', () => {
  it('finds half-open missing ranges, including a trailing one', () => {
    expect(missingRanges([at(0), at(1), at(4), at(5)], at(0), at(8), STEP)).toEqual([
      { start: at(2), end: at(4) },
      { start: at(6), end: at(8) },
    ]);
    expect(missingRanges([at(0), at(1)], at(0), at(2), STEP)).toEqual([]);
  });
});

class FakeStore implements CandleStore {
  constructor(public times: Map<string, Set<number>>) {}
  async firstOpenTime(pair: string, tf: Timeframe) {
    const s = [...(this.times.get(`${pair}:${tf}`) ?? [])].sort((a, b) => a - b);
    return s.length ? new Date(s[0]!) : null;
  }
  async openTimes(pair: string, tf: Timeframe, from: Date, until: Date) {
    return [...(this.times.get(`${pair}:${tf}`) ?? [])].filter((t) => t >= from.getTime() && t < until.getTime()).sort((a, b) => a - b).map((t) => new Date(t));
  }
}

const candle = (i: number, volume = '1'): Candle => ({ pair: 'doge_idr', timeframe: '15', openTime: at(i), open: new Dec(1), high: new Dec(1), low: new Dec(1), close: new Dec(1), volume: new Dec(volume) });

function setup(opts: { have: number[]; indodax: (from: Date, to: Date) => Candle[]; serverNowIndex: number; maxRequests?: number; trusted?: boolean }) {
  const store = new FakeStore(new Map([['doge_idr:15', new Set(opts.have.map((i) => at(i).getTime()))]]));
  const gaps = new InMemoryGapRepository();
  const getCandles = vi.fn(async (_p: string, _tf: Timeframe, from: Date, to: Date) => opts.indodax(from, to));
  const upsert = vi.fn(async (cs: Candle[]) => {
    for (const c of cs) store.times.get('doge_idr:15')!.add(c.openTime.getTime());
    return cs.length;
  });
  const serverMs = T0 + opts.serverNowIndex * STEP + 120_000; // 2 min after that candle opened → previous is final
  const serverClock = new ServerClock({ maxDriftMs: 5_000, maxAnchorAgeMs: 20 * 60_000, maxCacheAgeSec: 120, mono: () => 0 });
  if (opts.trusted !== false) {
    serverClock.observe({ serverTime: new Date(serverMs), cacheAgeSec: 0, fetchedAt: new Date(0) });
    serverClock.observe({ serverTime: new Date(serverMs), cacheAgeSec: 0, fetchedAt: new Date(0) });
  }
  const c = new CandleContinuity({
    store, client: { getCandles }, upsert, gaps, serverClock, logger: createLogger({ level: 'silent' }),
    timeframes: ['15'], lookbackMs: 45 * 86_400_000, maxRequestsPerPass: opts.maxRequests ?? 20, settleSec: 90, chunkCandles: { '15': 800 },
  });
  return { c, gaps, getCandles, upsert, store };
}

describe('candle continuity (backfill from Indodax only, final candles only)', () => {
  it('backfills a gap with real Indodax candles and records it BACKFILLED', async () => {
    const s = setup({ have: [0, 1, 2, 6, 7, 8, 9], indodax: () => [3, 4, 5].map((i) => candle(i)), serverNowIndex: 10 });
    const r = await s.c.maintain(['doge_idr'], 'RECOVERY');
    expect(r).toMatchObject({ detected: 1, backfilled: 1, permanent: 0, requests: 1 });
    expect(s.gaps.gaps).toEqual([expect.objectContaining({ kind: 'CANDLE', timeframe: '15', gapStart: at(3), gapEnd: at(6), status: 'BACKFILLED' })]);
  });

  it('candles Indodax does not have stay missing and are PERMANENT — never interpolated', async () => {
    const s = setup({ have: [0, 1, 2, 6, 7, 8, 9], indodax: () => [candle(3)], serverNowIndex: 10 });
    const r = await s.c.maintain(['doge_idr'], 'HOURLY');
    expect(r).toMatchObject({ permanent: 1 });
    expect(s.upsert).toHaveBeenCalledWith([candle(3)]); // only what Indodax returned
    expect(s.gaps.gaps.map((g) => `${g.status}:${g.gapStart.toISOString()}→${g.gapEnd.toISOString()}:${g.cause}`)).toEqual([
      `PERMANENT:${at(4).toISOString()}→${at(6).toISOString()}:NOT_AVAILABLE_FROM_INDODAX`,
      `BACKFILLED:${at(3).toISOString()}→${at(4).toISOString()}:DETECTED`,
    ]);
    // A PERMANENT gap is not fetched again on the next pass.
    s.getCandles.mockClear();
    await s.c.maintain(['doge_idr'], 'HOURLY');
    expect(s.getCandles).not.toHaveBeenCalled();
  });

  it('never stores a non-final candle, and leaves the newest final candle to the regular sync', async () => {
    // serverNow index 10 (+2 min): newest final candle is 9; candle 10 is still forming.
    const s = setup({ have: [0, 1], indodax: () => [2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => candle(i)), serverNowIndex: 10 });
    await s.c.maintain(['doge_idr'], 'RECOVERY');
    const stored = s.upsert.mock.calls.flatMap((c) => c[0].map((x) => x.openTime.getTime()));
    expect(stored).toEqual([2, 3, 4, 5, 6, 7, 8].map((i) => at(i).getTime()));
  });

  it('fetch errors leave the gap OPEN (retried next pass); the request budget is respected', async () => {
    const failing = setup({ have: [0, 9], indodax: () => { throw new Error('HTTP 503'); }, serverNowIndex: 10 });
    expect(await failing.c.maintain(['doge_idr'], 'HOURLY')).toMatchObject({ open: 1 });
    expect(failing.gaps.gaps[0]).toMatchObject({ status: 'OPEN', details: expect.objectContaining({ error: 'HTTP 503' }) });

    const budget = setup({ have: [0, 3, 6, 9], indodax: () => [], serverNowIndex: 10, maxRequests: 1 });
    const r = await budget.c.maintain(['doge_idr'], 'HOURLY');
    // Three missing ranges, budget of one request: the first is fetched (Indodax has nothing →
    // PERMANENT), the other two stay OPEN for the next pass.
    expect(r.requests).toBe(1);
    expect(budget.gaps.gaps.map((g) => g.status)).toEqual(['PERMANENT', 'OPEN', 'OPEN']);
  });

  it('does nothing without trusted server time', async () => {
    const s = setup({ have: [0, 9], indodax: () => [], serverNowIndex: 10, trusted: false });
    const r = await s.c.maintain(['doge_idr'], 'HOURLY');
    expect(r.skipped).toMatch(/SERVER_TIME_UNTRUSTED/);
    expect(s.getCandles).not.toHaveBeenCalled();
  });
});
