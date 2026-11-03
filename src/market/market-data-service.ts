import type { Logger } from '../app/logger/logger.js';
import { splitFinalCandles, hasValidOhlc } from './candles.js';
import { MARKET_DATA_DEFAULTS, type MarketDataConfig } from './config.js';
import type { MarketRepository } from './market-repository.js';
import { validateMarketData, type QualityReport } from './market-validator.js';
import { computeOrderBookMetrics, levelsWithinBand, type OrderBookMetrics } from './orderbook-service.js';
import { summarizeTrades, type TradeActivity } from './trade-activity.js';
import { TIMEFRAME_SECONDS, type Candle, type OrderBook, type PairInfo, type Ticker, type Timeframe, type Trade } from './types.js';

export interface MarketClient {
  getTicker(tickerId: string): Promise<Ticker>;
  getOrderBook(tickerId: string): Promise<OrderBook>;
  getTrades(tickerId: string): Promise<Trade[]>;
  getCandles(tickerId: string, timeframe: Timeframe, from: Date, to: Date): Promise<Candle[]>;
}

export interface PairLookup {
  get(tickerId: string): Promise<PairInfo | null>;
}

export interface PairMarketData {
  pair: string;
  pairInfo: PairInfo | null;
  fetchedAt: Date;
  timeframe: Timeframe;
  ticker: Ticker | null;
  orderBook: OrderBook | null;
  metrics: OrderBookMetrics | null;
  tradeActivity: TradeActivity | null;
  /** Final candles only (ascending). The only candles indicators may use. */
  finalCandles: Candle[];
  /** Newest non-final candle: unconfirmed, never stored. */
  pendingCandle: Candle | null;
  quality: QualityReport;
  /** Final candles of the trend timeframe (1H), fetched with Indodax tf=60. */
  trendTimeframe: Timeframe;
  trendCandles: Candle[];
  /** Why trend candles are missing; does not affect `quality`. */
  trendError: string | null;
  /** Id of the stored market snapshot, if one was saved. */
  snapshotId: bigint | null;
}

export interface MarketDataDeps {
  client: MarketClient;
  pairs: PairLookup;
  repository: MarketRepository;
  logger: Logger;
  now?: () => Date;
  config?: Partial<MarketDataConfig>;
}

/**
 * Fetches, normalizes, validates and stores market data for a pair.
 * Data is pulled on demand (no scheduler until Milestone 5) and cached
 * briefly so repeated Telegram commands do not exhaust the rate limit.
 */
export class MarketDataService {
  private readonly config: MarketDataConfig;
  private readonly now: () => Date;
  private readonly cache = new Map<string, { data: PairMarketData; at: number }>();

  constructor(private readonly deps: MarketDataDeps) {
    this.config = { ...MARKET_DATA_DEFAULTS, ...deps.config };
    this.now = deps.now ?? (() => new Date());
  }

  async refreshMany(pairs: string[]): Promise<PairMarketData[]> {
    return Promise.all(pairs.map((p) => this.refresh(p)));
  }

  async refresh(pair: string, options: { force?: boolean } = {}): Promise<PairMarketData> {
    const cached = this.cache.get(pair);
    if (!options.force && cached && this.now().getTime() - cached.at < this.config.cacheTtlMs) {
      return cached.data;
    }
    const data = await this.load(pair);
    this.cache.set(pair, { data, at: this.now().getTime() });
    return data;
  }

  private async load(pair: string): Promise<PairMarketData> {
    const { client, logger } = this.deps;
    const timeframe = this.config.timeframe;
    const fetchErrors: { source: string; message: string }[] = [];
    const attempt = async <T>(source: string, task: () => Promise<T>): Promise<T | null> => {
      try {
        return await task();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fetchErrors.push({ source, message });
        logger.warn({ pair, source, err: message }, 'Gagal mengambil data pasar');
        return null;
      }
    };

    const pairInfo = await attempt('pairs', () => this.deps.pairs.get(pair));
    const tradable = pairInfo !== null && !pairInfo.isMaintenance && !pairInfo.isSuspended;

    // Trend candles are optional: a failure only blanks the 1H indicators.
    const trendTimeframe = this.config.trendTimeframe;
    const syncTrend = async (): Promise<{ final: Candle[]; error: string | null }> => {
      try {
        return { final: (await this.syncCandles(pair, trendTimeframe)).final, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ pair, timeframe: trendTimeframe, err: message }, 'Gagal mengambil candle tren');
        return { final: [], error: message };
      }
    };

    // Skip market requests for unknown or inactive pairs: they can never be analyzed.
    const [ticker, orderBook, trades, candles, trend] = tradable
      ? await Promise.all([
          attempt('ticker', () => client.getTicker(pair)),
          attempt('orderbook', () => client.getOrderBook(pair)),
          attempt('trades', () => client.getTrades(pair)),
          attempt('candles', () => this.syncCandles(pair, timeframe)),
          syncTrend(),
        ])
      : [null, null, null, null, { final: [], error: 'pair tidak aktif' }];

    const now = this.now();
    const metrics = orderBook ? computeOrderBookMetrics(orderBook, this.config.depthBandsPct) : null;
    const tradeActivity = trades ? summarizeTrades(trades, now, this.config.tradeWindowMinutes) : null;
    const finalCandles = candles?.final ?? [];

