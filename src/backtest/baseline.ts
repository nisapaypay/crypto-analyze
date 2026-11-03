import { Dec, sum } from '../app/decimal.js';
import { withinActiveHours } from '../app/time.js';
import { atrSeries } from '../indicators/atr.js';
import type { CostAssumptions } from '../risk/costs.js';
import { buyCostRate, sellCostRate } from '../risk/costs.js';
import { sizePosition } from '../risk/position-sizing.js';
import { tradePnl } from '../risk/pnl.js';
import { floorToStep } from '../risk/ticks.js';
import type { StrategyConfig } from '../strategy/config.js';
import { findExit } from './fill-model.js';
import type { PairSeries } from './simulator.js';
import type { Period } from './walk-forward.js';

/** Buy at the first open, sell at the last close of the period, net of both sides' costs (%). */
export function buyAndHoldPct(s: PairSeries, p: Period, costs: CostAssumptions): Dec | null {
  const inside = s.c15.filter((c) => c.openTime >= p.start && c.openTime < p.end);
  const first = inside[0];
  const last = inside.at(-1);
  if (!first || !last) return null;
  const cost = first.open.times(Dec.add(1, buyCostRate(costs)));
  const proceeds = last.close.times(Dec.sub(1, sellCostRate(costs)));
  return proceeds.minus(cost).div(cost).times(100);
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random entries with the SAME stop/target/time-stop, sizing and costs (no
 * filters): does the strategy's selection add anything over chance? Entry at
 * the next traded candle's open (taker). Returns the mean net R per seed.
 */
export function randomEntryBaseline(
  s: PairSeries,
  p: Period,
  tradesPerRun: number,
  cfg: StrategyConfig,
  costs: CostAssumptions,
  opts: { seeds: number; timeZone: string; activeHours: { start: string; end: string } },
): number[] {
  if (tradesPerRun === 0) return [];
  const atr = atrSeries(s.c15, 14);
  const candidates: number[] = [];
  s.c15.forEach((c, i) => {
    if (c.openTime >= p.start && c.openTime < p.end && atr[i] && withinActiveHours(new Date(c.openTime.getTime() + 900_000), opts.timeZone, opts.activeHours.start, opts.activeHours.end)) {
      candidates.push(i);
    }
  });
  const endIndex = s.c15.findIndex((c) => c.openTime >= p.end);
  const last = endIndex < 0 ? s.c15.length : endIndex;
  const tick = s.info.tickSize;
  const out: number[] = [];
  for (let seed = 1; seed <= opts.seeds; seed++) {
    const rand = seeded(seed * 7919);
    const rs: Dec[] = [];
    for (let n = 0; n < tradesPerRun && candidates.length; n++) {
      const i = candidates[Math.floor(rand() * candidates.length)]!;
      let j = i + 1;
      while (j < last && s.c15[j]!.volume.isZero()) j++;
      if (j >= last) continue;
      const entry = s.c15[j]!.open;
      const stop = floorToStep(entry.minus(atr[i]!.times(cfg.stop.atrMultiple)), tick);
      if (stop.lte(0) || stop.gte(entry)) continue;
      const takeProfit = floorToStep(entry.plus(entry.minus(stop).times(cfg.takeProfit.rrCap)), tick);
      const sz = sizePosition({
        entry,
        stop,
        takeProfit,
        costs,
        riskBudget: new Dec(25_000),
        capital: new Dec(5_000_000),
        maxAllocPct: new Dec(50),
        quantityIncrement: s.info.quantityIncrement,
        minOrderIdr: s.info.minOrderIdr,
        minOrderBase: null,
        liquidity: { askDepthBase: null, volumeIdr24h: null, depthShare: 0.5, volumeShare: 0.01 },
        bids: null,
      });
      if (!sz.ok) continue;
      const order = { entryMax: entry, stop, takeProfit, quantity: sz.quantity };
      const rest = s.c15.slice(j + 1, last);
      const exit = findExit(rest, order, cfg.signal.timeStopCandles);
      const price = exit?.price ?? rest.at(-1)?.close ?? entry;
      const pnl = tradePnl(sz.quantity, entry, price, exit && !exit.stopType ? costs.tpSlippagePct : costs.stopSlippagePct, costs);
      rs.push(pnl.netPnl.div(sz.atStop.netLoss));
    }
    if (rs.length) out.push(sum(rs).div(rs.length).toNumber());
  }
  return out;
}
