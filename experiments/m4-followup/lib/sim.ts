import { ANALYSIS_DEFAULTS } from '../../../src/analysis/config.js';
import { analyzeTrend, computeTechnicalAnalysis } from '../../../src/analysis/engine.js';
import type { Reading, TechnicalAnalysis } from '../../../src/analysis/types.js';
import { Dec, sum } from '../../../src/app/decimal.js';
import { startOfDayInZone, withinActiveHours } from '../../../src/app/time.js';
import { findEntry, findExit, type EntryKind, type PlannedOrder } from '../../../src/backtest/fill-model.js';
import type { SimTrade } from '../../../src/backtest/simulator.js';
import { analyzeCandleSeries, expectedLatestFinalOpenTime, isFinalCandle } from '../../../src/market/candles.js';
import type { PairMarketData } from '../../../src/market/market-data-service.js';
import type { QualityIssue } from '../../../src/market/market-validator.js';
import { TIMEFRAME_SECONDS, type Candle, type Timeframe } from '../../../src/market/types.js';
import { tradePnl } from '../../../src/risk/pnl.js';
import { computeRiskState, type LedgerSignal, type RiskLimits } from '../../../src/risk/risk-ledger.js';
import { ceilToStep, floorToStep } from '../../../src/risk/ticks.js';
import type { StrategyConfig } from '../../../src/strategy/config.js';
import { rankDecisions } from '../../../src/strategy/ranking.js';
import { detectRegime } from '../../../src/strategy/regime.js';
import { evaluateStrategy } from '../../../src/strategy/strategy-engine.js';
import type { MarketContext, Regime, RegimeResult } from '../../../src/strategy/types.js';
import { breakoutPlan, detectBreakout, evaluateBreakout, marketBuyPrice, windowAtr, type BreakoutParams, type BreakoutZone } from './breakout.js';
import { chargedCosts, type CostScenario, type EntryLeg, type ExitLeg } from './cost-scenarios.js';
import type { ExpSeries } from './series.js';

const PATH_MS = 900_000; // fills and exits are resolved on 15m candles for every variant

export interface TfSetup {
  id: string;
  label: string;
  main: '15' | '60';
  trend: '60' | '240';
  /** Regime parameters for this timeframe (HIGH_VOLATILITY lookback kept at 24 h). */
  regime: StrategyConfig['regime'];
  /** Candles of the main timeframe in 24 h (synthetic 24 h IDR volume for the liquidity cap). */
  candles24h: number;
}

interface VariantBase {
  id: string;
  /** Group label in the report (baseline / E1 / E2 / …). */
  group: string;
  cfg: StrategyConfig;
  cost: CostScenario;
  /** Time stop in 15m path candles. */
  timeStopPath: number;
}
export type Variant = (VariantBase & { kind: 'pullback' }) | (VariantBase & { kind: 'breakout'; bo: BreakoutParams });

export interface ExpTrade extends SimTrade {
  variant: string;
  entryLeg: EntryLeg;
  exitLeg: ExitLeg;
  /** Breakout only. */
  zoneHigh?: Dec;
  breakoutOpenTime?: Date;
  /** Fill distance above the zone top, in ATR. */
  fillExtAtr?: number;
  /** Next-candle open minus breakout close, in ATR (market entries). */
  gapAtr?: number;
}

export interface ExpResult {
  variant: Variant;
  trades: ExpTrade[];
  signals: number;
  /** Decision time of every BUY signal (for per-period signal counts). */
  signalTimes: Date[];
  expiredUnfilled: number;
  /** Why a signal did not become a trade (gap, recomputed R/R, volume …). */
  cancelled: Record<string, number>;
  /** Pair × decision steps that were rejected, by first failing condition. */
  rejections: Record<string, number>;
}

interface Pending {
  pair: string;
  kind: 'limit' | 'market';
  order: PlannedOrder;
  entryLeg: EntryLeg;
  expiresAt: Date;
  decisionAt: Date;
  regime: Regime;
  reservedRisk: Dec;
  ledger: LedgerSignal;
  /** Market breakout orders: context to recompute SL/TP/size at the actual fill. */
  recompute?: { zone: BreakoutZone; atr: Dec; analysis: TechnicalAnalysis; market: MarketContext; riskBudget: Dec; decisionClose: Dec };
}

