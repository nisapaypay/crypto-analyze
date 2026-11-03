/**
 * Live verification against the real Indodax Public API (no API key).
 *
 *   pnpm market:check                 # default watchlist, stores data in DATABASE_URL
 *   pnpm market:check sol btc         # specific pairs
 *   pnpm market:check --no-save       # fetch and validate only, no database writes
 *
 * Exit code 1 if any pair is UNAVAILABLE.
 */
import 'dotenv/config';
import { DEFAULT_WATCHLIST } from '../src/app/config/defaults.js';
import { createPrismaClient } from '../src/app/database/prisma.js';
import { createLogger } from '../src/app/logger/logger.js';
import { formatIdr, formatPair, formatPercent, formatSignedRatio } from '../src/bot/messages/format.js';
import { INDODAX_CLIENT_DEFAULTS, IndodaxPublicRest } from '../src/exchange/indodax/public-rest.js';
import { RateLimiter } from '../src/exchange/indodax/rate-limiter.js';
import { isZeroVolume } from '../src/market/candles.js';
import { MARKET_DATA_DEFAULTS } from '../src/market/config.js';
import { MarketDataService, type PairMarketData } from '../src/market/market-data-service.js';
import { InMemoryMarketRepository, PrismaMarketRepository } from '../src/market/market-repository.js';
import { canProduceBuySignal } from '../src/market/market-validator.js';
import { PairRegistry } from '../src/market/pair-registry.js';

const args = process.argv.slice(2);
const save = !args.includes('--no-save');
const requested = args.filter((a) => !a.startsWith('--'));

const logger = createLogger({ level: 'warn', pretty: true });
const limiter = new RateLimiter({
  maxRequests: INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute,
  windowMs: 60_000,
  maxConcurrent: INDODAX_CLIENT_DEFAULTS.maxConcurrent,
});
const client = new IndodaxPublicRest(process.env.INDODAX_PUBLIC_BASE_URL || 'https://indodax.com', { limiter });
const registry = new PairRegistry(client);

const databaseUrl = process.env.DATABASE_URL;
if (save && !databaseUrl) {
  console.error('DATABASE_URL belum diisi. Isi .env atau jalankan dengan --no-save.');
  process.exit(1);
}
const prisma = save ? createPrismaClient(databaseUrl!) : null;
const repository = prisma ? new PrismaMarketRepository(prisma) : new InMemoryMarketRepository();
const service = new MarketDataService({ client, pairs: registry, repository, logger });

const wib = (d: Date) =>
  new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'medium' }).format(d) + ' WIB';

function report(d: PairMarketData): void {
  const { ticker, metrics, tradeActivity: a, quality } = d;
  const last20 = d.finalCandles.slice(-MARKET_DATA_DEFAULTS.liquidityLookback);
  console.log(`\n━━ ${formatPair(d.pair)} — ${quality.status}  (boleh BUY: ${canProduceBuySignal(quality) ? 'ya' : 'TIDAK'})`);
  if (d.pairInfo) {
    console.log(`  Pair        : aktif=${!d.pairInfo.isMaintenance && !d.pairInfo.isSuspended}  tick=${d.pairInfo.tickSize?.toFixed()}  min order=${formatIdr(d.pairInfo.minOrderIdr ?? { toFixed: () => '0' })}`);
  }
  if (ticker) {
    const age = Math.round((d.fetchedAt.getTime() - ticker.serverTime.getTime()) / 1000);
    console.log(`  Ticker      : last ${formatIdr(ticker.last)} · bid ${formatIdr(ticker.bid)} · ask ${formatIdr(ticker.ask)}`);
    console.log(`                24j high ${formatIdr(ticker.high24h)} · low ${formatIdr(ticker.low24h)} · vol ${ticker.volumeBase24h?.toFixed() ?? '-'} ${d.pairInfo?.baseAsset.toUpperCase() ?? ''} / ${formatIdr(ticker.volumeIdr24h)}`);
    console.log(`                server_time ${wib(ticker.serverTime)} (umur ${age} dtk, Cloudflare age ${ticker.cacheAgeSec ?? '-'} dtk)`);
  }
  if (metrics && d.orderBook) {
    console.log(`  Order book  : ${metrics.bidLevels} bid / ${metrics.askLevels} ask level · best ${formatIdr(metrics.bestBid)} / ${formatIdr(metrics.bestAsk)} · Cloudflare age ${d.orderBook.cacheAgeSec ?? '-'} dtk`);
    console.log(`                spread ${formatIdr(metrics.spreadIdr)} (${formatPercent(metrics.spreadPct, 4)})`);
    for (const b of metrics.bands) {
      console.log(
        `                ±${b.pct}%: bid ${formatIdr(b.bidValueIdr.toDecimalPlaces(0))} vs ask ${formatIdr(b.askValueIdr.toDecimalPlaces(0))} → imbalance ${b.imbalance ? formatSignedRatio(b.imbalance, 2) : '-'}${b.truncated ? ' (terpotong)' : ''}`,
      );
    }
  }
  const first = d.finalCandles[0];
  const latest = d.finalCandles.at(-1);
  if (first && latest) {
    console.log(`  Candle ${d.timeframe}m : ${d.finalCandles.length} final (${wib(first.openTime)} → ${wib(latest.openTime)})`);
    console.log(`                volume 0 di ${last20.filter(isZeroVolume).length}/${last20.length} candle terakhir · candle berjalan: ${d.pendingCandle ? `${wib(d.pendingCandle.openTime)} (tidak disimpan)` : '-'}`);
  }
  if (a) {
    console.log(
      `  Trades ${a.windowMinutes}m : ${a.count} trade (${a.buyCount} buy / ${a.sellCount} sell) · buy ratio ${a.buyRatio ? formatPercent(a.buyRatio.times(100), 1) : '-'} · terbaru ${a.newestTradeAgeSec ?? '-'} dtk lalu (tid ${a.newestTradeId ?? '-'})`,
    );
  }
  for (const issue of quality.issues) console.log(`  ${issue.severity === 'critical' ? '✖' : '!'} ${issue.code}: ${issue.message}`);
}

try {
  const pairs: string[] = [];
  for (const input of requested.length > 0 ? requested : [...DEFAULT_WATCHLIST]) {
    const r = await registry.resolve(input);
    if (r.status === 'ok') pairs.push(r.pair.tickerId);
    else console.log(`Lewati "${input}": ${r.status}`);
  }

  console.log(`Indodax Public API · ${pairs.length} pair · simpan ke DB: ${save ? 'ya' : 'tidak'} · ${wib(new Date())}`);
  const started = Date.now();
  const results = await service.refreshMany(pairs);
  results.forEach(report);

  const count = (s: string) => results.filter((r) => r.quality.status === s).length;
  console.log(
    `\nRingkasan: OK ${count('OK')} · DEGRADED ${count('DEGRADED')} · UNAVAILABLE ${count('UNAVAILABLE')} · ${limiter.requestCount} request dalam ${((Date.now() - started) / 1000).toFixed(1)} dtk (limit ${INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute}/menit)`,
  );
  process.exitCode = count('UNAVAILABLE') > 0 ? 1 : 0;
} finally {
  await prisma?.$disconnect();
}
