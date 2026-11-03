import type { Dec } from '../app/decimal.js';

/** Intraday Indodax OHLC timeframes (documented `tf` values), in minutes. */
export type Timeframe = '1' | '15' | '30' | '60' | '240';

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1': 60,
  '15': 900,
  '30': 1800,
  '60': 3600,
  '240': 14400,
};

export function isTimeframe(value: string): value is Timeframe {
  return value in TIMEFRAME_SECONDS;
}

/** When and how fresh a response was. Cloudflare may serve cached data. */
export interface FetchMeta {
  fetchedAt: Date;
  /** `Age` response header: seconds the response sat in Cloudflare's cache. */
  cacheAgeSec: number | null;
}

export interface PairInfo {
  tickerId: string;
  pathId: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  description: string;
  /** Minimum price step (Indodax `price_precision`, despite its name). */
  tickSize: Dec | null;
  quantityIncrement: Dec | null;
  minOrderIdr: Dec | null;
  minOrderBase: Dec | null;
  takerFeePct: Dec | null;
  makerFeePct: Dec | null;
  isMaintenance: boolean;
  isSuspended: boolean;
}

export interface Ticker extends FetchMeta {
  pair: string;
  last: Dec;
  bid: Dec;
  ask: Dec;
  high24h: Dec;
  low24h: Dec;
  volumeBase24h: Dec | null;
  volumeIdr24h: Dec;
  serverTime: Date;
}

export interface OrderBookLevel {
  price: Dec;
  volume: Dec;
}

export interface OrderBook extends FetchMeta {
  pair: string;
  /** Highest price first. */
  bids: OrderBookLevel[];
  /** Lowest price first. */
  asks: OrderBookLevel[];
}

export interface Trade {
  /** Kept as a string: Indodax trade ids exceed Number.MAX_SAFE_INTEGER. */
  tid: string;
  time: Date;
  price: Dec;
  amount: Dec;
  side: 'buy' | 'sell';
}

export interface Candle {
  pair: string;
  timeframe: Timeframe;
  openTime: Date;
  open: Dec;
  high: Dec;
  low: Dec;
  close: Dec;
  /** In base-asset units (verified against trade amounts). */
  volume: Dec;
}