interface Open extends Pending {
  entryAt: Date;
  entryFill: Dec;
  entryKind: EntryKind;
  held: Candle[];
  extra: Partial<ExpTrade>;
}

interface State {
  v: Variant;
  pending: Pending | null;
  open: Open | null;
  ledger: LedgerSignal[];
  trades: ExpTrade[];
  signals: number;
  signalTimes: Date[];
  expiredUnfilled: number;
  nextId: number;
  cancelled: Record<string, number>;
  rejections: Record<string, number>;
}

interface Prepared {
  s: ExpSeries;
  analysis: TechnicalAnalysis;
  regime: RegimeResult;
  window: Candle[];
  market: MarketContext;
  restrictions: string[];
  /** Lazily computed breakout zones (last candle / previous candle). */
  zones?: { last: BreakoutZone | null; prev: BreakoutZone | null };
}

export interface ExpSimOptions {
  series: ExpSeries[];
  tf: TfSetup;
  variants: Variant[];
  start: Date;
  end: Date;
  limits: RiskLimits;
  maxAllocPct: Dec;
  activeHours: { start: string; end: string };
  timeZone: string;
  settleSec?: number;
  windowSize?: number;
  onProgress?: (at: Date) => void;
}

const bump = (r: Record<string, number>, k: string) => (r[k] = (r[k] ?? 0) + 1);
const tfMs = (tf: Timeframe) => TIMEFRAME_SECONDS[tf] * 1000;

/**
 * Same event loop as src/backtest/simulator.ts, generalised:
 *   - every 15m path candle: pending/open orders are processed against THIS candle only;
 *   - when a main-timeframe candle has just closed: decisions at close + settle, from
 *     final main candles and final trend candles only;
 *   - a new order can fill from the NEXT 15m candle onwards.
 * Variants share the per-pair analysis but have independent positions and ledgers.
 */
