import { ANALYSIS_DEFAULTS } from '../analysis/config.js';
import { analyzeTrend, computeTechnicalAnalysis } from '../analysis/engine.js';
import type { TechnicalAnalysis } from '../analysis/types.js';
import { Dec, sum } from '../app/decimal.js';
import { startOfDayInZone, withinActiveHours } from '../app/time.js';
import { analyzeCandleSeries, expectedLatestFinalOpenTime, isFinalCandle } from '../market/candles.js';
import type { PairMarketData } from '../market/market-data-service.js';
import type { QualityIssue, QualityStatus } from '../market/market-validator.js';
import type { Candle, PairInfo } from '../market/types.js';
import type { CostAssumptions } from '../risk/costs.js';
import { tradePnl } from '../risk/pnl.js';
import { computeRiskState, type LedgerSignal, type RiskLimits } from '../risk/risk-ledger.js';
import { ceilToStep, floorToStep } from '../risk/ticks.js';
import { STRATEGY_DEFAULTS, type StrategyConfig } from '../strategy/config.js';
import { rankDecisions } from '../strategy/ranking.js';
import { detectRegime } from '../strategy/regime.js';
import { evaluateStrategy } from '../strategy/strategy-engine.js';
import type { MarketContext, Regime, RegimeResult, StrategyDecision } from '../strategy/types.js';
import { findEntry, findExit, type EntryKind, type ExitReason, type PlannedOrder } from './fill-model.js';

const TF_MS = 900_000;
const H1_MS = 3_600_000;

export interface PairSeries {
  pair: string;
  info: PairInfo;
  /** Assumed constant spread (%), from a live sample: no historical spreads exist. */
  spreadPct: Dec;
  c15: Candle[];
  c60: Candle[];
}

export interface Combo {
  id: string;
  cfg: StrategyConfig;
}

export interface SimOptions {
  series: PairSeries[];
  combos: Combo[];
  /** Decisions are made for 15m candles opening in [start, end). Candles ≥ end are never read. */
  start: Date;
  end: Date;
  costs: CostAssumptions;
  limits: RiskLimits;
  maxAllocPct: Dec;
  activeHours: { start: string; end: string };
  timeZone: string;
  settleSec?: number;
  windowSize?: number;
  /** Combo whose per-gate rejection counts are collected. */
  rejectionsFor?: string;
  /** Called once per simulated day (progress output). */
  onProgress?: (at: Date) => void;
}

export interface SimTrade {
  combo: string;
  pair: string;
  regime: Regime;
  decisionAt: Date;
  entryAt: Date;
  exitAt: Date;
  /** Every fill is an ESTIMATE (no historical order-queue data). */
  fillEstimated: true;
  entryKind: EntryKind;
  exitReason: ExitReason | 'akhir_data';
  entryFill: Dec;
  exitPrice: Dec;
  quantity: Dec;
  reservedRisk: Dec;
  grossPnl: Dec;
  fees: Dec;
  taxes: Dec;
  slippage: Dec;
  netPnl: Dec;
  /** netPnl / reservedRisk. */
  r: Dec;
  /** Net loss larger than the planned maximum (gaps, thin data). */
  overshoot: boolean;
}

export interface SimResult {
  combo: string;
  trades: SimTrade[];
  signals: number;
  expiredUnfilled: number;
  rejections: Record<string, number>;
}

interface Pending {
  pair: string;
  order: PlannedOrder;
  expiresAt: Date;
  signalCandle: Date;
  decisionAt: Date;
  regime: Regime;
  reservedRisk: Dec;
  ledger: LedgerSignal;
}

interface Open extends Pending {
  entryAt: Date;
  entryFill: Dec;
  entryKind: EntryKind;
  held: Candle[];
}

interface ComboState {
  combo: Combo;
  pending: Pending | null;
  open: Open | null;
  ledger: LedgerSignal[];
  trades: SimTrade[];
  signals: number;
  expiredUnfilled: number;
  nextId: number;
}

interface PairIndex {
  s: PairSeries;
  i15: Map<number, number>;
  /** Index of the last 1H candle that is final at a given time is found by search. */
}

