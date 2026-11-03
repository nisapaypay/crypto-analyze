import type { PairMarketData } from '../market/market-data-service.js';
import type { MarketContext } from './types.js';

/** Live market context from Milestone 2 data; null without a usable order book. */
export function marketContextFrom(data: PairMarketData, depthBandPct: number): MarketContext | null {
  const m = data.metrics;
  if (!m || !data.orderBook) return null;
  const band = m.bands.find((b) => b.pct === depthBandPct) ?? null;
  return {
    bestBid: m.bestBid,
    bestAsk: m.bestAsk,
    spread: m.spreadIdr,
    spreadPct: m.spreadPct,
    imbalance1: band?.imbalance ?? null,
    tradeBuyRatio: data.tradeActivity?.buyRatio ?? null,
    askDepthBase1: band ? band.askVolumeBase : null,
    bids: data.orderBook.bids,
    volumeIdr24h: data.ticker?.volumeIdr24h ?? null,
  };
}
