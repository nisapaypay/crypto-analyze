import { describe, expect, it } from 'vitest';
import { endpointOf, RequestMeter } from '../../src/app/http/request-meter.js';
import { ClockGuard, ClockNotValidError } from '../../src/scheduler/clock-guard.js';
import { guardMarket } from '../../src/scheduler/market-guard.js';
import { isLate, nextDailyAt, normalizeInterval, slotAtOrAfter, slotAtOrBefore, slotKind, slotsBetween } from '../../src/scheduler/slots.js';
import type { PairMarketData } from '../../src/market/market-data-service.js';

const TZ = 'Asia/Jakarta';
/** WIB wall time → Date (WIB = UTC+7, no DST). */
const wib = (hhmmss: string, day = '2026-11-03') => new Date(`${day}T${hhmmss}+07:00`);
const rules = (intervalMinutes = 15) => ({ settleSec: 90, intervalMinutes, timeZone: TZ, activeHours: { start: '09:00', end: '22:00' } });

describe('slots', () => {
  it('a slot is a 15m candle close + 90 s', () => {
    expect(slotAtOrAfter(wib('09:00:00'), 90)).toEqual(wib('09:01:30'));
    expect(slotAtOrAfter(wib('09:01:30'), 90)).toEqual(wib('09:01:30'));
    expect(slotAtOrAfter(wib('09:01:31'), 90)).toEqual(wib('09:16:30'));
    expect(slotAtOrBefore(wib('09:16:29'), 90)).toEqual(wib('09:01:30'));
  });

  it('BUY window: first strategy slot 09:01:30, last 21:46:30; 22:01:30 is data collection only', () => {
    expect(slotKind(wib('08:46:30'), rules())).toBe('COLLECT');
    expect(slotKind(wib('09:01:30'), rules())).toBe('STRATEGY_SCAN');
    expect(slotKind(wib('21:46:30'), rules())).toBe('STRATEGY_SCAN');
    expect(slotKind(wib('22:01:30'), rules())).toBe('COLLECT');
    expect(slotKind(wib('03:01:30'), rules())).toBe('COLLECT');
  });

  it('a longer scan interval keeps 15m data collection in between', () => {
    expect(slotKind(wib('09:01:30'), rules(30))).toBe('STRATEGY_SCAN');
    expect(slotKind(wib('09:16:30'), rules(30))).toBe('COLLECT');
    expect(slotKind(wib('09:31:30'), rules(30))).toBe('STRATEGY_SCAN');
    expect(normalizeInterval(20)).toBe(15);
    expect(normalizeInterval(25)).toBe(30);
    expect(normalizeInterval(5)).toBe(15);
    expect(normalizeInterval(10_000)).toBe(240);
  });

  it('slots between two times, exclusive start, inclusive end', () => {
    expect(slotsBetween(wib('09:01:30'), wib('09:46:30'), 90)).toEqual([wib('09:16:30'), wib('09:31:30'), wib('09:46:30')]);
    expect(slotsBetween(wib('09:02:00'), wib('09:16:29'), 90)).toEqual([]);
  });

  it('a slot later than 5 minutes is stale', () => {
    expect(isLate(wib('21:46:30'), wib('21:51:30'), 300)).toBe(false);
    expect(isLate(wib('21:46:30'), wib('21:51:31'), 300)).toBe(true);
    expect(isLate(wib('21:46:30'), wib('22:03:00'), 300)).toBe(true);
  });

  it('daily times in WIB: summaries 09:05 and 21:30, backup 03:30', () => {
    expect(nextDailyAt('09:05', wib('08:00:00'), TZ)).toEqual(wib('09:05:00'));
    expect(nextDailyAt('09:05', wib('09:05:00'), TZ)).toEqual(wib('09:05:00', '2026-11-04'));
    expect(nextDailyAt('21:30', wib('23:59:00'), TZ)).toEqual(wib('21:30:00', '2026-11-04'));
    expect(nextDailyAt('03:30', wib('03:00:00'), TZ)).toEqual(wib('03:30:00'));
  });
});

