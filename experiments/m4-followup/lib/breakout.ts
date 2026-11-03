import { ANALYSIS_DEFAULTS } from '../../../src/analysis/config.js';
import type { TechnicalAnalysis } from '../../../src/analysis/types.js';
import { Dec } from '../../../src/app/decimal.js';
import { atrSeries } from '../../../src/indicators/atr.js';
import { supportResistance } from '../../../src/indicators/support-resistance.js';
import { volumeStats } from '../../../src/indicators/volume.js';
import type { Candle, PairInfo } from '../../../src/market/types.js';
import { roundTripCostPct, type CostAssumptions } from '../../../src/risk/costs.js';
import { sizePosition, type SizingResult } from '../../../src/risk/position-sizing.js';
import { stopLoss } from '../../../src/risk/stop-loss.js';
import { takeProfit } from '../../../src/risk/take-profit.js';
import { ceilToStep, floorToStep } from '../../../src/risk/ticks.js';
import type { StrategyConfig } from '../../../src/strategy/config.js';
import type { MarketContext, RegimeResult } from '../../../src/strategy/types.js';

/**
 * Experiment 2 — breakout entry. Everything is decided from FINAL candles of
 * the entry timeframe; the resistance zone must already exist BEFORE the
 * breakout candle (zones are computed on the window that ends one candle
 * earlier, so a pivot can never be confirmed by the breakout candle itself).
 */
export interface BreakoutParams {
  /**
   * pasar      — market buy at the next candle open after the breakout candle closes
   * konfirmasi — wait for one more final candle that also closes above the zone, then market buy
   * retest     — limit buy at the zone top (waits for a pullback to the breakout level)
   */
  entry: 'pasar' | 'konfirmasi' | 'retest';
  /** resistance — next resistance zone − buffer, capped at rrCap·R (production takeProfit); atr — entry + tpAtr·ATR. */
  tp: 'resistance' | 'atr';
  tpAtr: number;
  /** Max distance from the zone top to the entry (decision close AND actual fill), in ATR. */
  maxExtAtr: number;
  /** Extra slippage on market buys on top of half the assumed spread (ASUMSI). */
  marketSlipPct: Dec;
}

export interface BreakoutZone {
  low: Dec;
  high: Dec;
  touches: number;
  /** Index (in the window) of the candle that closed above the zone. */
  breakoutIndex: number;
  breakoutOpenTime: Date;
  /** Breakout candle opened above the zone top already (gap through the level). */
  openedAbove: boolean;
}

const SR = {
  k: ANALYSIS_DEFAULTS.fractalK,
  toleranceAtr: ANALYSIS_DEFAULTS.srToleranceAtr,
  freshCandles: ANALYSIS_DEFAULTS.srFreshCandles,
  maxPerSide: ANALYSIS_DEFAULTS.srMaxPerSide,
};

/**
 * Did candle `j` close above a resistance zone that existed at candle j−1?
 * The broken zone must have its top at/above the previous close (not already
 * broken). If several zones are broken at once, the highest is the level.
 */
export function detectBreakout(window: Candle[], j: number, atr: (Dec | null)[]): BreakoutZone | null {
  if (j < 1) return null;
  const prev = window[j - 1]!;
  const cur = window[j]!;
  const atrPrev = atr[j - 1];
  if (!atrPrev || atrPrev.lte(0) || cur.volume.isZero()) return null;
  const sr = supportResistance(window.slice(0, j), prev.close, atrPrev, SR);
  const candidates = [...sr.inside, ...sr.resistances.map((r) => r.zone)];
  const broken = candidates.filter((z) => cur.close.gt(z.high) && z.high.gte(prev.close));
  if (broken.length === 0) return null;
  const z = broken.reduce((a, b) => (b.high.gt(a.high) ? b : a));
  return { low: z.low, high: z.high, touches: z.touches, breakoutIndex: j, breakoutOpenTime: cur.openTime, openedAbove: cur.open.gt(z.high) };
}

