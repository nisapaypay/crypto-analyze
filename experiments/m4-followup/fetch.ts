/**
 * Eksperimen lanjutan M4 — unduh candle final 15m, 1j, dan 4j (Indodax Public
 * API, GET saja) ke experiments/m4-followup/data/. Tidak menyentuh database
 * maupun data/backtest/ milik backtest produksi.
 *
 *   pnpm exec tsx experiments/m4-followup/fetch.ts
 *
 * 15m dan 1j: 365 + 20 hari (sama dengan `pnpm backtest:fetch`), sehingga
 * pembagian periode (bulan 1–12) identik dengan backtest produksi.
 * 4j: 365 + 80 hari, karena jendela 300 candle 4j butuh ±50 hari pemanasan.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_WATCHLIST } from '../../src/app/config/defaults.js';
import { hashCandles, saveSeries, toRows } from '../../src/backtest/dataset.js';
import { fetchHistory } from '../../src/backtest/history-fetcher.js';
import { INDODAX_CLIENT_DEFAULTS, IndodaxPublicRest } from '../../src/exchange/indodax/public-rest.js';
import { RateLimiter } from '../../src/exchange/indodax/rate-limiter.js';
import { isFinalCandle } from '../../src/market/candles.js';
import { MARKET_DATA_DEFAULTS } from '../../src/market/config.js';
import { computeOrderBookMetrics } from '../../src/market/orderbook-service.js';
import { PairRegistry } from '../../src/market/pair-registry.js';
import type { Timeframe } from '../../src/market/types.js';
import { EXPERIMENT_DATA_DIR } from './lib/series.js';

const DAYS: Record<'15' | '60' | '240', number> = { '15': 385, '60': 385, '240': 445 };

const limiter = new RateLimiter({
  maxRequests: INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute,
  windowMs: 60_000,
  maxConcurrent: INDODAX_CLIENT_DEFAULTS.maxConcurrent,
});
const client = new IndodaxPublicRest(process.env.INDODAX_PUBLIC_BASE_URL || 'https://indodax.com', { limiter });
const registry = new PairRegistry(client);
const now = new Date();
const fees: Record<string, { takerFeePct: string | null; makerFeePct: string | null; fetchedAt: string }> = {};

for (const input of DEFAULT_WATCHLIST) {
  const resolved = await registry.resolve(input);
  if (resolved.status !== 'ok') throw new Error(`Pair ${input}: ${resolved.status}`);
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
  fees[info.tickerId] = { takerFeePct: info.takerFeePct?.toFixed() ?? null, makerFeePct: info.makerFeePct?.toFixed() ?? null, fetchedAt: now.toISOString() };

  for (const tf of ['15', '60', '240'] as Timeframe[]) {
    const from = new Date(now.getTime() - DAYS[tf as '15' | '60' | '240'] * 86_400_000);
    const { candles, gaps } = await fetchHistory(client, info.tickerId, tf, from, now);
    const final = candles.filter((c) => isFinalCandle(c, now, MARKET_DATA_DEFAULTS.candleSettleSec));
    const rows = toRows(final);
    saveSeries(
      {
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
      },
      EXPERIMENT_DATA_DIR,
    );
    const zero = final.filter((c) => c.volume.isZero()).length;
    console.log(
      `${info.tickerId} ${tf}m: ${rows.length} candle (${final[0]?.openTime.toISOString().slice(0, 16)} → ${final.at(-1)?.openTime.toISOString().slice(0, 16)}), ` +
        `gap ${gaps}, volume 0: ${((zero / Math.max(rows.length, 1)) * 100).toFixed(1)}%`,
    );
  }
  console.log(`  spread sampel ${meta.spreadPctSample}% · tick ${meta.tickSize} · fee taker ${fees[info.tickerId]!.takerFeePct}% maker ${fees[info.tickerId]!.makerFeePct}% (dari /api/pairs)`);
}
writeFileSync(join(EXPERIMENT_DATA_DIR, 'pair-fees.json'), JSON.stringify(fees, null, 2));
console.log(`Selesai: ${limiter.requestCount} request.`);
