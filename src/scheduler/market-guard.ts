import type { PairMarketData } from '../market/market-data-service.js';
import type { Ticker } from '../market/types.js';
import type { ClockGuard, TimeSample } from './clock-guard.js';

export interface MarketSource {
  refresh(pair: string, options?: { force?: boolean }): Promise<PairMarketData>;
}

export interface GuardedMarket {
  refresh(pair: string, options?: { force?: boolean }): Promise<PairMarketData>;
  refreshMany(pairs: string[]): Promise<PairMarketData[]>;
}

const sampleOf = (t: Ticker): TimeSample => ({ fetchedAt: t.fetchedAt, serverTime: t.serverTime, cacheAgeSec: t.cacheAgeSec });

/**
 * Facade over the (unchanged) M2 MarketDataService for every consumer: Telegram
 * commands, analysis, strategy, scheduler and monitor. While the clock is not
 * VALID it refuses to fetch, so no candle can be judged "final" — and no
 * decision made — against a wrong clock. Every ticker it sees is also a free
 * clock sample (no extra request).
 */
export function guardMarket(market: MarketSource, clock: ClockGuard): GuardedMarket {
  const refresh = async (pair: string, options?: { force?: boolean }) => {
    clock.assertValid();
    const data = await market.refresh(pair, options);
    if (data.ticker) clock.observe(sampleOf(data.ticker));
    return data;
  };
  return {
    refresh,
    refreshMany: (pairs) => Promise.all(pairs.map((p) => refresh(p))),
  };
}

export interface TickerSource {
  getTicker(tickerId: string): Promise<Ticker>;
}

/**
 * Preflight before every slot: ONE ticker request on a client without retries.
 * It proves Indodax is reachable and yields a clock sample (server_time +
 * Cloudflare Age). A failure means the slot is recorded FAILED without fanning
 * out ~20 requests × 4 attempts.
 */
export async function preflight(client: TickerSource, pair: string): Promise<TimeSample> {
  return sampleOf(await client.getTicker(pair));
}
