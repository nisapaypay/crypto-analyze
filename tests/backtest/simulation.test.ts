import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { computeMetrics, sampleNote } from '../../src/backtest/metrics.js';
import { simulate, type Combo, type PairSeries, type SimTrade } from '../../src/backtest/simulator.js';
import {
  checkHoldoutLock,
  DEFAULT_COMBO_ID,
  parameterGrid,
  planPeriods,
  selectCombo,
  truncateSeries,
  walkForward,
  writeHoldoutLock,
} from '../../src/backtest/walk-forward.js';
import { resolveCosts } from '../../src/risk/costs.js';
import { withStrategyOverrides } from '../../src/strategy/config.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import { loadFixtureCandles } from '../helpers/analysis-fixtures.js';
import { makePair } from '../helpers/market.js';

const settings = defaultStrategySettings();
const costs = resolveCosts();

/** Real fixture candles (300 × 15m and 300 × 1H, recorded live in Milestone 3). */
function fixtureSeries(pair = 'doge_idr'): PairSeries {
  const c15 = loadFixtureCandles(pair, '15').candles;
  const c60 = loadFixtureCandles(pair, '60').candles;
  return { pair, info: makePair({ tickerId: pair }), spreadPct: new Dec('0.2'), c15, c60 };
}

/**
 * Deliberately loose rules and zero costs, used ONLY to make trades happen so
 * the look-ahead invariance is tested on real trades (not a strategy result).
 */
const LOOSE: Combo = {
  id: 'loose',
  cfg: withStrategyOverrides({
    gates: { rsiMin: 0, rsiMax: 100, volumeRatioMin: 0, maxSpreadPct: 5, maxSpreadAtr: 10, maxExtensionAtr: 100, maxCandleDropAtr: 100 },
    minNetRr: 0,
  }),
};
const ZERO_COSTS = resolveCosts({ buyFeePct: '0', sellFeePct: '0', buyTaxPct: '0', sellTaxPct: '0', stopSlippagePct: '0' });

function run(series: PairSeries[], start: Date, end: Date, combo: Combo = parameterGrid().find((g) => g.id === DEFAULT_COMBO_ID)!, c = costs) {
  return simulate({
    series,
    combos: [combo],
    start,
    end,
    costs: c,
    limits: settings.limits,
    maxAllocPct: settings.maxAllocPct,
    activeHours: { start: '00:00', end: '23:59' },
    timeZone: 'Asia/Jakarta',
    windowSize: 150,
    rejectionsFor: combo.id,
  })[0]!;
}