/**
 * Event-driven, look-ahead-free portfolio simulation that reuses the live
 * engine (M3 indicators + M4 strategy) unchanged. At each 15m step:
 *   1. pending/open orders are processed against THIS candle only;
 *   2. a decision is made at candle close + settle time, from final candles only
 *      (15m window ending at this candle; 1H candles already final at that time);
 *   3. a new order can fill from the NEXT candle onwards.
 */
export function simulate(o: SimOptions): SimResult[] {
  const settle = o.settleSec ?? 90;
  const window = o.windowSize ?? 300;
  const pairs: PairIndex[] = o.series.map((s) => ({ s, i15: new Map(s.c15.map((c, i) => [c.openTime.getTime(), i])) }));
  const states: ComboState[] = o.combos.map((combo) => ({
    combo,
    pending: null,
    open: null,
    ledger: [],
    trades: [],
    signals: 0,
    expiredUnfilled: 0,
    nextId: 1,
  }));
  const rejections: Record<string, number> = {};
  const reject = (key: string) => (rejections[key] = (rejections[key] ?? 0) + 1);
  const h1Cache = new Map<string, boolean>();

  const candleAt = (p: PairIndex, t: number) => {
    const i = p.i15.get(t);
    return i === undefined ? null : p.s.c15[i]!;
  };

  const closeTrade = (st: ComboState, pos: Open, exitAt: Date, exitPrice: Dec, reason: SimTrade['exitReason'], stopType: boolean) => {
    const pnl = tradePnl(pos.order.quantity, pos.entryFill, exitPrice, stopType ? o.costs.stopSlippagePct : o.costs.tpSlippagePct, o.costs);
    st.trades.push({
      combo: st.combo.id,
      pair: pos.pair,
      regime: pos.regime,
      decisionAt: pos.decisionAt,
      entryAt: pos.entryAt,
      exitAt,
      fillEstimated: true,
      entryKind: pos.entryKind,
      exitReason: reason,
      entryFill: pos.entryFill,
      exitPrice,
      quantity: pos.order.quantity,
      reservedRisk: pos.reservedRisk,
      grossPnl: pnl.grossPnl,
      fees: pnl.fees,
      taxes: pnl.taxes,
      slippage: pnl.slippage,
      netPnl: pnl.netPnl,
      r: pnl.netPnl.div(pos.reservedRisk),
      overshoot: pnl.netPnl.neg().gt(pos.reservedRisk),
    });
    pos.ledger.journalClosed = true; // realized result replaces the reservation (M6 semantics)
    st.open = null;
  };

  for (let T = o.start.getTime(); T < o.end.getTime(); T += TF_MS) {
    const decisionAt = new Date(T + TF_MS + settle * 1000);
    if (o.onProgress && T % 86_400_000 === 0) o.onProgress(new Date(T));

    // 1. Orders against this candle.
    for (const st of states) {
      if (st.pending) {
        const p = st.pending;
        const c = candleAt(pairs.find((x) => x.s.pair === p.pair)!, T);
        if (T >= p.expiresAt.getTime()) {
          p.ledger.lifecycle = 'EXPIRED_UNFILLED';
          st.expiredUnfilled++;
          st.pending = null;
        } else if (c) {
          const fill = findEntry([c], p.order, { requireVolumeForQuantity: true, inclusive: false });
          if (fill) {
            const entryFill = fill.fillPrice.times(Dec.add(1, o.costs.entrySlippagePct.div(100)));
            const pos: Open = { ...p, entryAt: new Date(T + TF_MS), entryFill, entryKind: fill.kind, held: [] };
            p.ledger.lifecycle = 'POSSIBLY_FILLED';
            p.ledger.execution = 'TAKEN';
            st.pending = null;
            st.open = pos;
            if (fill.immediateExit) closeTrade(st, pos, pos.entryAt, fill.immediateExit, fill.kind as ExitReason, true);
          }
        }
      } else if (st.open) {
        const pos = st.open;
        const c = candleAt(pairs.find((x) => x.s.pair === pos.pair)!, T);
        if (c) {
          pos.held.push(c);
          const exit = findExit(pos.held, pos.order, st.combo.cfg.signal.timeStopCandles);
          if (exit) closeTrade(st, pos, new Date(T + TF_MS), exit.price, exit.reason, exit.stopType);
        }
      }
    }

    // 2. Decisions (only for combos with a free slot, inside active hours).
    const free = states.filter((st) => !st.pending && !st.open);
    if (free.length === 0 || !withinActiveHours(decisionAt, o.timeZone, o.activeHours.start, o.activeHours.end)) continue;

    const evaluated: { p: PairIndex; analysis: TechnicalAnalysis; regime: RegimeResult; window15: Candle[]; market: MarketContext }[] = [];
    for (const p of pairs) {
      const prepared = preparePair(p, T, decisionAt, window, settle, h1Cache, reject);
      if (prepared) evaluated.push(prepared);
    }
    if (evaluated.length === 0) continue;

    const dayStart = startOfDayInZone(decisionAt, o.timeZone);
    for (const st of free) {
      const todayLoss = Dec.max(sum(st.trades.filter((t) => t.exitAt >= dayStart).map((t) => t.netPnl)).neg(), 0);
      const risk = computeRiskState(st.ledger, o.limits, { available: true, amount: todayLoss }, dayStart);
      const decisions: StrategyDecision[] = evaluated.map((e) =>
        evaluateStrategy({
          analysis: e.analysis,
          candles: e.window15,
          market: e.market,
          pairInfo: e.p.s.info,
          qualityIssueCodes: [],
          risk,
          costs: o.costs,
          maxAllocPct: o.maxAllocPct,
          withinActiveHours: true,
          now: decisionAt,
          cfg: st.combo.cfg,
          periods: { atr: ANALYSIS_DEFAULTS.atrPeriod, rsi: ANALYSIS_DEFAULTS.rsiPeriod, volume: ANALYSIS_DEFAULTS.volumePeriod },
          precomputedRegime: e.regime,
          earlyWarning: false,
        }),
      );
      if (st.combo.id === o.rejectionsFor) {
        for (const d of decisions) {
          if (d.decision === 'BUY_CANDIDATE') reject('lolos semua syarat');
          else if (d.decision === 'NO_TRADE') reject('NO_TRADE (batas harian/validasi)');
          const failed = d.gates.filter((g) => g.passed !== true && g.id !== 'G12');
          for (const g of failed) reject(`${g.id} ${g.label}`);
          // Near misses: which single condition was the only one blocking a BUY.
          if (failed.length === 1) reject(`hampir lolos (${d.pair}): hanya gagal ${failed[0]!.id}`);
        }
      }
      const best = rankDecisions(decisions)[0];
      if (best?.decision !== 'BUY_CANDIDATE' || !best.plan?.sizing.ok) continue;
      const s = best.plan.sizing;
      const ledger: LedgerSignal = {
        id: st.nextId++,
        pair: best.pair,
        createdAt: decisionAt,
        expiresAt: best.plan.expiresAt,
        reservedRisk: s.atStop.netLoss,
        lifecycle: 'ACTIVE',
        execution: 'UNKNOWN',
      };
      st.ledger.push(ledger);
      st.signals++;
      st.pending = {
        pair: best.pair,
        order: { entryMax: best.plan.entry.max, stop: best.plan.stop, takeProfit: best.plan.takeProfit, quantity: s.quantity },
        expiresAt: best.plan.expiresAt,
        signalCandle: new Date(T),
        decisionAt,
        regime: best.regime!.regime,
        reservedRisk: s.atStop.netLoss,
        ledger,
      };
    }
  }

  // End of period: unfilled orders expire, open positions close at the last candle (market sell).
  for (const st of states) {
    if (st.pending) {
      st.pending.ledger.lifecycle = 'EXPIRED_UNFILLED';
      st.expiredUnfilled++;
      st.pending = null;
    }
    if (st.open) {
      const last = st.open.held.at(-1);
      const price = last?.close ?? st.open.entryFill;
      closeTrade(st, st.open, last ? new Date(last.openTime.getTime() + TF_MS) : st.open.entryAt, price, 'akhir_data', true);
    }
  }

  return states.map((st) => ({
    combo: st.combo.id,
    trades: st.trades,
    signals: st.signals,
    expiredUnfilled: st.expiredUnfilled,
    rejections: st.combo.id === o.rejectionsFor ? rejections : {},
  }));
}