    const quality = validateMarketData(
      { pair, pairInfo, ticker, orderBook, metrics, finalCandles, timeframe, trades, fetchErrors, now },
      this.config,
    );

    const data: PairMarketData = {
      pair,
      pairInfo,
      fetchedAt: now,
      timeframe,
      ticker,
      orderBook,
      metrics,
      tradeActivity,
      finalCandles,
      pendingCandle: candles?.pending ?? null,
      quality,
      trendTimeframe,
      trendCandles: trend.final,
      trendError: trend.error,
      snapshotId: null,
    };

    if (ticker && orderBook && metrics) {
      data.snapshotId = await this.saveSnapshot(data, ticker, orderBook, metrics).catch((error: unknown) => {
        logger.warn({ pair, err: error instanceof Error ? error.message : error }, 'Gagal menyimpan market snapshot');
        return null;
      });
    }
    return data;
  }

  /**
   * Fetch candles incrementally, store only final ones, then load the stored
   * series. First run backfills ~9 days; later runs re-fetch a small overlap
   * so late corrections overwrite earlier values.
   */
  private async syncCandles(pair: string, timeframe: Timeframe): Promise<{ final: Candle[]; pending: Candle | null }> {
    const { repository, client } = this.deps;
    const stepMs = TIMEFRAME_SECONDS[timeframe] * 1000;
    const now = this.now();
    const backfillFrom = new Date(now.getTime() - this.config.candleBackfillCount * stepMs);
    const latest = await repository.latestCandleOpenTime(pair, timeframe);
    const incrementalFrom = latest ? new Date(latest.getTime() - this.config.candleOverlapCount * stepMs) : null;
    const from = incrementalFrom && incrementalFrom > backfillFrom ? incrementalFrom : backfillFrom;

    const fetched = await client.getCandles(pair, timeframe, from, now);
    const { final, pending } = splitFinalCandles(fetched, now, this.config.candleSettleSec);
    // Invalid candles are not stored; the validator reports any resulting gap.
    await repository.upsertCandles(final.filter(hasValidOhlc));
    return { final: await repository.loadCandles(pair, timeframe, this.config.candleLoadLimit), pending };
  }

  private async saveSnapshot(data: PairMarketData, ticker: Ticker, orderBook: OrderBook, m: OrderBookMetrics): Promise<bigint> {
    const widest = Math.max(...this.config.depthBandsPct);
    const levels = levelsWithinBand(orderBook, m.mid, widest);
    const toPairs = (ls: { price: { toFixed(): string }; volume: { toFixed(): string } }[]) =>
      ls.map((l) => [l.price.toFixed(), l.volume.toFixed()]);
    const a = data.tradeActivity;

    return this.deps.repository.saveSnapshot({
      pair: data.pair,
      fetchedAt: data.fetchedAt,
      serverTime: ticker.serverTime,
      orderBookAgeSec: Math.round((data.fetchedAt.getTime() - orderBook.fetchedAt.getTime()) / 1000) + (orderBook.cacheAgeSec ?? 0),
      lastPrice: ticker.last,
      bestBid: m.bestBid,
      bestAsk: m.bestAsk,
      spreadIdr: m.spreadIdr,
      spreadPct: m.spreadPct,
      high24h: ticker.high24h,
      low24h: ticker.low24h,
      volumeBase24h: ticker.volumeBase24h,
      volumeIdr24h: ticker.volumeIdr24h,
      orderBookData: {
        fetchedAt: orderBook.fetchedAt.toISOString(),
        cacheAgeSec: orderBook.cacheAgeSec,
        mid: m.mid.toFixed(),
        bidLevels: m.bidLevels,
        askLevels: m.askLevels,
        bands: m.bands.map((b) => ({
          pct: b.pct,
          bidVolumeBase: b.bidVolumeBase.toFixed(),
          askVolumeBase: b.askVolumeBase.toFixed(),
          bidValueIdr: b.bidValueIdr.toFixed(),
          askValueIdr: b.askValueIdr.toFixed(),
          imbalance: b.imbalance?.toDecimalPlaces(6).toFixed() ?? null,
          truncated: b.truncated,
        })),
        levelsWithinPct: widest,
        bids: toPairs(levels.bids),
        asks: toPairs(levels.asks),
      },
      tradeActivity: a
        ? {
            windowMinutes: a.windowMinutes,
            count: a.count,
            buyCount: a.buyCount,
            sellCount: a.sellCount,
            buyVolumeBase: a.buyVolumeBase.toFixed(),
            sellVolumeBase: a.sellVolumeBase.toFixed(),
            buyValueIdr: a.buyValueIdr.toFixed(),
            sellValueIdr: a.sellValueIdr.toFixed(),
            buyRatio: a.buyRatio?.toDecimalPlaces(6).toFixed() ?? null,
            newestTradeAt: a.newestTradeAt?.toISOString() ?? null,
            newestTradeId: a.newestTradeId,
          }
        : null,
      qualityStatus: data.quality.status,
      qualityIssues: data.quality.issues,
    });
  }
}