describe('clock guard (fail-closed)', () => {
  const at = (skewSec: number, ageSec: number | null = 0) => {
    const serverTime = new Date('2026-11-03T02:00:00Z');
    return { serverTime, cacheAgeSec: ageSec, fetchedAt: new Date(serverTime.getTime() + (ageSec ?? 0) * 1000 + skewSec * 1000) };
  };
  const guard = () => new ClockGuard({ maxSkewMs: 30_000, validChecks: 2 });

  it('starts UNKNOWN and needs two good samples in a row', () => {
    const g = guard();
    expect(g.status).toBe('UNKNOWN');
    expect(() => g.assertValid()).toThrow(ClockNotValidError);
    g.observe(at(1));
    expect(g.status).toBe('UNKNOWN');
    g.observe(at(-2));
    expect(g.status).toBe('VALID');
  });

  it('corrects for Cloudflare cache age', () => {
    const g = guard();
    // Response cached 25 s: server_time is 25 s old, local clock is right.
    expect(ClockGuard.skewOf(at(0, 25))).toBe(0);
    g.observe(at(0, 25));
    g.observe(at(0, 25));
    expect(g.isValid).toBe(true);
  });

  it('one bad sample stops decisions; two good samples resume them', () => {
    const changes: string[] = [];
    const g = new ClockGuard({ maxSkewMs: 30_000, validChecks: 2, onChange: (s) => changes.push(s) });
    g.observe(at(0));
    g.observe(at(0));
    g.observe(at(45));
    expect(g.status).toBe('INVALID');
    expect(() => g.assertValid()).toThrow(/selisih 45 dtk/);
    g.observe(at(0));
    expect(g.status).toBe('INVALID');
    g.observe(at(0));
    expect(g.status).toBe('VALID');
    expect(changes).toEqual(['VALID', 'INVALID', 'VALID']);
  });

  it('guarded market refuses to fetch while the clock is not valid, and learns from tickers', async () => {
    const g = guard();
    let calls = 0;
    const serverTime = new Date();
    const data = { pair: 'x_idr', ticker: { serverTime, fetchedAt: new Date(serverTime.getTime() + 60_000), cacheAgeSec: 0 } } as unknown as PairMarketData;
    const market = guardMarket({ refresh: async () => (calls++, data) }, g);
    await expect(market.refresh('x_idr')).rejects.toBeInstanceOf(ClockNotValidError);
    expect(calls).toBe(0);
    g.observe(at(0));
    g.observe(at(0));
    await market.refresh('x_idr'); // fetched, and the ticker reveals a 60 s skew
    expect(calls).toBe(1);
    expect(g.status).toBe('INVALID');
    await expect(market.refreshMany(['x_idr'])).rejects.toBeInstanceOf(ClockNotValidError);
    expect(calls).toBe(1);
  });
});

describe('request meter', () => {
  it('normalises endpoints without pair or query', () => {
    expect(endpointOf('https://indodax.com/api/ticker/btcidr')).toBe('/api/ticker');
    expect(endpointOf('https://indodax.com/api/depth/dogeidr')).toBe('/api/depth');
    expect(endpointOf('https://indodax.com/tradingview/history_v2?from=1&symbol=X&tf=15&to=2')).toBe('/tradingview/history_v2');
  });

  it('counts attempts and the peak of any rolling minute', () => {
    let t = 0;
    const m = new RequestMeter(3_600_000, () => t);
    for (let i = 0; i < 20; i++) m.record('/api/ticker'); // a slot burst
    t = 30_000;
    for (let i = 0; i < 5; i++) m.record('/api/depth');
    t = 95_000;
    m.record('/api/depth');
    expect(m.totalAttempts).toBe(26);
    expect(m.peakPerMinute()).toBe(25);
    expect(m.countSince(60_000)).toBe(1); // only the request at 95 s is inside [35 s, 95 s]
    expect(m.byEndpointSince(3_600_000)).toEqual({ '/api/ticker': 20, '/api/depth': 6 });
  });
});
