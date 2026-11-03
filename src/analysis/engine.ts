import { Dec } from '../app/decimal.js';
import { atrSeries, atrTradedLast } from '../indicators/atr.js';
import { emaSeries } from '../indicators/ema.js';
import { classifyImbalance, classifyTradeFlow, isConsistent } from '../indicators/orderbook-pressure.js';
import { rsiSeries } from '../indicators/rsi.js';
import { supportResistance } from '../indicators/support-resistance.js';
import { volumeStats } from '../indicators/volume.js';
import { analyzeCandleSeries, expectedLatestFinalOpenTime, isFinalCandle } from '../market/candles.js';
import type { PairMarketData } from '../market/market-data-service.js';
import type { Candle, Timeframe } from '../market/types.js';
import type { AnalysisConfig } from './config.js';
import { rsiLabel, volumeLabel } from './interpretation.js';
import type {
  EmaStack,
  LevelsAnalysis,
  OrderBookAnalysis,
  Reading,
  Reliability,
  TechnicalAnalysis,
  TrendAnalysis,
  VolatilityAnalysis,
  VolumeAnalysis,
} from './types.js';

export class NonFinalCandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonFinalCandleError';
  }
}

/**
 * Guard: indicators may only ever see final candles of one timeframe, in
 * strictly ascending order. Anything else is a programming error.
 */
export function assertFinalSeries(candles: Candle[], timeframe: Timeframe, now: Date, settleSec: number): void {
  candles.forEach((c, i) => {
    if (c.timeframe !== timeframe) throw new NonFinalCandleError(`Candle ${c.openTime.toISOString()} bukan timeframe ${timeframe}`);
    if (!isFinalCandle(c, now, settleSec)) {
      throw new NonFinalCandleError(`Candle ${c.openTime.toISOString()} (${timeframe}) belum final`);
    }
    if (i > 0 && c.openTime <= candles[i - 1]!.openTime) throw new NonFinalCandleError('Candle tidak berurutan naik');
  });
}

const available = <T>(value: T, notes: string[] = []): Reading<T> => ({
  value,
  reliability: notes.length > 0 ? 'kurang_andal' : 'andal',
  notes,
});
const unavailable = <T>(note: string): Reading<T> => ({ value: null, reliability: 'tidak_tersedia', notes: [note] });

function worst(...levels: Reliability[]): Reliability {
  if (levels.includes('tidak_tersedia')) return 'tidak_tersedia';
  if (levels.includes('kurang_andal')) return 'kurang_andal';
  return 'andal';
}

function zeroVolumeNote(window: Candle[], threshold: number): string | null {
  const zero = window.filter((c) => c.volume.isZero()).length;
  return window.length > 0 && zero / window.length > threshold
    ? `${zero} dari ${window.length} candle tanpa transaksi (volume 0)`
    : null;
}

const pct = (a: Dec, b: Dec) => a.minus(b).div(b).times(100);

