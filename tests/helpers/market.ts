import { Dec } from '../../src/app/decimal.js';
import type { MarketClient } from '../../src/market/market-data-service.js';
import type { Candle, OrderBook, PairInfo, Ticker, Timeframe, Trade } from '../../src/market/types.js';

export const NOW = new Date('2026-11-02T09:20:00Z');
const STEP_MS: Record<Timeframe, number> = { '1': 60_000, '15': 900_000, '30': 1_800_000, '60': 3_600_000, '240': 14_400_000 };

export function makePair(overrides: Partial<PairInfo> = {}): PairInfo {
  return {
    tickerId: 'qnt_idr',
    pathId: 'qntidr',
    symbol: 'QNTIDR',
    baseAsset: 'qnt',
    quoteAsset: 'idr',
    description: 'QNT/IDR',
    tickSize: new Dec(1),
    quantityIncrement: new Dec('0.00000001'),
    minOrderIdr: new Dec(10000),
    minOrderBase: new Dec('0.0027'),
    takerFeePct: new Dec('0.2'),
    makerFeePct: new Dec('0.1'),
    isMaintenance: false,
    isSuspended: false,
    ...overrides,
  };
}

export function makeTicker(overrides: Partial<Ticker> = {}): Ticker {
  return {
    pair: 'qnt_idr',
    last: new Dec(3585298),
    bid: new Dec(3585000),
    ask: new Dec(3596000),
    high24h: new Dec(3700000),
    low24h: new Dec(3564247),
    volumeBase24h: new Dec('173.2829528'),
    volumeIdr24h: new Dec(626978777),
    serverTime: new Date(NOW.getTime() - 5_000),
    fetchedAt: NOW,
    cacheAgeSec: 5,
    ...overrides,
  };
}

export function makeBook(
  bids: [number | string, number | string][],
  asks: [number | string, number | string][],
  overrides: Partial<OrderBook> = {},
): OrderBook {
  const level = ([p, v]: [number | string, number | string]) => ({ price: new Dec(p), volume: new Dec(v) });
  return { pair: 'qnt_idr', bids: bids.map(level), asks: asks.map(level), fetchedAt: NOW, cacheAgeSec: 0, ...overrides };
}

export function makeTrade(secondsAgo: number, side: 'buy' | 'sell', price: number, amount: string, tid = '144115188260077791'): Trade {
  return { tid, time: new Date(NOW.getTime() - secondsAgo * 1000), price: new Dec(price), amount: new Dec(amount), side };
}

/**
 * `count` consecutive candles (15m by default) ending with the one opening at
 * `lastOpen`. `zeroVolume` marks candle indexes (from the end, 0 = last) as no-trade.
 */
export function makeCandles(
  count: number,
  lastOpen: Date,
  options: { pair?: string; timeframe?: Timeframe; zeroVolumeFromEnd?: number[] } = {},
): Candle[] {
  const zero = new Set(options.zeroVolumeFromEnd ?? []);
  const step = STEP_MS[options.timeframe ?? '15'];
  return Array.from({ length: count }, (_, i) => {
    const fromEnd = count - 1 - i;
    const price = new Dec(3_500_000 + i * 100);
    return {
      pair: options.pair ?? 'qnt_idr',
      timeframe: options.timeframe ?? '15',
      openTime: new Date(lastOpen.getTime() - fromEnd * step),
      open: price,
      high: price.plus(500),
      low: price.minus(500),
      close: price.plus(100),
      volume: zero.has(fromEnd) ? new Dec(0) : new Dec('0.5'),
    };
  });
}

/** Open time of the latest 15m candle that is final at NOW with a 90 s settle. */
export const LATEST_FINAL_OPEN = new Date('2026-11-02T09:00:00Z');

export function healthyBook(): OrderBook {
  return makeBook(
    [[3585000, '2'], [3570000, '1'], [3530000, '3'], [3000000, '10']],
    [[3596000, '1.5'], [3610000, '1'], [3650000, '2'], [5000000, '10']],
  );
}

export class FakeMarketClient implements MarketClient {
  calls = { ticker: 0, orderBook: 0, trades: 0, candles: 0 };
  candleRequests: { timeframe: Timeframe; from: Date; to: Date }[] = [];
  ticker: Ticker | Error = makeTicker();
  book: OrderBook | Error = healthyBook();
  trades: Trade[] | Error = [makeTrade(60, 'buy', 3590000, '0.1'), makeTrade(120, 'sell', 3585000, '0.2')];
  /** 15m candles served by getCandles (filtered to the requested range). */
  candles: Candle[] = makeCandles(860, new Date('2026-11-02T09:15:00Z'));
  /** 1H candles; 09:00 is still forming at NOW, 08:00 is the latest final one. */
  candles1h: Candle[] | Error = makeCandles(400, new Date('2026-11-02T09:00:00Z'), { timeframe: '60' });

  async getTicker(): Promise<Ticker> {
    this.calls.ticker++;
    if (this.ticker instanceof Error) throw this.ticker;
    return this.ticker;
  }
  async getOrderBook(): Promise<OrderBook> {
    this.calls.orderBook++;
    if (this.book instanceof Error) throw this.book;
    return this.book;
  }
  async getTrades(): Promise<Trade[]> {
    this.calls.trades++;
    if (this.trades instanceof Error) throw this.trades;
    return this.trades;
  }
  async getCandles(_pair: string, timeframe: Timeframe, from: Date, to: Date): Promise<Candle[]> {
    this.calls.candles++;
    this.candleRequests.push({ timeframe, from, to });
    const source = timeframe === '60' ? this.candles1h : this.candles;
    if (source instanceof Error) throw source;
    return source.filter((c) => c.openTime >= from && c.openTime <= to);
  }
}
