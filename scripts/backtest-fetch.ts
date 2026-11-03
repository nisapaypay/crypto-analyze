/**
 * Download historical final candles (15m and 1H, Indodax Public API, GET only)
 * for backtesting. Files go to data/backtest/ (git-ignored); the database is
 * not touched.
 *
 *   pnpm backtest:fetch                 # default watchlist, 12 months + 20 days warm-up
 *   pnpm backtest:fetch qnt doge --days 200
 */
import 'dotenv/config';
import { DEFAULT_WATCHLIST } from '../src/app/config/defaults.js';
import { hashCandles, saveSeries, toRows } from '../src/backtest/dataset.js';
import { fetchHistory } from '../src/backtest/history-fetcher.js';
import { INDODAX_CLIENT_DEFAULTS, IndodaxPublicRest } from '../src/exchange/indodax/public-rest.js';
import { RateLimiter } from '../src/exchange/indodax/rate-limiter.js';
import { isFinalCandle } from '../src/market/candles.js';
import { MARKET_DATA_DEFAULTS } from '../src/market/config.js';
import { computeOrderBookMetrics } from '../src/market/orderbook-service.js';
import { PairRegistry } from '../src/market/pair-registry.js';
import type { Timeframe } from '../src/market/types.js';

const args = process.argv.slice(2);
const daysIndex = args.indexOf('--days');
const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 365 + 20;
const requested = args.filter((a, i) => !a.startsWith('--') && i !== daysIndex + 1);

const limiter = new RateLimiter({
  maxRequests: INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute,
  windowMs: 60_000,
  maxConcurrent: INDODAX_CLIENT_DEFAULTS.maxConcurrent,
});
const client = new IndodaxPublicRest(process.env.INDODAX_PUBLIC_BASE_URL || 'https://indodax.com', { limiter });
const registry = new PairRegistry(client);

const now = new Date();
const from = new Date(now.getTime() - days * 86_400_000);
const started = Date.now();

for (const input of requested.length ? requested : [...DEFAULT_WATCHLIST]) {
  const resolved = await registry.resolve(input);
  if (resolved.status !== 'ok') {
    console.log(`Lewati "${input}": ${resolved.status}`);
    continue;
  }
  const info = resolved.pair;
  const book = await client.getOrderBook(info.tickerId);
  const metrics = computeOrderBookMetrics(book, [1]);
  const meta = {
    pair: info.tickerId,
    tickSize: info.tickSize?.toFixed() ?? null,
    quantityIncrement: info.quantityIncrement?.toFixed() ?? null,
    minOrderIdr: info.minOrderIdr?.toFixed() ?? null,
    minOrderBase: info.minOrderBase?.toFixed() ?? null,
    spreadPctSample: metrics?.spreadPct.toFixed(6) ?? null,
  };

  for (const tf of ['15', '60'] as Timeframe[]) {
    const { candles, gaps } = await fetchHistory(client, info.tickerId, tf, from, now);
    const final = candles.filter((c) => isFinalCandle(c, now, MARKET_DATA_DEFAULTS.candleSettleSec));
    const rows = toRows(final);
    const path = saveSeries({
      pair: info.tickerId,
      timeframe: tf,
      fetchedAt: now.toISOString(),
      from: final[0]?.openTime.toISOString() ?? from.toISOString(),
      to: final.at(-1)?.openTime.toISOString() ?? now.toISOString(),
      count: rows.length,
      gaps,
      sha256: hashCandles(rows),
      meta,
      candles: rows,
    });
    const zero = final.filter((c) => c.volume.isZero()).length;
    console.log(
      `${info.tickerId} ${tf}m: ${rows.length} candle final (${final[0]?.openTime.toISOString().slice(0, 10)} → ${final.at(-1)?.openTime.toISOString().slice(0, 16)}), ` +
        `gap ${gaps}, volume 0: ${((zero / Math.max(rows.length, 1)) * 100).toFixed(1)}% → ${path}`,
    );
  }
  console.log(`  spread sampel saat ini: ${meta.spreadPctSample}% · tick ${meta.tickSize} · min order Rp${meta.minOrderIdr}`);
}
console.log(`Selesai: ${limiter.requestCount} request dalam ${((Date.now() - started) / 1000).toFixed(0)} dtk.`);