/** EMA, RSI and trend structure for one timeframe. Candles must be final. */
export function analyzeTrend(candles: Candle[], timeframe: Timeframe, cfg: AnalysisConfig, unavailableReason: string | null = null): TrendAnalysis {
  const closes = candles.map((c) => c.close);
  const last = candles.at(-1) ?? null;
  const [p9, p20, p50] = cfg.emaPeriods;
  const threshold = cfg.zeroVolumeReliabilityThreshold;

  const emaReading = (series: (Dec | null)[], period: number): Reading<Dec> => {
    const value = series.at(-1) ?? null;
    if (value === null) return unavailable(`butuh ${period} candle final, tersedia ${candles.length}`);
    const notes: string[] = [];
    if (candles.length < period * cfg.warmupMultiple) notes.push(`masa pemanasan: ${candles.length} < ${period * cfg.warmupMultiple} candle`);
    const zero = zeroVolumeNote(candles.slice(-period), threshold);
    if (zero) notes.push(zero);
    return available(value, notes);
  };

  const s9 = emaSeries(closes, p9);
  const s20 = emaSeries(closes, p20);
  const s50 = emaSeries(closes, p50);
  const ema9 = emaReading(s9, p9);
  const ema20 = emaReading(s20, p20);
  const ema50 = emaReading(s50, p50);

  let stack: Reading<EmaStack> = unavailable('EMA belum lengkap');
  if (ema9.value && ema20.value && ema50.value) {
    const value: EmaStack =
      ema9.value.gt(ema20.value) && ema20.value.gt(ema50.value)
        ? 'naik'
        : ema9.value.lt(ema20.value) && ema20.value.lt(ema50.value)
          ? 'turun'
          : 'campuran';
    const reliability = worst(ema9.reliability, ema20.reliability, ema50.reliability);
    stack = { value, reliability, notes: reliability === 'andal' ? [] : ['salah satu EMA kurang andal'] };
  }

  // EMA20 slope over the last `slopeCandles` candles.
  const prev20 = s20.at(-1 - cfg.slopeCandles) ?? null;
  const ema20SlopePct: Reading<Dec> =
    ema20.value && prev20
      ? { value: pct(ema20.value, prev20), reliability: ema20.reliability, notes: ema20.notes }
      : unavailable(`butuh ${p20 + cfg.slopeCandles} candle final`);

  // Most recent EMA9/EMA20 crossover within the lookback window.
  let crossover: TrendAnalysis['crossover'] = null;
  for (let ago = 0; ago < cfg.crossoverLookback; ago++) {
    const i = candles.length - 1 - ago;
    const a9 = s9[i], a20 = s20[i], b9 = s9[i - 1], b20 = s20[i - 1];
    if (!a9 || !a20 || !b9 || !b20) break;
    const now = a9.comparedTo(a20);
    const before = b9.comparedTo(b20);
    if (now !== before && now !== 0) {
      crossover = { direction: now > 0 ? 'ke_atas' : 'ke_bawah', candlesAgo: ago };
      break;
    }
  }

  // RSI (Wilder).
  const rsiValue = rsiSeries(closes, cfg.rsiPeriod).at(-1) ?? null;
  let rsi14: Reading<Dec>;
  if (candles.length < cfg.rsiPeriod + 1) rsi14 = unavailable(`butuh ${cfg.rsiPeriod + 1} candle final, tersedia ${candles.length}`);
  else if (rsiValue === null) rsi14 = unavailable('tidak ada pergerakan harga dalam jendela RSI');
  else {
    const notes: string[] = [];
    const zero = zeroVolumeNote(candles.slice(-cfg.rsiPeriod), threshold);
    if (zero) notes.push(zero);
    if (rsiValue.eq(100)) notes.push('RSI 100: tidak ada candle turun dalam periode smoothing');
    if (rsiValue.eq(0)) notes.push('RSI 0: tidak ada candle naik dalam periode smoothing');
    rsi14 = available(rsiValue, notes);
  }

  return {
    timeframe,
    unavailableReason,
    candleCount: candles.length,
    windowStart: candles[0]?.openTime ?? null,
    lastCandleOpen: last?.openTime ?? null,
    close: last?.close ?? null,
    ema9,
    ema20,
    ema50,
    stack,
    closeVsEma20Pct: last && ema20.value ? pct(last.close, ema20.value) : null,
    closeVsEma50Pct: last && ema50.value ? pct(last.close, ema50.value) : null,
    ema20SlopePct,
    crossover,
    rsi14,
    rsiLabel: rsiLabel(rsi14.value),
  };
}

function emptyTrend(timeframe: Timeframe, reason: string, cfg: AnalysisConfig): TrendAnalysis {
  return analyzeTrend([], timeframe, cfg, reason);
}

