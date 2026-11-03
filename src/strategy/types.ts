import type { Dec } from '../app/decimal.js';
import type { OrderBookLevel } from '../market/types.js';
import type { CostAssumptions } from '../risk/costs.js';
import type { EntryRange } from '../risk/entry-range.js';
import type { SizingResult } from '../risk/position-sizing.js';
import type { StopMethod } from '../risk/stop-loss.js';

export type Decision = 'BUY_CANDIDATE' | 'EARLY_WARNING' | 'WAIT' | 'NO_TRADE' | 'DATA_UNAVAILABLE';
export type Regime = 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'HIGH_VOLATILITY';

/** Higher number = more permissive; decisions are capped by restrictions. */
export const DECISION_RANK: Record<'BUY_CANDIDATE' | 'EARLY_WARNING' | 'WAIT', number> = {
  BUY_CANDIDATE: 2,
  EARLY_WARNING: 1,
  WAIT: 0,
};

export interface RegimeResult {
  regime: Regime;
  /** False when 1H confirmation is unavailable (regime from 15m only). */
  confirmed1h: boolean;
  notes: string[];
  atrPct: Dec | null;
  atrPctMedian: Dec | null;
  shock: boolean;
}

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9' | 'G10' | 'G11' | 'G12';

export interface GateResult {
  id: GateId;
  label: string;
  /** null = could not be evaluated (counts as not passed). */
  passed: boolean | null;
  detail: string;
}

/** Live (or synthetic, in backtests) market context the strategy needs beyond candles. */
export interface MarketContext {
  bestBid: Dec;
  bestAsk: Dec;
  spread: Dec;
  spreadPct: Dec;
  /** ±1% order book imbalance (−1..1). */
  imbalance1: Dec | null;
  tradeBuyRatio: Dec | null;
  /** Ask volume (base units) within ±1%. */
  askDepthBase1: Dec | null;
  bids: OrderBookLevel[] | null;
  volumeIdr24h: Dec | null;
  /** Backtest: no historical order book/trades, gate G8 is neutralised and labelled. */
  orderBookNeutralised?: boolean;
}

export interface TradePlan {
  entry: EntryRange;
  stop: Dec;
  stopMethod: StopMethod;
  stopDistancePct: Dec;
  stopDistanceAtr: Dec;
  takeProfit: Dec;
  takeProfitMethod: 'rr_cap' | 'resistance';
  takeProfitPct: Dec;
  atrEffective: Dec;
  riskBudget: Dec;
  sizing: SizingResult;
  expiresAt: Date;
  /** Do not chase above this price. */
  chaseLimit: Dec;
}

export interface StrategyDecision {
  pair: string;
  engineVersion: string;
  evaluatedAt: Date;
  candleOpenTime: Date | null;
  decision: Decision;
  regime: RegimeResult | null;
  gates: GateResult[];
  /** Why this decision (passed checks for BUY, failures/blocks otherwise). */
  reasons: string[];
  /** Restrictions that capped the decision (DEGRADED, reliability, 1H, hours, slot). */
  restrictions: string[];
  earlyWarningSignals: string[];
  plan: TradePlan | null;
  /** Why no complete plan could be built. */
  planRejection: string | null;
  score: Dec | null;
  costs: CostAssumptions;
  /** Compact indicator values stored with the signal. */
  indicators: Record<string, string | null>;
}
