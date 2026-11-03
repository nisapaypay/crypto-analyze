import { Dec } from '../../src/app/decimal.js';
import type { Reading, TechnicalAnalysis, TrendAnalysis } from '../../src/analysis/types.js';
import type { LevelDistance, Zone } from '../../src/indicators/support-resistance.js';
import type { Candle } from '../../src/market/types.js';
import { resolveCosts } from '../../src/risk/costs.js';
import { computeRiskState, JOURNAL_UNAVAILABLE_REASON, type LedgerSignal, type RiskLimits } from '../../src/risk/risk-ledger.js';
import { STRATEGY_DEFAULTS } from '../../src/strategy/config.js';
import type { StrategyInput } from '../../src/strategy/strategy-engine.js';
import type { MarketContext } from '../../src/strategy/types.js';
import { makePair } from './market.js';

export const T0 = new Date('2026-11-02T04:00:00Z'); // 11:00 WIB, last final candle open
export const EVAL_AT = new Date('2026-11-02T04:16:30Z'); // 11:16:30 WIB
export const DAY_START = new Date('2026-11-01T17:00:00Z'); // 00:00 WIB

export const ok = <T>(value: T, notes: string[] = []): Reading<T> => ({ value, reliability: notes.length ? 'kurang_andal' : 'andal', notes });

export const LIMITS: RiskLimits = {
  capital: new Dec(5_000_000),
  riskPerTradePct: new Dec('0.5'),
  dailyLossLimitPct: new Dec('1.5'),
  maxDailyRecommendations: 3,
  maxActivePositions: 1,
  minBudgetShare: 0.5,
};

export const UNAVAILABLE = { available: false as const, reason: JOURNAL_UNAVAILABLE_REASON };

export function riskState(signals: LedgerSignal[] = []) {
  return computeRiskState(signals, LIMITS, UNAVAILABLE, DAY_START);
}

/**
 * 300 final 15m candles ending at `T0`, every candle with true range = `atr`
 * (so ATR is stable: no HIGH_VOLATILITY), gently rising to `close`.
 */
export function steadyCandles(close: Dec | number | string, atr: Dec | number | string, count = 300, volume = '1'): Candle[] {
  const c = new Dec(close);
  const a = new Dec(atr);
  const step = a.div(100);
  return Array.from({ length: count }, (_, i) => {
    const px = c.minus(step.times(count - 1 - i));
    return {
      pair: 'qnt_idr',
      timeframe: '15' as const,
      openTime: new Date(T0.getTime() - (count - 1 - i) * 900_000),
      open: px.minus(step),
      high: px.plus(a.div(2)),
      low: px.minus(a.div(2)),
      close: px,
      volume: new Dec(volume),
    };
  });
}

function zone(low: Dec | number | string, high?: Dec | number | string): Zone {
  return {
    low: new Dec(low),
    high: new Dec(high ?? low),
    touches: 2,
    swingHighs: 1,
    swingLows: 1,
    firstPivotAt: new Date(T0.getTime() - 40 * 900_000),
    lastPivotAt: new Date(T0.getTime() - 20 * 900_000),
    lastConfirmedAt: new Date(T0.getTime() - 17 * 900_000),
    candlesSinceConfirmed: 17,
    freshness: 'lama',
  };
}

function level(z: Zone, close: Dec, atr: Dec, above: boolean): LevelDistance {
  const distance = above ? z.low.minus(close) : close.minus(z.high);
  return { zone: z, distance, distancePct: distance.div(close).times(100), distanceAtr: distance.div(atr) };
}

function trend(tf: '15' | '60', o: { close: Dec; ema9: Dec; ema20: Dec; ema50: Dec; rsi: Dec; slope: Dec; stack: 'naik' | 'turun' | 'campuran'; crossover?: TrendAnalysis['crossover']; notes?: string[] }): TrendAnalysis {
  const n = o.notes ?? [];
  return {
    timeframe: tf,
    unavailableReason: null,
    candleCount: 300,
    windowStart: new Date(T0.getTime() - 299 * 900_000),
    lastCandleOpen: tf === '15' ? T0 : new Date('2026-11-02T03:00:00Z'),
    close: o.close,
    ema9: ok(o.ema9, n),
    ema20: ok(o.ema20),
    ema50: ok(o.ema50),
    stack: ok(o.stack),
    closeVsEma20Pct: o.close.minus(o.ema20).div(o.ema20).times(100),
    closeVsEma50Pct: o.close.minus(o.ema50).div(o.ema50).times(100),
    ema20SlopePct: ok(o.slope),
    crossover: o.crossover ?? null,
    rsi14: ok(o.rsi),
    rsiLabel: null,
  };
}

export interface ScenarioOptions {
  close?: number | string;
  atr?: number | string;
  rsi?: number | string;
  volumeRatio?: number | string;
  volumeNotes?: string[];
  ema9?: number | string;
  ema20?: number | string;
  ema50?: number | string;
  slope?: number | string;
  stack15?: 'naik' | 'turun' | 'campuran';
  stack1h?: 'naik' | 'turun' | 'campuran' | null;
  h1Slope?: number | string;
  h1BelowEma50?: boolean;
  supports?: (number | string)[];
  resistances?: (number | string)[];
  status?: 'OK' | 'DEGRADED' | 'UNAVAILABLE';
  warnings?: string[];
  crossover?: TrendAnalysis['crossover'];
  ema9Notes?: string[];
}