export function analyzeVolatility(candles: Candle[], cfg: AnalysisConfig): VolatilityAnalysis {
  const n = cfg.atrPeriod;
  const value = atrSeries(candles, n).at(-1) ?? null;
  const window = candles.slice(-n);
  const zeroVolumeCount = window.filter((c) => c.volume.isZero()).length;

  let atr14: Reading<Dec>;
  if (value === null) atr14 = unavailable(`butuh ${n} candle final`);
  else {
    const zero = zeroVolumeNote(window, cfg.zeroVolumeReliabilityThreshold);
    atr14 = available(value, zero ? [`${zero}; ATR mengecil — bandingkan dengan ATR candle bertransaksi`] : []);
  }

  const traded = atrTradedLast(candles, n);
  const atr14Traded: Reading<Dec> =
    traded.value === null ? unavailable(`butuh ${n} candle bertransaksi, tersedia ${traded.tradedCount}`) : available(traded.value);

  const close = candles.at(-1)?.close ?? null;
  return {
    atr14,
    atr14Pct: value && close ? value.div(close).times(100) : null,
    atr14Traded,
    zeroVolumeCount,
  };
}

export function analyzeVolume(candles: Candle[], cfg: AnalysisConfig): VolumeAnalysis {
  const stats = volumeStats(candles, cfg.volumePeriod);
  let ratio: Reading<Dec>;
  if (!stats) ratio = unavailable(`butuh ${cfg.volumePeriod + 1} candle final`);
  else if (stats.ratio === null) ratio = unavailable(`tidak ada transaksi dalam ${cfg.volumePeriod} candle sebelumnya`);
  else {
    const unreliable = stats.zeroCount / stats.window > cfg.zeroVolumeReliabilityThreshold;
    ratio = available(
      stats.ratio,
      unreliable ? [`${stats.zeroCount} dari ${stats.window} candle tanpa transaksi; rasio mudah membesar — lihat rasio terhadap MA candle bertransaksi`] : [],
    );
  }
  return { stats, ratio, label: volumeLabel(ratio.value) };
}

export function analyzeOrderBook(data: PairMarketData, cfg: AnalysisConfig): OrderBookAnalysis {
  const m = data.metrics;
  if (!m) {
    return { reliability: 'tidak_tersedia', notes: ['order book tidak tersedia'], bands: [], tradeBuyRatio: null, tradeFlow: null, consistent: null };
  }
  const bands = m.bands.map((b) => ({
    pct: b.pct,
    imbalance: b.imbalance,
    pressure: b.imbalance ? classifyImbalance(b.imbalance, cfg.imbalanceThreshold) : null,
  }));
  const notes = m.bands.filter((b) => b.truncated).map((b) => `kedalaman ±${b.pct}% terpotong`);
  const buyRatio = data.tradeActivity?.buyRatio ?? null;
  const tradeFlow = buyRatio ? classifyTradeFlow(buyRatio, cfg.imbalanceThreshold) : null;
  const near = bands[0]?.pressure ?? null;
  const consistent = near && tradeFlow ? isConsistent(near, tradeFlow) : null;
  if (consistent === false) notes.push('order book dan arus trade berlawanan arah');
  if (!tradeFlow) notes.push('tidak ada trade dalam jendela aktivitas');
  return {
    reliability: m.bands.some((b) => b.truncated) ? 'kurang_andal' : 'andal',
    notes,
    bands,
    tradeBuyRatio: buyRatio,
    tradeFlow,
    consistent,
  };
}

