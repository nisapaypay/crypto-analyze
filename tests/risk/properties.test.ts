import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { resolveCosts } from '../../src/risk/costs.js';
import { entryRange } from '../../src/risk/entry-range.js';
import { sizePosition } from '../../src/risk/position-sizing.js';
import { stopLoss } from '../../src/risk/stop-loss.js';
import { takeProfit } from '../../src/risk/take-profit.js';
import { isOnStep } from '../../src/risk/ticks.js';
import { STRATEGY_DEFAULTS as C } from '../../src/strategy/config.js';
import { evaluateStrategy } from '../../src/strategy/strategy-engine.js';
import { engineInput, scenario } from '../helpers/strategy.js';
import { seededRandom as mulberry32 } from '../helpers/random.js';

/**
 * Property tests over random markets, under the simulated NORMAL conditions
 * (fills at plan prices, no gaps, visible liquidity). Real losses can exceed
 * these bounds on gaps, thin books or unfilled stops (see backtest fill tests).
 */
const RUNS = 2000;

describe('sizing invariants (random markets, Decimal only)', () => {
  it(`${RUNS} runs: net loss ≤ budget, quantity on increment, SL < entry < TP, prices on tick, alloc ≤ 50%`, () => {
    const rand = mulberry32(20261102);
    const costs = resolveCosts({ stopSlippagePct: '0.15' });
    let checked = 0;
    for (let i = 0; i < RUNS; i++) {
      const magnitude = [1, 100, 10_000, 1_000_000][Math.floor(rand() * 4)]!;
      const tick = new Dec(magnitude >= 10_000 ? 1 : magnitude >= 100 ? '0.01' : '0.0001');
      const price = new Dec((magnitude * (1 + rand() * 9)).toFixed(4));
      const atr = price.times((0.002 + rand() * 0.03).toFixed(6));
      const spread = Dec.max(tick, price.times((rand() * 0.004).toFixed(6)));
      const ask = price.plus(spread.div(2)).toNearest(tick, Dec.ROUND_UP);
      const support = price.minus(atr.times((rand() * 3).toFixed(4)));
      const resistance = price.plus(atr.times((0.5 + rand() * 8).toFixed(4)));

      const entry = entryRange(ask, price, atr, tick, C.entry.widthAtr);
      const sl = stopLoss(entry.max, atr, spread, tick, [support], C.stop);
      if (!sl.ok) continue;
      const tp = takeProfit(entry.max, sl.price, atr, tick, [resistance], C.takeProfit);
      if (!tp.ok) continue;
      const budget = new Dec(5_000 + Math.floor(rand() * 25_000));
      const s = sizePosition({
        entry: entry.max,
        stop: sl.price,
        takeProfit: tp.price,
        costs,
        riskBudget: budget,
        capital: new Dec(5_000_000),
        maxAllocPct: new Dec(50),
        quantityIncrement: new Dec('0.00000001'),
        minOrderIdr: new Dec(10_000),
        minOrderBase: null,
        liquidity: { askDepthBase: new Dec((rand() * 1e6).toFixed(8)), volumeIdr24h: new Dec(Math.floor(rand() * 1e10)), depthShare: 0.5, volumeShare: 0.01 },
        bids: [{ price: price.minus(spread.div(2)), volume: new Dec('1e12') }],
      });
      if (!s.ok) continue;
      checked++;

      expect(s.atStop.netLoss.lte(budget)).toBe(true);
      expect(s.atStop.netLoss.gt(0)).toBe(true);
      expect(isOnStep(s.quantity, new Dec('0.00000001'))).toBe(true);
      expect(sl.price.lt(entry.min) || sl.price.lt(entry.max)).toBe(true);
      expect(sl.price.gt(0) && sl.price.lt(entry.max) && tp.price.gt(entry.max)).toBe(true);
      for (const p of [entry.min, entry.max, sl.price, tp.price]) expect(isOnStep(p, tick)).toBe(true);
      expect(s.positionValue.lte(2_500_000)).toBe(true);
      expect(s.positionValue.gte(10_000)).toBe(true);
      expect(entry.max.lte(ask)).toBe(true);
      expect(entry.max.minus(sl.price).gte(atr.minus(tick))).toBe(true); // never closer than ~1 ATR
    }
    expect(checked).toBeGreaterThan(RUNS / 4);
  });
});

describe('decision invariants (random indicator states)', () => {
  const pick = <T>(rand: () => number, xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

  it('UNAVAILABLE never yields BUY; DEGRADED never yields BUY; BUY always has a valid plan', () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      const status = pick(rand, ['OK', 'DEGRADED', 'UNAVAILABLE'] as const);
      const a = scenario({
        status,
        rsi: 30 + Math.floor(rand() * 75),
        volumeRatio: (rand() * 3).toFixed(2),
        atr: 10_000 + Math.floor(rand() * 40_000),
        stack15: pick(rand, ['naik', 'turun', 'campuran'] as const),
        stack1h: pick(rand, ['naik', 'turun', 'campuran', null] as const),
        resistances: [3_590_000 + Math.floor(rand() * 300_000)],
      });
      const d = evaluateStrategy(engineInput({ analysis: a, qualityIssueCodes: status === 'UNAVAILABLE' ? ['TICKER_STALE'] : [] }));
      if (status === 'UNAVAILABLE') {
        expect(d.decision).toBe('DATA_UNAVAILABLE');
        expect(d.plan).toBeNull();
      }
      if (status !== 'OK') expect(d.decision).not.toBe('BUY_CANDIDATE');
      if (d.decision === 'BUY_CANDIDATE') {
        expect(d.plan?.sizing.ok).toBe(true);
        expect(d.plan!.sizing.ok && d.plan!.sizing.netRr.gte(C.minNetRr)).toBe(true);
        expect(d.plan!.sizing.ok && d.plan!.sizing.atStop.netLoss.lte(25_000)).toBe(true);
        expect(d.regime?.regime).toBe('BULLISH');
        expect(d.restrictions).toEqual([]);
      }
    }
  });
});
