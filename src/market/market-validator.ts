import { analyzeCandleSeries, expectedLatestFinalOpenTime } from './candles.js';
import type { MarketDataConfig } from './config.js';
import type { OrderBookMetrics } from './orderbook-service.js';
import type { Candle, OrderBook, PairInfo, Ticker, Timeframe, Trade } from './types.js';

/**
 * Data-quality gate (PRD §6.4).
 *  OK          — data valid.
 *  DEGRADED    — data valid, with warnings.
 *  UNAVAILABLE — critical data missing/stale/invalid; must never yield BUY.
 */
export type QualityStatus = 'OK' | 'DEGRADED' | 'UNAVAILABLE';

export interface QualityIssue {
  code: string;
  severity: 'critical' | 'warning';
  message: string;
}

export interface QualityReport {
  status: QualityStatus;
  issues: QualityIssue[];
  checkedAt: Date;
}

export interface ValidationInput {
  pair: string;
  pairInfo: PairInfo | null;
  ticker: Ticker | null;
  orderBook: OrderBook | null;
  metrics: OrderBookMetrics | null;
  /** Final candles only, ascending. */
  finalCandles: Candle[];
  timeframe: Timeframe;
  trades: Trade[] | null;
  /** Fetch errors per data source, e.g. { source: 'ticker', message }. */
  fetchErrors: { source: string; message: string }[];
  now: Date;
}

type Thresholds = Pick<
  MarketDataConfig,
  | 'tickerMaxAgeSec'
  | 'orderBookMaxAgeSec'
  | 'maxFutureSkewSec'
  | 'minFinalCandles'
  | 'candleSettleSec'
  | 'liquidityLookback'
  | 'maxZeroVolumeRatio'
>;

/** The only question later milestones may ask before producing a BUY. */
export function canProduceBuySignal(report: QualityReport): boolean {
  return report.status !== 'UNAVAILABLE';
}

export function validateMarketData(input: ValidationInput, t: Thresholds): QualityReport {
  const issues: QualityIssue[] = [];
  const critical = (code: string, message: string) => issues.push({ code, severity: 'critical', message });
  const warning = (code: string, message: string) => issues.push({ code, severity: 'warning', message });
  const nowMs = input.now.getTime();

  for (const e of input.fetchErrors) critical(`FETCH_FAILED_${e.source.toUpperCase()}`, `Gagal mengambil ${e.source}: ${e.message}`);

  // Pair status
  if (!input.pairInfo) {
    critical('PAIR_NOT_FOUND', 'Pair tidak ditemukan di Indodax');
  } else {
    if (input.pairInfo.isMaintenance) critical('PAIR_MAINTENANCE', 'Pair sedang maintenance');
    if (input.pairInfo.isSuspended) critical('PAIR_SUSPENDED', 'Pasar pair sedang disuspend');
  }

  // Ticker
  const tk = input.ticker;
  if (!tk) {
    critical('TICKER_MISSING', 'Ticker tidak tersedia');
  } else {
    if (![tk.last, tk.bid, tk.ask].every((v) => v.gt(0))) critical('TICKER_INVALID_PRICE', 'Harga ticker tidak valid (≤ 0)');
    else if (tk.bid.gte(tk.ask)) critical('TICKER_INVALID_PRICE', 'Ticker bid ≥ ask');
    const ageSec = (nowMs - tk.serverTime.getTime()) / 1000;
    if (ageSec > t.tickerMaxAgeSec) critical('TICKER_STALE', `Ticker basi (${Math.round(ageSec)} dtk > ${t.tickerMaxAgeSec} dtk)`);
    if (-ageSec > t.maxFutureSkewSec) critical('TICKER_FUTURE', `Waktu ticker ${Math.round(-ageSec)} dtk di masa depan`);
  }

  // Order book
  const ob = input.orderBook;
  if (!ob) {
    critical('ORDERBOOK_MISSING', 'Order book tidak tersedia');
  } else if (!input.metrics) {
    critical('ORDERBOOK_EMPTY_SIDE', 'Order book kosong di salah satu sisi');
  } else {
    if (input.metrics.crossed) critical('ORDERBOOK_CROSSED', 'Order book crossed (bid ≥ ask)');
    const ageSec = (nowMs - ob.fetchedAt.getTime()) / 1000 + (ob.cacheAgeSec ?? 0);
    if (ageSec > t.orderBookMaxAgeSec) critical('ORDERBOOK_STALE', `Order book basi (${Math.round(ageSec)} dtk > ${t.orderBookMaxAgeSec} dtk)`);
    const truncated = input.metrics.bands.filter((b) => b.truncated).map((b) => `±${b.pct}%`);
    if (truncated.length > 0) warning('ORDERBOOK_BAND_TRUNCATED', `Kedalaman order book tidak mencakup penuh ${truncated.join(', ')}`);
  }

  // Candles (final only)
  const a = analyzeCandleSeries(input.finalCandles, input.timeframe, t.liquidityLookback);
  if (a.count < t.minFinalCandles) {
    critical('CANDLES_INSUFFICIENT', `Candle final kurang (${a.count} < ${t.minFinalCandles})`);
  }
  if (a.duplicates > 0) critical('CANDLES_DUPLICATE', `${a.duplicates} candle duplikat/tidak berurutan`);
  if (a.misaligned > 0) critical('CANDLES_MISALIGNED', `${a.misaligned} candle tidak sejajar timeframe`);
  if (a.missingIntervals > 0) critical('CANDLES_GAP', `${a.missingIntervals} interval candle hilang`);
  if (a.invalidOhlc > 0) critical('CANDLES_INVALID_OHLC', `${a.invalidOhlc} candle dengan OHLC tidak valid`);
  if (a.latestOpenTime) {
    const expected = expectedLatestFinalOpenTime(input.timeframe, input.now, t.candleSettleSec);
    if (a.latestOpenTime < expected) {
      critical('CANDLES_STALE', `Candle final terakhir ${a.latestOpenTime.toISOString()}, seharusnya ${expected.toISOString()}`);
    }
  }
  if (a.recentCount > 0 && a.zeroVolumeRecent / a.recentCount > t.maxZeroVolumeRatio) {
    warning(
      'LOW_LIQUIDITY',
      `${a.zeroVolumeRecent} dari ${a.recentCount} candle terakhir tanpa transaksi (volume 0)`,
    );
  }

  // Trades: an empty list means a quiet market, not stale data.
  if (input.trades === null) {
    if (!input.fetchErrors.some((e) => e.source === 'trades')) warning('TRADES_MISSING', 'Data trade tidak tersedia');
  } else if (input.trades.length === 0) {
    warning('TRADES_EMPTY', 'Belum ada trade terbaru');
  }

  // A failed trades fetch is not critical; downgrade it to a warning.
  for (const issue of issues) {
    if (issue.code === 'FETCH_FAILED_TRADES') issue.severity = 'warning';
  }

  const status: QualityStatus = issues.some((i) => i.severity === 'critical')
    ? 'UNAVAILABLE'
    : issues.length > 0
      ? 'DEGRADED'
      : 'OK';
  return { status, issues, checkedAt: input.now };
}