export function analyzeLevels(candles: Candle[], atr: Dec | null, data: PairMarketData, cfg: AnalysisConfig): LevelsAnalysis {
  const reference = candles.at(-1)?.close ?? null;
  const range = candles.slice(-cfg.rangeCandles);
  const base = {
    reference,
    rangeHigh: range.length ? Dec.max(...range.map((c) => c.high)) : null,
    rangeLow: range.length ? Dec.min(...range.map((c) => c.low)) : null,
    high24h: data.ticker?.high24h ?? null,
    low24h: data.ticker?.low24h ?? null,
  };
  if (!reference || !atr || atr.isZero()) {
    return { ...base, reliability: 'tidak_tersedia', notes: ['ATR tidak tersedia untuk toleransi zona'], supports: [], resistances: [], inside: [], pivotCount: 0 };
  }
  const sr = supportResistance(candles, reference, atr, {
    k: cfg.fractalK,
    toleranceAtr: cfg.srToleranceAtr,
    freshCandles: cfg.srFreshCandles,
    maxPerSide: cfg.srMaxPerSide,
  });
  const notes: string[] = [];
  if (sr.pivotCount === 0) notes.push('belum ada swing pivot yang terkonfirmasi');
  if (sr.supports.length === 0) notes.push('tidak ada zona support di bawah harga');
  if (sr.resistances.length === 0) notes.push('tidak ada zona resistance di atas harga');
  return {
    ...base,
    reliability: sr.pivotCount === 0 ? 'tidak_tersedia' : 'andal',
    notes,
    supports: sr.supports,
    resistances: sr.resistances,
    inside: sr.inside,
    pivotCount: sr.pivotCount,
  };
}

/** Why trend (1H) candles cannot be used, or null if they can. */
function trendUnavailableReason(data: PairMarketData, now: Date, settleSec: number): string | null {
  if (data.trendError) return `gagal mengambil candle 1 jam: ${data.trendError}`;
  const candles = data.trendCandles;
  if (candles.length === 0) return 'belum ada candle 1 jam final';
  const a = analyzeCandleSeries(candles, data.trendTimeframe, 1);
  if (a.duplicates || a.misaligned || a.missingIntervals || a.invalidOhlc) {
    return 'deret candle 1 jam tidak valid (gap/duplikat/tidak sejajar)';
  }
  const expected = expectedLatestFinalOpenTime(data.trendTimeframe, now, settleSec);
  if (a.latestOpenTime && a.latestOpenTime < expected) return 'candle 1 jam tertinggal (belum diperbarui)';
  return null;
}

/**
 * Compute every Milestone 3 indicator from Milestone 2 market data.
 * Pure and deterministic for the same input and `now`.
 */
export function computeTechnicalAnalysis(data: PairMarketData, cfg: AnalysisConfig, now: Date, settleSec: number): TechnicalAnalysis {
  const base = {
    pair: data.pair,
    engineVersion: cfg.engineVersion,
    computedAt: now,
    status: data.quality.status,
    unavailableReasons: data.quality.issues.filter((i) => i.severity === 'critical').map((i) => i.message),
    dataWarnings: data.quality.issues.filter((i) => i.severity === 'warning').map((i) => i.message),
    livePrice: data.ticker?.last ?? null,
    pendingCandleOpen: data.pendingCandle?.openTime ?? null,
  };

  // Quality gate: no indicators at all on UNAVAILABLE data.
  if (data.quality.status === 'UNAVAILABLE') {
    return { ...base, main: null, trend: null, volatility: null, volume: null, orderBook: null, levels: null };
  }

  assertFinalSeries(data.finalCandles, data.timeframe, now, settleSec);
  const main = analyzeTrend(data.finalCandles, data.timeframe, cfg);

  const trendReason = trendUnavailableReason(data, now, settleSec);
  let trend: TrendAnalysis;
  if (trendReason) trend = emptyTrend(data.trendTimeframe, trendReason, cfg);
  else {
    assertFinalSeries(data.trendCandles, data.trendTimeframe, now, settleSec);
    trend = analyzeTrend(data.trendCandles, data.trendTimeframe, cfg);
  }

  const volatility = analyzeVolatility(data.finalCandles, cfg);
  return {
    ...base,
    main,
    trend,
    volatility,
    volume: analyzeVolume(data.finalCandles, cfg),
    orderBook: analyzeOrderBook(data, cfg),
    levels: analyzeLevels(data.finalCandles, volatility.atr14.value, data, cfg),
  };
}
