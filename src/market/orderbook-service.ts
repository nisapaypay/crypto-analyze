import { Dec, sum, ZERO } from '../app/decimal.js';
import type { OrderBook, OrderBookLevel } from './types.js';

export interface DepthBand {
  /** Band half-width around the mid price, in percent (1 = ±1%). */
  pct: number;
  bidVolumeBase: Dec;
  askVolumeBase: Dec;
  bidValueIdr: Dec;
  askValueIdr: Dec;
  /**
   * (bid value − ask value) / (bid value + ask value), in IDR terms.
   * +1 = only buyers inside the band, −1 = only sellers. Null if the band is empty.
   */
  imbalance: Dec | null;
  /** True if the fetched book ends inside the band, so depth is understated. */
  truncated: boolean;
}

export interface OrderBookMetrics {
  bestBid: Dec;
  bestAsk: Dec;
  mid: Dec;
  spreadIdr: Dec;
  /** Spread relative to the mid price, in percent. */
  spreadPct: Dec;
  crossed: boolean;
  bidLevels: number;
  askLevels: number;
  bands: DepthBand[];
}

/** Returns null when either side of the book is empty. */
export function computeOrderBookMetrics(book: OrderBook, bandsPct: readonly number[]): OrderBookMetrics | null {
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (!bestBid || !bestAsk) return null;

  const mid = bestBid.plus(bestAsk).div(2);
  const spreadIdr = bestAsk.minus(bestBid);

  return {
    bestBid,
    bestAsk,
    mid,
    spreadIdr,
    spreadPct: spreadIdr.div(mid).times(100),
    crossed: bestBid.gte(bestAsk),
    bidLevels: book.bids.length,
    askLevels: book.asks.length,
    bands: bandsPct.map((pct) => depthBand(book, mid, pct)),
  };
}

function depthBand(book: OrderBook, mid: Dec, pct: number): DepthBand {
  const factor = new Dec(pct).div(100);
  const minBid = mid.times(Dec.sub(1, factor));
  const maxAsk = mid.times(Dec.add(1, factor));
  const bids = book.bids.filter((l) => l.price.gte(minBid));
  const asks = book.asks.filter((l) => l.price.lte(maxAsk));

  const value = (levels: OrderBookLevel[]) => sum(levels.map((l) => l.price.times(l.volume)));
  const bidValueIdr = value(bids);
  const askValueIdr = value(asks);
  const total = bidValueIdr.plus(askValueIdr);

  return {
    pct,
    bidVolumeBase: sum(bids.map((l) => l.volume)),
    askVolumeBase: sum(asks.map((l) => l.volume)),
    bidValueIdr,
    askValueIdr,
    imbalance: total.gt(ZERO) ? bidValueIdr.minus(askValueIdr).div(total) : null,
    truncated:
      (book.bids.length > 0 && bids.length === book.bids.length) ||
      (book.asks.length > 0 && asks.length === book.asks.length),
  };
}

/** Book levels within the widest band, for compact snapshot storage. */
export function levelsWithinBand(book: OrderBook, mid: Dec, pct: number): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } {
  const factor = new Dec(pct).div(100);
  return {
    bids: book.bids.filter((l) => l.price.gte(mid.times(Dec.sub(1, factor)))),
    asks: book.asks.filter((l) => l.price.lte(mid.times(Dec.add(1, factor)))),
  };
}
