import type { Dec } from '../app/decimal.js';
import type { TechnicalAnalysis } from '../analysis/types.js';
import { TIMEFRAME_SECONDS, type PairInfo } from '../market/types.js';
import type { CostAssumptions } from '../risk/costs.js';
import { entryRange } from '../risk/entry-range.js';
import { sizePosition } from '../risk/position-sizing.js';
import { stopLoss } from '../risk/stop-loss.js';
import { takeProfit } from '../risk/take-profit.js';
import type { StrategyConfig } from './config.js';
import type { MarketContext, TradePlan } from './types.js';

export interface PlanInput {
  analysis: TechnicalAnalysis;
  market: MarketContext;
  pairInfo: PairInfo | null;
  atr: Dec;
  costs: CostAssumptions;
  riskBudget: Dec;
  capital: Dec;
  maxAllocPct: Dec;
  cfg: StrategyConfig;
}

export type PlanResult = { ok: true; plan: TradePlan } | { ok: false; reason: string };

/** Entry range → stop loss → take profit → position size, all rounded to the pair's rules. */
export function buildTradePlan(input: PlanInput): PlanResult {
  const { analysis: a, market, atr, cfg } = input;
  const m = a.main;
  if (!m?.close || !m.lastCandleOpen) return { ok: false, reason: 'candle final terakhir tidak tersedia' };
  const tick = input.pairInfo?.tickSize ?? null;

  const entry = entryRange(market.bestAsk, m.close, atr, tick, cfg.entry.widthAtr);
  const zones = a.levels;
  const supportLows = [...(zones?.supports ?? []).map((l) => l.zone.low), ...(zones?.inside ?? []).map((z) => z.low)];
  const stop = stopLoss(entry.max, atr, market.spread, tick, supportLows, cfg.stop);
  if (!stop.ok) return { ok: false, reason: stop.reason };

  const resistanceEdges = [...(zones?.resistances ?? []).map((l) => l.zone.low), ...(zones?.inside ?? []).map((z) => z.high)];
  const tp = takeProfit(entry.max, stop.price, atr, tick, resistanceEdges, cfg.takeProfit);
  if (!tp.ok) return { ok: false, reason: tp.reason };

  const sizing = sizePosition({
    entry: entry.max,
    stop: stop.price,
    takeProfit: tp.price,
    costs: input.costs,
    riskBudget: input.riskBudget,
    capital: input.capital,
    maxAllocPct: input.maxAllocPct,
    quantityIncrement: input.pairInfo?.quantityIncrement ?? null,
    minOrderIdr: input.pairInfo?.minOrderIdr ?? null,
    minOrderBase: input.pairInfo?.minOrderBase ?? null,
    liquidity: {
      askDepthBase: market.askDepthBase1,
      volumeIdr24h: market.volumeIdr24h,
      depthShare: cfg.sizing.depthShare,
      volumeShare: cfg.sizing.volumeShare,
    },
    bids: market.bids,
  });

  const tfMs = TIMEFRAME_SECONDS[a.main!.timeframe] * 1000;
  return {
    ok: true,
    plan: {
      entry,
      stop: stop.price,
      stopMethod: stop.method,
      stopDistancePct: stop.distancePct,
      stopDistanceAtr: stop.distanceAtr,
      takeProfit: tp.price,
      takeProfitMethod: tp.method,
      takeProfitPct: tp.price.minus(entry.max).div(entry.max).times(100),
      atrEffective: atr,
      riskBudget: input.riskBudget,
      sizing,
      expiresAt: new Date(m.lastCandleOpen.getTime() + (1 + cfg.signal.validCandles) * tfMs),
      chaseLimit: entry.max.plus(atr.times(cfg.signal.chaseAtr)),
    },
  };
}
