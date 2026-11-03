/**
 * Live verification of the strategy & risk engine against the real Indodax
 * Public API (no API key, no orders). Prints exactly what /scan and the
 * /analyze STRATEGI section show.
 *
 *   pnpm strategy:check                 # default watchlist; signals NOT recorded
 *   pnpm strategy:check qnt doge        # specific pairs
 *   pnpm strategy:check --save-signals  # also record signals (they count toward today's limit!)
 *   pnpm strategy:check --no-db         # no database at all (default settings, in-memory)
 *
 * Exit code 1 if any pair is DATA_UNAVAILABLE.
 */
import 'dotenv/config';
import { InMemoryIndicatorRepository, PrismaIndicatorRepository } from '../src/analysis/indicator-repository.js';
import { TechnicalAnalysisService } from '../src/analysis/technical-analysis-service.js';
import { DEFAULT_WATCHLIST } from '../src/app/config/defaults.js';
import { createPrismaClient } from '../src/app/database/prisma.js';
import { createLogger } from '../src/app/logger/logger.js';
import { scanMessage, strategyMessage } from '../src/bot/messages/strategy.js';
import { INDODAX_CLIENT_DEFAULTS, IndodaxPublicRest } from '../src/exchange/indodax/public-rest.js';
import { RateLimiter } from '../src/exchange/indodax/rate-limiter.js';
import { MarketDataService } from '../src/market/market-data-service.js';
import { InMemoryMarketRepository, PrismaMarketRepository } from '../src/market/market-repository.js';
import { PairRegistry } from '../src/market/pair-registry.js';
import { UnavailableJournalLedger } from '../src/risk/risk-ledger.js';
import { defaultStrategySettings, PrismaStrategySettings } from '../src/strategy/settings.js';
import { InMemorySignalRepository, PrismaSignalRepository } from '../src/strategy/signal-repository.js';
import { StrategyService } from '../src/strategy/strategy-service.js';

const args = process.argv.slice(2);
const useDb = !args.includes('--no-db');
const saveSignals = args.includes('--save-signals');
const requested = args.filter((a) => !a.startsWith('--'));
const TZ = 'Asia/Jakarta';

if (useDb && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL belum diisi. Isi .env atau jalankan dengan --no-db.');
  process.exit(1);
}
if (saveSignals && !useDb) {
  console.error('--save-signals butuh database.');
  process.exit(1);
}
const ownerId = Number(process.env.TELEGRAM_ALLOWED_USER_ID);

const logger = createLogger({ level: 'warn', pretty: true });
const limiter = new RateLimiter({
  maxRequests: INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute,
  windowMs: 60_000,
  maxConcurrent: INDODAX_CLIENT_DEFAULTS.maxConcurrent,
});
const client = new IndodaxPublicRest(process.env.INDODAX_PUBLIC_BASE_URL || 'https://indodax.com', { limiter });
const registry = new PairRegistry(client);
const prisma = useDb ? createPrismaClient(process.env.DATABASE_URL!) : null;

const market = new MarketDataService({
  client,
  pairs: registry,
  repository: prisma ? new PrismaMarketRepository(prisma) : new InMemoryMarketRepository(),
  logger,
});
const analysis = new TechnicalAnalysisService({
  market,
  repository: prisma ? new PrismaIndicatorRepository(prisma) : new InMemoryIndicatorRepository(),
  logger,
});
const strategy = new StrategyService({
  analysis,
  market,
  // Without --save-signals nothing is recorded, so this check never uses up today's recommendations.
  signals: prisma && saveSignals ? new PrismaSignalRepository(prisma) : new InMemorySignalRepository(),
  settings: prisma && Number.isInteger(ownerId) ? new PrismaStrategySettings(prisma, ownerId) : { load: async () => defaultStrategySettings() },
  journal: new UnavailableJournalLedger(),
  logger,
  timeZone: TZ,
});

try {
  const pairs: string[] = [];
  for (const input of requested.length > 0 ? requested : [...DEFAULT_WATCHLIST]) {
    const r = await registry.resolve(input);
    if (r.status === 'ok') pairs.push(r.pair.tickerId);
    else console.log(`Lewati "${input}": ${r.status}`);
  }

  const started = Date.now();
  const scan = await strategy.scan(pairs);
  console.log(`${'═'.repeat(70)}\n${scanMessage(scan, TZ)}`);
  for (const r of scan.results) {
    console.log(`\n${'─'.repeat(70)}\n${strategyMessage({ ...r, risk: scan.risk, settings: scan.settings }, TZ)}`);
  }
  const unavailable = scan.results.filter((r) => r.decision.decision === 'DATA_UNAVAILABLE').length;
  const counts = scan.results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.decision.decision]: (acc[r.decision.decision] ?? 0) + 1 }), {});
  console.log(
    `\n${'═'.repeat(70)}\nRingkasan: ${JSON.stringify(counts)} · ${limiter.requestCount} request dalam ${((Date.now() - started) / 1000).toFixed(1)} dtk · ` +
      `sinyal dicatat: ${saveSignals ? 'ya' : 'tidak'} · database: ${useDb ? 'ya' : 'tidak'}`,
  );
  process.exitCode = unavailable > 0 ? 1 : 0;
} finally {
  await prisma?.$disconnect();
}