/**
 * Bullish, all-gates-pass scenario modelled on simulation A′ (QNT, ATR 30.000 =
 * 0,84% so gate G10 passes). Override fields to build the other cases.
 */
export function scenario(o: ScenarioOptions = {}): TechnicalAnalysis {
  const close = new Dec(o.close ?? 3_578_000);
  const atr = new Dec(o.atr ?? 30_000);
  const main = trend('15', {
    close,
    ema9: new Dec(o.ema9 ?? 3_570_000),
    ema20: new Dec(o.ema20 ?? 3_560_000),
    ema50: new Dec(o.ema50 ?? 3_540_000),
    rsi: new Dec(o.rsi ?? 60),
    slope: new Dec(o.slope ?? '0.05'),
    stack: o.stack15 ?? 'naik',
    crossover: o.crossover ?? null,
    notes: o.ema9Notes ?? [],
  });
  const h1Close = close;
  const h1 =
    o.stack1h === null
      ? { ...trend('60', { close, ema9: close, ema20: close, ema50: close, rsi: new Dec(50), slope: new Dec(0), stack: 'campuran' }), unavailableReason: 'belum ada candle 1 jam final' }
      : trend('60', {
          close: h1Close,
          ema9: new Dec(3_565_000),
          ema20: new Dec(3_550_000),
          ema50: o.h1BelowEma50 ? new Dec(3_600_000) : new Dec(3_500_000),
          rsi: new Dec(58),
          slope: new Dec(o.h1Slope ?? '0.10'),
          stack: o.stack1h ?? 'naik',
        });
  const status = o.status ?? 'OK';
  const supports = (o.supports ?? [3_540_000]).map((s) => level(zone(s, new Dec(s).plus(atr.div(5))), close, atr, false));
  const resistances = (o.resistances ?? [3_760_000]).map((r) => level(zone(r, new Dec(r).plus(atr.div(2))), close, atr, true));
  return {
    pair: 'qnt_idr',
    engineVersion: '3.0.0',
    computedAt: EVAL_AT,
    status,
    unavailableReasons: status === 'UNAVAILABLE' ? ['Ticker basi (120 dtk > 90 dtk)'] : [],
    dataWarnings: o.warnings ?? (status === 'DEGRADED' ? ['12 dari 20 candle terakhir tanpa transaksi (volume 0)'] : []),
    livePrice: close,
    pendingCandleOpen: null,
    main: status === 'UNAVAILABLE' ? null : main,
    trend: status === 'UNAVAILABLE' ? null : h1,
    volatility: { atr14: ok(atr), atr14Pct: atr.div(close).times(100), atr14Traded: ok(atr), zeroVolumeCount: 0 },
    volume: { stats: null, ratio: ok(new Dec(o.volumeRatio ?? '1.6'), o.volumeNotes ?? []), label: null },
    orderBook: null,
    levels: {
      reliability: 'andal',
      notes: [],
      reference: close,
      supports,
      resistances,
      inside: [],
      pivotCount: 6,
      rangeHigh: null,
      rangeLow: null,
      high24h: null,
      low24h: null,
    },
  };
}

export function marketCtx(o: Partial<MarketContext> = {}): MarketContext {
  const bid = o.bestBid ?? new Dec(3_575_000);
  const ask = o.bestAsk ?? new Dec(3_580_000);
  const spread = ask.minus(bid);
  return {
    bestBid: bid,
    bestAsk: ask,
    spread,
    spreadPct: spread.div(bid.plus(ask).div(2)).times(100),
    imbalance1: new Dec('0.1'),
    tradeBuyRatio: new Dec('0.6'),
    askDepthBase1: new Dec(10),
    bids: [{ price: bid, volume: new Dec(5) }],
    volumeIdr24h: new Dec('626978777'),
    ...o,
  };
}

/** Engine input for the A′ scenario; override any field. */
export function engineInput(o: Partial<StrategyInput> & { scenario?: ScenarioOptions } = {}): StrategyInput {
  const analysis = o.analysis ?? scenario(o.scenario);
  const close = analysis.main?.close ?? new Dec(3_578_000);
  const atr = analysis.volatility?.atr14.value ?? new Dec(30_000);
  return {
    analysis,
    candles: o.candles ?? steadyCandles(close, atr),
    market: o.market === undefined ? marketCtx() : o.market,
    pairInfo: o.pairInfo ?? makePair(),
    qualityIssueCodes: o.qualityIssueCodes ?? [],
    risk: o.risk ?? riskState(),
    costs: o.costs ?? resolveCosts(),
    maxAllocPct: o.maxAllocPct ?? new Dec(50),
    withinActiveHours: o.withinActiveHours ?? true,
    now: o.now ?? EVAL_AT,
    cfg: o.cfg ?? STRATEGY_DEFAULTS,
    periods: o.periods ?? { atr: 14, rsi: 14, volume: 20 },
  };
}

export function ledgerSignal(o: Partial<LedgerSignal> & { id: number }): LedgerSignal {
  return {
    pair: 'qnt_idr',
    createdAt: new Date('2026-11-02T04:16:30Z'),
    expiresAt: new Date('2026-11-02T04:45:00Z'),
    reservedRisk: new Dec(25_000),
    lifecycle: 'ACTIVE',
    execution: 'UNKNOWN',
    ...o,
  };
}