export function simulateExperiment(o: ExpSimOptions): ExpResult[] {
  const settle = o.settleSec ?? 90;
  const win = o.windowSize ?? 300;
  const mainMs = tfMs(o.tf.main);
  const mainOf = (s: ExpSeries) => (o.tf.main === '15' ? s.c15 : s.c60);
  const trendOf = (s: ExpSeries) => (o.tf.trend === '60' ? s.c60 : s.c240);
  const idx = o.series.map((s) => ({
    s,
    path: new Map(s.c15.map((c, i) => [c.openTime.getTime(), i])),
    main: new Map(mainOf(s).map((c, i) => [c.openTime.getTime(), i])),
  }));
  const states: State[] = o.variants.map((v) => ({ v, pending: null, open: null, ledger: [], trades: [], signals: 0, signalTimes: [], expiredUnfilled: 0, nextId: 1, cancelled: {}, rejections: {} }));
  const trendCache = new Map<string, boolean>();
  const pathCandle = (pair: string, t: number) => {
    const p = idx.find((x) => x.s.pair === pair)!;
    const i = p.path.get(t);
    return i === undefined ? null : p.s.c15[i]!;
  };
  const spreadOf = (pair: string) => idx.find((x) => x.s.pair === pair)!.s.spreadPct;
  const tickOf = (pair: string) => idx.find((x) => x.s.pair === pair)!.s.info.tickSize;

  const close = (st: State, pos: Open, exitAt: Date, exitPrice: Dec, reason: SimTrade['exitReason'], stopType: boolean, exitLeg: ExitLeg) => {
    const costs = chargedCosts(st.v.cost, pos.entryLeg, exitLeg);
    const pnl = tradePnl(pos.order.quantity, pos.entryFill, exitPrice, stopType ? costs.stopSlippagePct : costs.tpSlippagePct, costs);
    st.trades.push({
      combo: st.v.id,
      variant: st.v.id,
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
      entryLeg: pos.entryLeg,
      exitLeg,
      ...pos.extra,
    });
    pos.ledger.journalClosed = true;
    st.open = null;
  };
  const exitLegOf = (reason: string): ExitLeg => (reason === 'tp' ? 'tp' : reason === 'waktu' ? 'time' : 'stop');

  for (let T = o.start.getTime(); T < o.end.getTime(); T += PATH_MS) {
    if (o.onProgress && T % 86_400_000 === 0) o.onProgress(new Date(T));

    // 1. Orders against this 15m candle.
    for (const st of states) {
      if (st.pending) {
        const p = st.pending;
        const c = pathCandle(p.pair, T);
        if (T >= p.expiresAt.getTime()) {
          p.ledger.lifecycle = 'EXPIRED_UNFILLED';
          st.expiredUnfilled++;
          st.pending = null;
        } else if (c && p.kind === 'limit') {
          const fill = findEntry([c], p.order, { requireVolumeForQuantity: true, inclusive: false });
          if (fill) {
            const entryFill = fill.fillPrice.times(Dec.add(1, st.v.cost.planning.entrySlippagePct.div(100)));
            const pos: Open = { ...p, entryAt: new Date(T + PATH_MS), entryFill, entryKind: fill.kind, held: [], extra: { ...(p.recompute ? { zoneHigh: p.recompute.zone.high, breakoutOpenTime: p.recompute.zone.breakoutOpenTime, fillExtAtr: entryFill.minus(p.recompute.zone.high).div(p.recompute.atr).toNumber() } : {}) } };
            p.ledger.lifecycle = 'POSSIBLY_FILLED';
            p.ledger.execution = 'TAKEN';
            st.pending = null;
            st.open = pos;
            if (fill.immediateExit) close(st, pos, pos.entryAt, fill.immediateExit, fill.kind as SimTrade['exitReason'], true, 'stop');
          }
        } else if (c && p.kind === 'market' && !c.volume.isZero()) {
          // Market buy at this candle's open (+ half spread + slippage), then SL/TP/size are recomputed at that price.
          const v = st.v as Extract<Variant, { kind: 'breakout' }>;
          const r = p.recompute!;
          const fill = marketBuyPrice(c.open, spreadOf(p.pair), v.bo.marketSlipPct, tickOf(p.pair));
          const fillExt = fill.minus(r.zone.high).div(r.atr);
          st.pending = null;
          if (fillExt.gt(v.bo.maxExtAtr)) {
            bump(st.cancelled, `gap: harga isi > ${v.bo.maxExtAtr} ATR di atas zona`);
            p.ledger.lifecycle = 'EXPIRED_UNFILLED';
            st.expiredUnfilled++;
            continue;
          }
          if (c.open.lte(r.zone.low)) {
            bump(st.cancelled, 'gap: open di bawah zona breakout (breakout gagal)');
            p.ledger.lifecycle = 'EXPIRED_UNFILLED';
            st.expiredUnfilled++;
            continue;
          }
          const plan = breakoutPlan({ entry: fill, atr: r.atr, market: r.market, info: idx.find((x) => x.s.pair === p.pair)!.s.info, zone: r.zone, analysis: r.analysis, cfg: v.cfg, bo: v.bo, costs: v.cost.planning, riskBudget: r.riskBudget, capital: o.limits.capital, maxAllocPct: o.maxAllocPct });
          if (!plan.ok) {
            bump(st.cancelled, `dihitung ulang di harga isi: ${plan.reason}`);
            p.ledger.lifecycle = 'EXPIRED_UNFILLED';
            st.expiredUnfilled++;
            continue;
          }
          if (c.volume.lt(plan.sizing.quantity)) {
            bump(st.cancelled, 'volume candle < jumlah order');
            p.ledger.lifecycle = 'EXPIRED_UNFILLED';
            st.expiredUnfilled++;
            continue;
          }
          p.ledger.reservedRisk = plan.sizing.atStop.netLoss;
          p.ledger.lifecycle = 'POSSIBLY_FILLED';
          p.ledger.execution = 'TAKEN';
          const order = { entryMax: fill, stop: plan.stop, takeProfit: plan.takeProfit, quantity: plan.sizing.quantity };
          const pos: Open = {
            ...p,
            order,
            reservedRisk: plan.sizing.atStop.netLoss,
            entryAt: new Date(T),
            entryFill: fill,
            entryKind: 'normal',
            held: [c],
            extra: { zoneHigh: r.zone.high, breakoutOpenTime: r.zone.breakoutOpenTime, fillExtAtr: fillExt.toNumber(), gapAtr: c.open.minus(r.decisionClose).div(r.atr).toNumber() },
          };
          st.open = pos;
          // The rest of the entry candle happens after the fill: SL-first if both are touched.
          const exit = findExit(pos.held, order, st.v.timeStopPath);
          if (exit) close(st, pos, new Date(T + PATH_MS), exit.price, exit.reason, exit.stopType, exitLegOf(exit.reason));
        }
      } else if (st.open) {
        const pos = st.open;
        const c = pathCandle(pos.pair, T);
        if (c) {
          pos.held.push(c);
          const exit = findExit(pos.held, pos.order, st.v.timeStopPath);
          if (exit) close(st, pos, new Date(T + PATH_MS), exit.price, exit.reason, exit.stopType, exitLegOf(exit.reason));
        }
      }
    }

    // 2. Decisions when a main-timeframe candle has just closed.
    const closeAt = T + PATH_MS;
    if (closeAt % mainMs !== 0) continue;
    const decisionAt = new Date(closeAt + settle * 1000);
    const free = states.filter((st) => !st.pending && !st.open);
    if (free.length === 0 || !withinActiveHours(decisionAt, o.timeZone, o.activeHours.start, o.activeHours.end)) continue;

    const prepared: Prepared[] = [];
    for (const p of idx) {
      const r = prepare(p.s, p.main.get(closeAt - mainMs), mainOf(p.s), trendOf(p.s), o.tf, decisionAt, win, settle, trendCache);
      if (typeof r === 'string') {
        for (const st of free) bump(st.rejections, r);
      } else prepared.push(r);
    }
    if (prepared.length === 0) continue;

    const dayStart = startOfDayInZone(decisionAt, o.timeZone);
    for (const st of free) {
      const todayLoss = Dec.max(sum(st.trades.filter((t) => t.exitAt >= dayStart).map((t) => t.netPnl)).neg(), 0);
      const risk = computeRiskState(st.ledger, o.limits, { available: true, amount: todayLoss }, dayStart);
      if (risk.blocks.length) {
        bump(st.rejections, 'G12 batas harian');
        continue;
      }
      const v = st.v;
      if (v.kind === 'pullback') {
        const decisions = prepared.map((e) =>
          evaluateStrategy({
            analysis: e.analysis,
            candles: e.window,
            market: e.market,
            pairInfo: e.s.info,
            qualityIssueCodes: [],
            risk,
            costs: v.cost.planning,
            maxAllocPct: o.maxAllocPct,
            withinActiveHours: true,
            now: decisionAt,
            cfg: v.cfg,
            periods: { atr: ANALYSIS_DEFAULTS.atrPeriod, rsi: ANALYSIS_DEFAULTS.rsiPeriod, volume: ANALYSIS_DEFAULTS.volumePeriod },
            precomputedRegime: e.regime,
            earlyWarning: false,
          }),
        );
        for (const d of decisions) {
          const failed = d.gates.find((g) => g.passed !== true && g.id !== 'G12');
          bump(st.rejections, d.decision === 'BUY_CANDIDATE' ? 'lolos semua syarat' : failed ? `${failed.id} ${failed.label}` : d.decision);
        }
        const best = rankDecisions(decisions)[0];
        if (best?.decision !== 'BUY_CANDIDATE' || !best.plan?.sizing.ok) continue;
        const s = best.plan.sizing;
        const e = prepared.find((x) => x.s.pair === best.pair)!;
        const ledger: LedgerSignal = { id: st.nextId++, pair: best.pair, createdAt: decisionAt, expiresAt: best.plan.expiresAt, reservedRisk: s.atStop.netLoss, lifecycle: 'ACTIVE', execution: 'UNKNOWN' };
        st.ledger.push(ledger);
        st.signals++;
        st.signalTimes.push(decisionAt);
        st.pending = {
          pair: best.pair,
          kind: 'limit',
          order: { entryMax: best.plan.entry.max, stop: best.plan.stop, takeProfit: best.plan.takeProfit, quantity: s.quantity },
          entryLeg: best.plan.entry.max.gte(e.market.bestAsk) ? 'limit_marketable' : 'limit_resting',
          expiresAt: best.plan.expiresAt,
          decisionAt,
          regime: best.regime!.regime,
          reservedRisk: s.atStop.netLoss,
          ledger,
        };
      } else {
        let best: { e: Prepared; c: Extract<ReturnType<typeof evaluateBreakout>, { ok: true }>['candidate'] } | null = null;
        for (const e of prepared) {
          const atrW = windowAtr(e.window);
          e.zones ??= {
            last: detectBreakout(e.window, e.window.length - 1, atrW),
            prev: detectBreakout(e.window, e.window.length - 2, atrW),
          };
          const r = evaluateBreakout({
            analysis: e.analysis,
            regime: e.regime,
            restrictions: e.restrictions,
            window: e.window,
            atrWindow: atrW,
            zones: e.zones,
            atr: effAtr(e.analysis),
            market: e.market,
            info: e.s.info,
            cfg: v.cfg,
            bo: v.bo,
            costs: v.cost.planning,
            riskBudget: risk.nextRiskBudget,
            capital: o.limits.capital,
            maxAllocPct: o.maxAllocPct,
          });
          if (!r.ok) {
            bump(st.rejections, r.reason);
            continue;
          }
          bump(st.rejections, 'lolos semua syarat');
          if (!best || r.candidate.plan.sizing.netRr.gt(best.c.plan.sizing.netRr)) best = { e, c: r.candidate };
        }
        if (!best) continue;
        const { e, c } = best;
        const lastOpen = e.window.at(-1)!.openTime.getTime();
        const expiresAt = new Date(lastOpen + (1 + v.cfg.signal.validCandles) * mainMs);
        const ledger: LedgerSignal = { id: st.nextId++, pair: e.s.pair, createdAt: decisionAt, expiresAt, reservedRisk: c.plan.sizing.atStop.netLoss, lifecycle: 'ACTIVE', execution: 'UNKNOWN' };
        st.ledger.push(ledger);
        st.signals++;
        st.signalTimes.push(decisionAt);
        st.pending = {
          pair: e.s.pair,
          kind: v.bo.entry === 'retest' ? 'limit' : 'market',
          order: { entryMax: c.entry, stop: c.plan.stop, takeProfit: c.plan.takeProfit, quantity: c.plan.sizing.quantity },
          entryLeg: c.entryKind,
          expiresAt,
          decisionAt,
          regime: e.regime.regime,
          reservedRisk: c.plan.sizing.atStop.netLoss,
          ledger,
          recompute: { zone: c.zone, atr: c.atr, analysis: e.analysis, market: e.market, riskBudget: risk.nextRiskBudget, decisionClose: e.window.at(-1)!.close },
        };
      }
    }
  }

  for (const st of states) {
    if (st.pending) {
      st.pending.ledger.lifecycle = 'EXPIRED_UNFILLED';
      st.expiredUnfilled++;
      st.pending = null;
    }
    if (st.open) {
      const last = st.open.held.at(-1);
      close(st, st.open, last ? new Date(last.openTime.getTime() + PATH_MS) : st.open.entryAt, last?.close ?? st.open.entryFill, 'akhir_data', true, 'end');
    }
  }
  return states.map((st) => ({ variant: st.v, trades: st.trades, signals: st.signals, signalTimes: st.signalTimes, expiredUnfilled: st.expiredUnfilled, cancelled: st.cancelled, rejections: st.rejections }));
}