describe('no look-ahead', () => {
  const s = fixtureSeries('qnt_idr');
  const start = s.c15[160]!.openTime;
  const mid = s.c15[240]!.openTime;
  const end = new Date(s.c15.at(-1)!.openTime.getTime() + 900_000);

  it('decisions up to time t are identical whether or not later candles exist', () => {
    const full = run([s], start, end, LOOSE, ZERO_COSTS);
    const cut = run(truncateSeries([s], mid), start, mid, LOOSE, ZERO_COSTS);
    expect(full.trades.filter((t) => t.exitAt <= mid).length).toBeGreaterThan(0); // non-trivial
    const key = (t: SimTrade) => `${t.pair}|${t.decisionAt.toISOString()}|${t.entryAt.toISOString()}`;
    const fullBefore = full.trades.filter((t) => t.exitAt <= mid).map(key);
    const cutClosed = cut.trades.filter((t) => t.exitReason !== 'akhir_data').map(key);
    expect(cutClosed).toEqual(fullBefore);
    // Gate statistics up to `mid` cannot depend on the future either.
    expect(Object.values(cut.rejections).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('refuses to read candles that are not final at decision time', () => {
    const s2 = fixtureSeries();
    // Corrupt: shift one candle into the future relative to its index.
    const bad = { ...s2, c15: s2.c15.map((c, i) => (i === 200 ? { ...c, openTime: new Date(c.openTime.getTime() + 86_400_000) } : c)) };
    expect(() => run([bad], s2.c15[201]!.openTime, s2.c15[202]!.openTime)).toThrow('look-ahead');
  });
});

describe('walk-forward and holdout lock', () => {
  const s = fixtureSeries();
  const series = [{ ...s, c60: s.c60 }];

  it('plans 12 blocks after warm-up: 9 development + 3 holdout', () => {
    const p = planPeriods(series, 12, 3, 150);
    expect(p.blocks).toHaveLength(12);
    expect(p.development.end).toEqual(p.holdout.start);
    expect(p.blocks[0]!.start.getTime()).toBeGreaterThanOrEqual(s.c15[149]!.openTime.getTime());
  });

  it('truncation physically removes holdout candles', () => {
    const p = planPeriods(series, 12, 3, 150);
    const dev = truncateSeries(series, p.holdout.start);
    expect(dev[0]!.c15.every((c) => c.openTime < p.holdout.start)).toBe(true);
    expect(dev[0]!.c60.every((c) => c.openTime < p.holdout.start)).toBe(true);
  });

  it('selection needs ≥30 trades, otherwise the default is used', () => {
    const p = planPeriods(series, 12, 3, 150);
    const t = (r: number): SimTrade => ({ r: new Dec(r), decisionAt: p.blocks[1]!.start } as SimTrade);
    const few = selectCombo([{ combo: 'x', trades: [t(5)], signals: 1, expiredUnfilled: 0, rejections: {} }], p.development);
    expect(few.combo).toBe(DEFAULT_COMBO_ID);
    const many = selectCombo(
      [
        { combo: 'a', trades: Array.from({ length: 30 }, () => t(0.1)), signals: 30, expiredUnfilled: 0, rejections: {} },
        { combo: 'b', trades: Array.from({ length: 30 }, () => t(0.2)), signals: 30, expiredUnfilled: 0, rejections: {} },
      ],
      p.development,
    );
    expect(many.combo).toBe('b');
    expect(walkForward([], p.blocks, 9)).toHaveLength(5);
  });

  describe('holdout lock file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'holdout-'));
    const path = join(dir, 'lock.json');
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('first run is allowed, same params/data may be reproduced, different params are refused', () => {
      expect(checkHoldoutLock(path, 'p1', 'd1', false)).toMatchObject({ ok: true, firstRun: true });
      writeHoldoutLock(path, { createdAt: 'x', combo: 'c', paramsHash: 'p1', dataHash: 'd1', period: { start: 'a', end: 'b' } });
      expect(existsSync(path)).toBe(true);
      expect(checkHoldoutLock(path, 'p1', 'd1', false)).toMatchObject({ ok: true, firstRun: false, contaminated: false });
      expect(checkHoldoutLock(path, 'p2', 'd1', false).ok).toBe(false);
      expect(checkHoldoutLock(path, 'p2', 'd1', true)).toMatchObject({ ok: true, contaminated: true });
    });
  });
});

describe('metrics after costs', () => {
  const at = (iso: string) => new Date(iso);
  const trade = (net: number, exit: string, o: Partial<SimTrade> = {}): SimTrade =>
    ({
      pair: 'doge_idr',
      regime: 'BULLISH',
      decisionAt: at(exit),
      entryAt: at(exit),
      exitAt: at(exit),
      netPnl: new Dec(net),
      r: new Dec(net).div(25_000),
      fees: new Dec(1000),
      taxes: new Dec(500),
      slippage: new Dec(100),
      reservedRisk: new Dec(25_000),
      overshoot: net < -25_000,
      exitReason: net > 0 ? 'tp' : 'sl',
      entryKind: 'normal',
      ...o,
    }) as SimTrade;

  it('expectancy, profit factor, drawdown, worst periods and overshoot', () => {
    const trades = [
      trade(40_000, '2026-01-05T05:00:00Z'),
      trade(-25_000, '2026-01-06T05:00:00Z'),
      trade(-30_000, '2026-01-06T07:00:00Z'), // gap: larger than planned
      trade(39_000, '2026-02-02T05:00:00Z'),
    ];
    const m = computeMetrics(trades, new Dec(5_000_000), 'Asia/Jakarta');
    expect(m.trades).toBe(4);
    expect(m.expectancyIdr!.toFixed()).toBe('6000');
    expect(m.expectancyR!.toFixed()).toBe('0.24');
    expect(m.profitFactor!.toFixed(4)).toBe('1.4364');
    expect(m.maxDrawdownIdr.toFixed()).toBe('55000');
    expect(m.maxDrawdownPct.toFixed(2)).toBe('1.10');
    expect(m.worstDay).toEqual({ key: '2026-01-06', net: new Dec(-55_000) });
    expect(m.worstWeek!.key).toBe('minggu mulai 2026-01-05');
    expect(m.worstMonth).toEqual({ key: '2026-01', net: new Dec(-15_000) });
    expect(m.longestLosingStreak).toBe(2);
    expect(m.overshootCount).toBe(1);
    expect(m.maxOvershootIdr.toFixed()).toBe('5000');
    expect(m.totalFees.toFixed()).toBe('4000');
    expect(m.sampleNote).toContain('TIDAK BERMAKNA');
  });

  it('never calls ≥30 trades proof of an edge', () => {
    expect(sampleNote(0)).toContain('tidak ada yang bisa disimpulkan');
    expect(sampleNote(29)).toContain('TIDAK BERMAKNA');
    expect(sampleNote(30)).toContain('BUKAN bukti keunggulan');
    expect(sampleNote(500)).toContain('BUKAN bukti keunggulan');
  });
});