export function windowAtr(window: Candle[]): (Dec | null)[] {
  return atrSeries(window, ANALYSIS_DEFAULTS.atrPeriod);
}

export interface PlanArgs {
  entry: Dec;
  atr: Dec;
  market: MarketContext;
  info: PairInfo;
  zone: BreakoutZone;
  analysis: TechnicalAnalysis;
  cfg: StrategyConfig;
  bo: BreakoutParams;
  costs: CostAssumptions;
  riskBudget: Dec;
  capital: Dec;
  maxAllocPct: Dec;
}

export type BreakoutPlan =
  | { ok: true; stop: Dec; takeProfit: Dec; sizing: Extract<SizingResult, { ok: true }> }
  | { ok: false; reason: string };

/**
 * SL / TP / sizing for a breakout entry at `entry`, with the production risk
 * functions. Called at decision time AND again at the actual fill price.
 * Broken zone low acts as structural support.
 */
export function breakoutPlan(p: PlanArgs): BreakoutPlan {
  const tick = p.info.tickSize;
  const lv = p.analysis.levels;
  const supportLows = [p.zone.low, ...(lv?.supports ?? []).map((l) => l.zone.low), ...(lv?.inside ?? []).map((z) => z.low)];
  const stop = stopLoss(p.entry, p.atr, p.market.spread, tick, supportLows, p.cfg.stop);
  if (!stop.ok) return { ok: false, reason: `SL: ${stop.reason.replace(/\(.*\)/, '').trim()}` };

  let tp: Dec;
  if (p.bo.tp === 'atr') {
    tp = floorToStep(p.entry.plus(p.atr.times(p.bo.tpAtr)), tick);
  } else {
    const edges = [...(lv?.resistances ?? []).map((l) => l.zone.low), ...(lv?.inside ?? []).map((z) => z.high)].filter((e) => e.gt(p.zone.high));
    const r = takeProfit(p.entry, stop.price, p.atr, tick, edges, p.cfg.takeProfit);
    if (!r.ok) return { ok: false, reason: 'TP: resistance berikutnya terlalu dekat' };
    tp = r.price;
  }
  if (tp.lte(p.entry)) return { ok: false, reason: 'TP: tidak di atas entry' };

  const sizing = sizePosition({
    entry: p.entry,
    stop: stop.price,
    takeProfit: tp,
    costs: p.costs,
    riskBudget: p.riskBudget,
    capital: p.capital,
    maxAllocPct: p.maxAllocPct,
    quantityIncrement: p.info.quantityIncrement,
    minOrderIdr: p.info.minOrderIdr,
    minOrderBase: p.info.minOrderBase,
    liquidity: { askDepthBase: null, volumeIdr24h: p.market.volumeIdr24h, depthShare: p.cfg.sizing.depthShare, volumeShare: p.cfg.sizing.volumeShare },
    bids: null,
  });
  if (!sizing.ok) return { ok: false, reason: `sizing: ${sizing.kind}` };
  if (sizing.netRr.lt(p.cfg.minNetRr)) return { ok: false, reason: `G11 R/R bersih < ${p.cfg.minNetRr}` };
  return { ok: true, stop: stop.price, takeProfit: tp, sizing };
}

export interface BreakoutCandidate {
  zone: BreakoutZone;
  atr: Dec;
  /** limit price (retest) or estimated market fill at decision (pasar/konfirmasi). */
  entry: Dec;
  entryKind: 'market' | 'limit_marketable' | 'limit_resting';
  plan: Extract<BreakoutPlan, { ok: true }>;
  /** Distance from the zone top to the decision-time entry, in ATR. */
  extAtr: Dec;
}

/** Market buy price estimate: price + half the assumed spread + market slippage. */
export function marketBuyPrice(price: Dec, spreadPct: Dec, slipPct: Dec, tick: Dec | null): Dec {
  return ceilToStep(price.times(Dec.add(1, spreadPct.div(200))).times(Dec.add(1, slipPct.div(100))), tick);
}

