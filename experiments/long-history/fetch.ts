/**
 * Download the ≈3-year DEVELOPMENT dataset (15m, 1H, 4H final candles; Indodax
 * Public API, GET only). Requests stop at HOLDOUT_START: holdout candles are
 * never downloaded or stored. Nothing is filled in — gaps stay gaps and are
 * reported. No database, no data/backtest/.
 *
 *   pnpm exec tsx experiments/long-history/fetch.ts
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashCandles, saveSeries, toRows } from '../../src/backtest/dataset.js';
import { CHUNK_CANDLES } from '../../src/backtest/history-fetcher.js';
import { INDODAX_CLIENT_DEFAULTS, IndodaxPublicRest } from '../../src/exchange/indodax/public-rest.js';
import { RateLimiter } from '../../src/exchange/indodax/rate-limiter.js';
import { hasValidOhlc, isFinalCandle } from '../../src/market/candles.js';
import { MARKET_DATA_DEFAULTS } from '../../src/market/config.js';
import { computeOrderBookMetrics } from '../../src/market/orderbook-service.js';
import { PairRegistry } from '../../src/market/pair-registry.js';
import { TIMEFRAME_SECONDS, type Candle, type Timeframe } from '../../src/market/types.js';
import { ALL_PAIRS, FETCH_FROM, HOLDOUT_START, LONG_DATA_DIR } from './config.js';

const limiter = new RateLimiter({ maxRequests: INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute, windowMs: 60_000, maxConcurrent: INDODAX_CLIENT_DEFAULTS.maxConcurrent });
const client = new IndodaxPublicRest(process.env.INDODAX_PUBLIC_BASE_URL || 'https://indodax.com', { limiter });
const registry = new PairRegistry(client);
const now = new Date();
mkdirSync(LONG_DATA_DIR, { recursive: true });

interface Quality {
  pair: string;
  timeframe: Timeframe;
  firstOpen: string | null;
  lastOpen: string | null;
  count: number;
  expected: number;
  duplicatesReturned: number;
  misaligned: number;
  invalidOhlc: number;
  missingIntervals: number;
  gaps: { after: string; missing: number }[];
  zeroVolumePct: number;
  longestZeroRun: number;
  /** Candles the API returned at/after the boundary: dropped in memory, never stored. */
  droppedAtBoundary: number;
  sha256: string;
}

const manifest: { createdAt: string; holdoutStart: string; fetchFrom: string; pairs: Record<string, unknown>; quality: Quality[] } = {
  createdAt: now.toISOString(),
  holdoutStart: HOLDOUT_START.toISOString(),
  fetchFrom: FETCH_FROM.toISOString(),
  pairs: {},
  quality: [],
};

for (const input of ALL_PAIRS) {
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
  manifest.pairs[info.tickerId] = {
    ...meta,
    spreadSampledAt: now.toISOString(),
    takerFeePct: info.takerFeePct?.toFixed() ?? null,
    makerFeePct: info.makerFeePct?.toFixed() ?? null,
  };

  for (const tf of ['15', '60', '240'] as Timeframe[]) {
    const step = TIMEFRAME_SECONDS[tf] * 1000;
    const chunk = (CHUNK_CANDLES[tf] ?? 500) * step;
    const lastOpenAllowed = HOLDOUT_START.getTime() - step; // last candle that closes at the boundary
    const byTime = new Map<number, Candle>();
    let duplicatesReturned = 0;
    let dropped = 0;
    for (let start = FETCH_FROM.getTime(); start <= lastOpenAllowed; start += chunk) {
      const end = Math.min(start + chunk - step, lastOpenAllowed);
      for (const c of await client.getCandles(info.tickerId, tf, new Date(start), new Date(end))) {
        const t = c.openTime.getTime();
        if (t + step > HOLDOUT_START.getTime() || !isFinalCandle(c, now, MARKET_DATA_DEFAULTS.candleSettleSec)) {
          dropped++;
          continue;
        }
        if (byTime.has(t)) duplicatesReturned++;
        byTime.set(t, c);
      }
    }
    const candles = [...byTime.values()].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
    const gaps: Quality['gaps'] = [];
    let missing = 0;
    for (let i = 1; i < candles.length; i++) {
      const m = Math.round((candles[i]!.openTime.getTime() - candles[i - 1]!.openTime.getTime()) / step) - 1;
      if (m > 0) {
        missing += m;
        gaps.push({ after: candles[i - 1]!.openTime.toISOString(), missing: m });
      }
    }
    let run = 0;
    let longest = 0;
    for (const c of candles) {
      run = c.volume.isZero() ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    const rows = toRows(candles);
    const sha256 = hashCandles(rows);
    saveSeries(
      { pair: info.tickerId, timeframe: tf, fetchedAt: now.toISOString(), from: candles[0]?.openTime.toISOString() ?? '', to: candles.at(-1)?.openTime.toISOString() ?? '', count: rows.length, gaps: missing, sha256, meta, candles: rows },
      LONG_DATA_DIR,
    );
    const q: Quality = {
      pair: info.tickerId,
      timeframe: tf,
      firstOpen: candles[0]?.openTime.toISOString() ?? null,
      lastOpen: candles.at(-1)?.openTime.toISOString() ?? null,
      count: candles.length,
      expected: candles.length ? Math.round((candles.at(-1)!.openTime.getTime() - candles[0]!.openTime.getTime()) / step) + 1 : 0,
      duplicatesReturned,
      misaligned: candles.filter((c) => c.openTime.getTime() % step !== 0).length,
      invalidOhlc: candles.filter((c) => !hasValidOhlc(c)).length,
      missingIntervals: missing,
      gaps,
      zeroVolumePct: candles.length ? Math.round((candles.filter((c) => c.volume.isZero()).length / candles.length) * 1000) / 10 : 0,
      longestZeroRun: longest,
      droppedAtBoundary: dropped,
      sha256,
    };
    manifest.quality.push(q);
    console.log(
      `${q.pair} ${tf}m: ${q.count}/${q.expected} candle (${q.firstOpen?.slice(0, 16)} → ${q.lastOpen?.slice(0, 16)}), gap ${q.missingIntervals} (${gaps.length} lubang), duplikat ${duplicatesReturned}, ` +
        `tidak sejajar ${q.misaligned}, OHLC invalid ${q.invalidOhlc}, volume 0 ${q.zeroVolumePct}% (rentetan terpanjang ${longest}), dibuang di batas ${dropped}`,
    );
  }
}
writeFileSync(join(LONG_DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Selesai: ${limiter.requestCount} request. Manifest: ${join(LONG_DATA_DIR, 'manifest.json')}`);
