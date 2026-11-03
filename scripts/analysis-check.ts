/**
 * Live verification of the technical analysis engine against the real
 * Indodax Public API (no API key). Prints exactly what /analyze shows.
 *
 *   pnpm analysis:check               # default watchlist, stores results in DATABASE_URL
 *   pnpm analysis:check sol           # specific pairs
 *   pnpm analysis:check --no-save     # no database writes
 *
 * Exit code 1 if any pair is UNAVAILABLE.
 */
import 'dotenv/config';
import { InMemoryIndicatorRepository, PrismaIndicatorRepository } from '../src/analysis/indicator-repository.js';
import { TechnicalAnalysisService } from '../src/analysis/technical-analysis-service.js';
import { DEFAULT_WATCHLIST } from '../src/app/config/defaults.js';
import { createPrismaClient } from '../src/app/database/prisma.js';
import { createLogger } from '../src/app/logger/logger.js';
import { analysisMessage } from '../src/bot/messages/analysis.js';
import { INDODAX_CLIENT_DEFAULTS, IndodaxPublicRest } from '../src/exchange/indodax/public-rest.js';
import { RateLimiter } from '../src/exchange/indodax/rate-limiter.js';
import { MarketDataService } from '../src/market/market-data-service.js';
import { InMemoryMarketRepository, PrismaMarketRepository } from '../src/market/market-repository.js';
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

if (save && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL belum diisi. Isi .env atau jalankan dengan --no-save.');
  process.exit(1);
}
const prisma = save ? createPrismaClient(process.env.DATABASE_URL!) : null;
const market = new MarketDataService({
  client,
  pairs: registry,
  repository: prisma ? new PrismaMarketRepository(prisma) : new InMemoryMarketRepository(),
  logger,
});
const service = new TechnicalAnalysisService({
  market,
  repository: prisma ? new PrismaIndicatorRepository(prisma) : new InMemoryIndicatorRepository(),
  logger,
});

try {
  const pairs: string[] = [];
  for (const input of requested.length > 0 ? requested : [...DEFAULT_WATCHLIST]) {
    const r = await registry.resolve(input);
    if (r.status === 'ok') pairs.push(r.pair.tickerId);
    else console.log(`Lewati "${input}": ${r.status}`);
  }

  const started = Date.now();
  const results = await service.analyzeMany(pairs);
  for (const { analysis } of results) {
    console.log(`\n${'═'.repeat(70)}\n${analysisMessage(analysis, new Date(), 'Asia/Jakarta')}`);
  }

  const unavailable = results.filter((r) => r.analysis.status === 'UNAVAILABLE').length;
  console.log(
    `\n${'═'.repeat(70)}\nRingkasan: ${results.length} pair · UNAVAILABLE ${unavailable} · ` +
      `${limiter.requestCount} request dalam ${((Date.now() - started) / 1000).toFixed(1)} dtk · simpan ke DB: ${save ? 'ya' : 'tidak'}`,
  );
  process.exitCode = unavailable > 0 ? 1 : 0;
} finally {
  await prisma?.$disconnect();
}