function effAtr(a: TechnicalAnalysis): Dec | null {
  const values = [a.volatility?.atr14.value, a.volatility?.atr14Traded.value].filter((v): v is Dec => !!v && v.gt(0));
  return values.length ? Dec.max(...values) : null;
}

/** Final candles of `candles` at `at`, last `window` (binary search, ascending). */
function finalAt(candles: Candle[], tf: Timeframe, at: Date, window: number, settle: number): Candle[] {
  let lo = 0;
  let hi = candles.length;
  const limit = at.getTime() - tfMs(tf) - settle * 1000;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.openTime.getTime() <= limit) lo = mid + 1;
    else hi = mid;
  }
  return candles.slice(Math.max(0, lo - window), lo);
}

function prepare(
  s: ExpSeries,
  i: number | undefined,
  main: Candle[],
  trendCandles: Candle[],
  tf: TfSetup,
  at: Date,
  window: number,
  settle: number,
  cache: Map<string, boolean>,
): Prepared | string {
  if (i === undefined || i + 1 < window) return 'data: candle tidak tersedia';
  const w = main.slice(i + 1 - window, i + 1);
  if (!w.every((c) => isFinalCandle(c, at, settle))) throw new Error('look-ahead: candle utama belum final');
  const wt = finalAt(trendCandles, tf.trend, at, window, settle);
  if (!wt.every((c) => isFinalCandle(c, at, settle))) throw new Error('look-ahead: candle tren belum final');
  const lastT = wt.at(-1);
  const key = `${s.pair}:${lastT?.openTime.getTime() ?? 0}`;
  let bullish = cache.get(key);
  if (bullish === undefined) {
    // Exact pre-filter (as in the production simulator): every BUY needs these trend-timeframe conditions.
    const fresh = !!lastT && lastT.openTime >= expectedLatestFinalOpenTime(tf.trend, at, settle);
    const t = fresh ? analyzeTrend(wt, tf.trend, ANALYSIS_DEFAULTS) : null;
    bullish = !!t && t.stack.value === 'naik' && !!t.closeVsEma50Pct?.gt(0) && !!t.ema20SlopePct.value?.gte(0);
    cache.set(key, bullish);
  }
  if (!bullish) return `G2 regime bullish terkonfirmasi ${tf.trend === '60' ? '1j' : '4j'}`;

  const a = analyzeCandleSeries(w, tf.main, 20);
  if (a.duplicates || a.misaligned || a.missingIntervals || a.invalidOhlc) return 'data: deret candle tidak valid (gap)';
  const issues: QualityIssue[] = [];
  if (a.recentCount > 0 && a.zeroVolumeRecent / a.recentCount > 0.3) {
    issues.push({ code: 'LOW_LIQUIDITY', severity: 'warning', message: `${a.zeroVolumeRecent} dari ${a.recentCount} candle terakhir tanpa transaksi` });
  }
  const data: PairMarketData = {
    pair: s.pair,
    pairInfo: s.info,
    fetchedAt: at,
    timeframe: tf.main,
    ticker: null,
    orderBook: null,
    metrics: null,
    tradeActivity: null,
    finalCandles: w,
    pendingCandle: null,
    quality: { status: issues.length ? 'DEGRADED' : 'OK', issues, checkedAt: at },
    trendTimeframe: tf.trend,
    trendCandles: wt,
    trendError: null,
    snapshotId: null,
  };
  const analysis = computeTechnicalAnalysis(data, ANALYSIS_DEFAULTS, at, settle);
  const regime = detectRegime(analysis, w, tf.regime, ANALYSIS_DEFAULTS.atrPeriod);
  return { s, analysis, regime, window: w, market: syntheticMarket(w, s, tf.candles24h), restrictions: reliability(analysis) };
}