/**
 * Gates for a breakout BUY (pre-declared, minimal):
 *   G1 data OK · indicators reliable · G2 regime BULLISH confirmed on the trend timeframe
 *   B1 final close above an existing resistance zone · B2 volume ratio of the breakout candle ≥ cfg
 *   G7 spread · G10 ATR% ≥ round-trip cost · B3 entry ≤ maxExtAtr above the zone · G11 net R/R ≥ 1.5
 * G12 (daily limits, slot, active hours) is handled by the simulator.
 */
export function evaluateBreakout(args: {
  analysis: TechnicalAnalysis;
  regime: RegimeResult;
  restrictions: string[];
  window: Candle[];
  atrWindow: (Dec | null)[];
  zones: { last: BreakoutZone | null; prev: BreakoutZone | null };
  atr: Dec | null;
  market: MarketContext;
  info: PairInfo;
  cfg: StrategyConfig;
  bo: BreakoutParams;
  costs: CostAssumptions;
  riskBudget: Dec;
  capital: Dec;
  maxAllocPct: Dec;
}): { ok: true; candidate: BreakoutCandidate } | { ok: false; reason: string } {
  const { analysis: a, regime, window, cfg, bo, market, atr } = args;
  if (a.status !== 'OK') return { ok: false, reason: 'G1 data tidak OK' };
  if (!(regime.regime === 'BULLISH' && regime.confirmed1h)) return { ok: false, reason: `G2 regime ${regime.regime}` };
  if (args.restrictions.length) return { ok: false, reason: 'indikator kurang andal' };
  if (!atr) return { ok: false, reason: 'ATR tidak tersedia' };

  const n = window.length;
  const zone = bo.entry === 'konfirmasi' ? args.zones.prev : args.zones.last;
  if (!zone) return { ok: false, reason: 'B1 tidak ada breakout' };
  const close = window[n - 1]!.close;
  if (bo.entry === 'konfirmasi' && !close.gt(zone.high)) return { ok: false, reason: 'B1 konfirmasi gagal (close kembali ≤ zona)' };

  const vs = volumeStats(window.slice(0, zone.breakoutIndex + 1), ANALYSIS_DEFAULTS.volumePeriod);
  if (!vs?.ratio || vs.ratio.lt(cfg.gates.volumeRatioMin)) return { ok: false, reason: 'B2 volume breakout lemah' };
  if (!(market.spreadPct.lte(cfg.gates.maxSpreadPct) && market.spread.lte(atr.times(cfg.gates.maxSpreadAtr)))) return { ok: false, reason: 'G7 spread' };
  if (atr.div(close).times(100).lt(roundTripCostPct(args.costs))) return { ok: false, reason: 'G10 ATR% < biaya' };

  const tick = args.info.tickSize;
  let entry: Dec;
  let entryKind: BreakoutCandidate['entryKind'];
  if (bo.entry === 'retest') {
    const limit = ceilToStep(zone.high, tick);
    entry = Dec.min(limit, market.bestAsk);
    entryKind = limit.gte(market.bestAsk) ? 'limit_marketable' : 'limit_resting';
  } else {
    entry = marketBuyPrice(close, market.spreadPct, bo.marketSlipPct, tick);
    entryKind = 'market';
  }
  const extAtr = close.minus(zone.high).div(atr);
  if (extAtr.gt(bo.maxExtAtr)) return { ok: false, reason: `B3 entry > ${bo.maxExtAtr} ATR di atas zona` };

  const plan = breakoutPlan({ entry, atr, market, info: args.info, zone, analysis: a, cfg, bo, costs: args.costs, riskBudget: args.riskBudget, capital: args.capital, maxAllocPct: args.maxAllocPct });
  if (!plan.ok) return { ok: false, reason: plan.reason };
  return { ok: true, candidate: { zone, atr, entry, entryKind, plan, extAtr } };
}