/** Final 1H candles at `at`, last `window`, via binary search (ascending series). */
function final1h(c60: Candle[], at: Date, window: number, settle: number): Candle[] {
  let lo = 0;
  let hi = c60.length;
  const limit = at.getTime() - H1_MS - settle * 1000;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c60[mid]!.openTime.getTime() <= limit) lo = mid + 1;
    else hi = mid;
  }
  return c60.slice(Math.max(0, lo - window), lo);
}

function preparePair(
  p: PairIndex,
  T: number,
  at: Date,
  window: number,
  settle: number,
  h1Cache: Map<string, boolean>,
  reject: (key: string) => void,
) {
  const idx = p.i15.get(T);
  if (idx === undefined || idx + 1 < window) {
    reject('data: candle 15m tidak tersedia');
    return null;
  }
  // Look-ahead guard first: every candle the decision may see must be final at `at`.
  const window15 = p.s.c15.slice(idx + 1 - window, idx + 1);
  if (!window15.every((c) => isFinalCandle(c, at, settle))) throw new Error('look-ahead: candle 15m belum final');
  const w60 = final1h(p.s.c60, at, window, settle);
  const last60 = w60.at(-1);
  const key = `${p.s.pair}:${last60?.openTime.getTime() ?? 0}`;
  let h1Bullish = h1Cache.get(key);
  if (h1Bullish === undefined) {
    // Exact pre-filter: BUY needs a confirmed BULLISH regime, which needs these 1H conditions.
    const fresh = !!last60 && last60.openTime >= expectedLatestFinalOpenTime('60', at, settle);
    const t = fresh ? analyzeTrend(w60, '60', ANALYSIS_DEFAULTS) : null;
    h1Bullish =
      !!t &&
      t.stack.value === 'naik' &&
      !!t.closeVsEma50Pct?.gt(0) &&
      !!t.ema20SlopePct.value?.gte(0);
    h1Cache.set(key, h1Bullish);
  }
  if (!h1Bullish) {
    reject('G2 Regime bullish terkonfirmasi 1j');
    return null;
  }

  const a = analyzeCandleSeries(window15, '15', 20);
  if (a.duplicates || a.misaligned || a.missingIntervals || a.invalidOhlc) {
    reject('data: deret candle tidak valid (gap)');
    return null;
  }
  const issues: QualityIssue[] = [];
  if (a.recentCount > 0 && a.zeroVolumeRecent / a.recentCount > 0.3) {
    issues.push({ code: 'LOW_LIQUIDITY', severity: 'warning', message: `${a.zeroVolumeRecent} dari ${a.recentCount} candle terakhir tanpa transaksi (volume 0)` });
  }
  const status: QualityStatus = issues.length ? 'DEGRADED' : 'OK';
  const data: PairMarketData = {
    pair: p.s.pair,
    pairInfo: p.s.info,
    fetchedAt: at,
    timeframe: '15',
    ticker: null,
    orderBook: null,
    metrics: null,
    tradeActivity: null,
    finalCandles: window15,
    pendingCandle: null,
    quality: { status, issues, checkedAt: at },
    trendTimeframe: '60',
    trendCandles: w60,
    trendError: null,
    snapshotId: null,
  };
  const analysis = computeTechnicalAnalysis(data, ANALYSIS_DEFAULTS, at, settle);
  const regime = detectRegime(analysis, window15, STRATEGY_DEFAULTS.regime, ANALYSIS_DEFAULTS.atrPeriod);
  return { p, analysis, regime, window15, market: syntheticMarket(window15, p.s) };
}

/** Synthetic market context: constant assumed spread around the close; order book gate neutralised. */
export function syntheticMarket(window15: Candle[], s: PairSeries): MarketContext {
  const close = window15.at(-1)!.close;
  const tick = s.info.tickSize;
  const half = close.times(s.spreadPct).div(200);
  const bid = floorToStep(close.minus(half), tick);
  let ask = ceilToStep(close.plus(half), tick);
  if (ask.lte(bid)) ask = bid.plus(tick ?? new Dec('0.00000001'));
  const spread = ask.minus(bid);
  const day = window15.slice(-96);
  return {
    bestBid: bid,
    bestAsk: ask,
    spread,
    spreadPct: spread.div(bid.plus(ask).div(2)).times(100),
    imbalance1: null,
    tradeBuyRatio: null,
    askDepthBase1: null,
    bids: null,
    volumeIdr24h: sum(day.map((c) => c.close.times(c.volume))),
    orderBookNeutralised: true,
  };
}
