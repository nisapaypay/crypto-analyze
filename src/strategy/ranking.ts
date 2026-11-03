import { Dec } from '../app/decimal.js';
import type { StrategyConfig } from './config.js';
import type { StrategyDecision } from './types.js';

const clamp01 = (v: Dec) => Dec.min(Dec.max(v, 0), 1);

/**
 * Deterministic score in [0, 1] used to pick the single primary candidate:
 *   w_rr·min(netRR/3, 1) + w_vol·min(volRatio/2, 1) + w_trend·trend + w_ob·(imbalance+1)/2
 * trend = share of {15m stack up, 1H stack up, EMA9 > EMA20 (15m), close > EMA50 (15m)}.
 */
export function scoreDecision(d: StrategyDecision, cfg: StrategyConfig): Dec {
  const w = cfg.ranking;
  const i = d.indicators;
  const netRr = d.plan?.sizing.ok ? d.plan.sizing.netRr : new Dec(0);
  const vol = i.volumeRatio ? new Dec(i.volumeRatio) : new Dec(0);
  const trendFlags = [
    i.stack15m === 'naik',
    i.stack1h === 'naik',
    !!i.ema20 && !!i.close && !!i.ema9 && new Dec(i.ema9).gt(i.ema20),
    !!i.ema50 && !!i.close && new Dec(i.close).gt(i.ema50),
  ];
  const trend = new Dec(trendFlags.filter(Boolean).length).div(trendFlags.length);
  const ob = i.imbalance1 ? clamp01(new Dec(i.imbalance1).plus(1).div(2)) : new Dec('0.5');
  return clamp01(netRr.div(3))
    .times(w.rr)
    .plus(clamp01(vol.div(2)).times(w.volume))
    .plus(trend.times(w.trend))
    .plus(ob.times(w.orderBook))
    .toDecimalPlaces(4);
}

/**
 * Rank decisions: BUY before EARLY_WARNING, then score (desc), then pair name.
 * Returns a new array; at most one BUY may be issued per scan.
 */
export function rankDecisions(decisions: StrategyDecision[]): StrategyDecision[] {
  const order: Record<string, number> = { BUY_CANDIDATE: 0, EARLY_WARNING: 1, WAIT: 2, NO_TRADE: 3, DATA_UNAVAILABLE: 4 };
  return [...decisions].sort(
    (a, b) =>
      order[a.decision]! - order[b.decision]! ||
      (b.score ?? new Dec(-1)).comparedTo(a.score ?? new Dec(-1)) ||
      a.pair.localeCompare(b.pair),
  );
}