/** Same as the production syntheticMarket, with the 24 h window expressed in main-timeframe candles. */
export function syntheticMarket(w: Candle[], s: ExpSeries, candles24h: number): MarketContext {
  const close = w.at(-1)!.close;
  const tick = s.info.tickSize;
  const half = close.times(s.spreadPct).div(200);
  const bid = floorToStep(close.minus(half), tick);
  let ask = ceilToStep(close.plus(half), tick);
  if (ask.lte(bid)) ask = bid.plus(tick ?? new Dec('0.00000001'));
  const spread = ask.minus(bid);
  return {
    bestBid: bid,
    bestAsk: ask,
    spread,
    spreadPct: spread.div(bid.plus(ask).div(2)).times(100),
    imbalance1: null,
    tradeBuyRatio: null,
    askDepthBase1: null,
    bids: null,
    volumeIdr24h: sum(w.slice(-candles24h).map((c) => c.close.times(c.volume))),
    orderBookNeutralised: true,
  };
}

/** Mirror of the engine's reliability restrictions (caps a BUY at EARLY_WARNING). */
function reliability(a: TechnicalAnalysis): string[] {
  const out: string[] = [];
  const check = (name: string, r: Reading<unknown> | undefined) => {
    if (r?.reliability === 'kurang_andal') out.push(name);
  };
  for (const t of [a.main, a.trend]) {
    if (!t || t.unavailableReason) continue;
    check('EMA9', t.ema9);
    check('EMA20', t.ema20);
    check('EMA50', t.ema50);
    if (t === a.main) check('RSI14', t.rsi14);
  }
  check('volume', a.volume?.ratio);
  if (!a.trend || a.trend.unavailableReason) out.push('tren tidak tersedia');
  return out;
}
