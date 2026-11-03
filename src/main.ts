import 'dotenv/config';
import { PrismaIndicatorRepository } from './analysis/indicator-repository.js';
import { TechnicalAnalysisService } from './analysis/technical-analysis-service.js';
import { PrismaAuditLog } from './app/audit/audit-log.js';
import { ConfigError, collectSecrets, loadConfig, type AppConfig } from './app/config/env.js';
import { createPrismaClient } from './app/database/prisma.js';
import { HealthService } from './app/health/health-service.js';
import { createLogger } from './app/logger/logger.js';
import { createBot, registerCommandMenu } from './bot/bot.js';
import { INDODAX_CLIENT_DEFAULTS, IndodaxPublicRest } from './exchange/indodax/public-rest.js';
import { RateLimiter } from './exchange/indodax/rate-limiter.js';
import { MARKET_DATA_DEFAULTS } from './market/config.js';
import { MarketDataService } from './market/market-data-service.js';
import { PrismaMarketRepository } from './market/market-repository.js';
import { PairRegistry } from './market/pair-registry.js';
import { UnavailableJournalLedger } from './risk/risk-ledger.js';
import { PrismaStrategySettings } from './strategy/settings.js';
import { PrismaSignalRepository } from './strategy/signal-repository.js';
import { StrategyService } from './strategy/strategy-service.js';
import { PrismaWatchlistRepository } from './watchlist/watchlist-repository.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      console.error('\nSalin .env.example ke .env lalu lengkapi nilainya.');
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({
    level: config.logLevel,
    pretty: config.nodeEnv === 'development',
    secrets: collectSecrets(config),
  });

  const prisma = createPrismaClient(config.databaseUrl);

  // One limiter shared by every Indodax client keeps the combined rate bounded.
  const limiter = new RateLimiter({
    maxRequests: INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute,
    windowMs: 60_000,
    maxConcurrent: INDODAX_CLIENT_DEFAULTS.maxConcurrent,
  });
  const indodaxMarket = new IndodaxPublicRest(config.indodax.publicBaseUrl, { limiter });
  // Health checks should report failures quickly, without retries.
  const indodax = new IndodaxPublicRest(config.indodax.publicBaseUrl, { limiter, retry: { retries: 0, baseDelayMs: 0 } });
  const pairs = new PairRegistry(indodaxMarket);
  const market = new MarketDataService({
    client: indodaxMarket,
    pairs,
    repository: new PrismaMarketRepository(prisma),
    logger,
  });

  const analysis = new TechnicalAnalysisService({ market, repository: new PrismaIndicatorRepository(prisma), logger });
  const strategy = new StrategyService({
    analysis,
    market,
    signals: new PrismaSignalRepository(prisma),
    settings: new PrismaStrategySettings(prisma, config.telegram.allowedUserId),
    // No trading journal until Milestone 6: realized losses stay "unknown", never zero.
    journal: new UnavailableJournalLedger(),
    logger,
    timeZone: config.timezone,
  });

  const health = new HealthService({
    Database: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
    'Indodax Public API': async () => {
      const { serverTime } = await indodax.getServerTime();
      const skewSec = Math.round((Date.now() - serverTime.getTime()) / 1000);
      return `selisih jam ${skewSec}s`;
    },
  });

  const bot = createBot({
    token: config.telegram.botToken,
    allowedUserId: config.telegram.allowedUserId,
    timeZone: config.timezone,
    logger,
    audit: new PrismaAuditLog(prisma, logger),
    health,
    watchlist: new PrismaWatchlistRepository(prisma),
    watchlistMax: MARKET_DATA_DEFAULTS.watchlistMax,
    pairs,
    analysis,
    strategy,
    ai: config.ai,
  });

  if (!config.ai.enabled) {
    logger.info(`AI explanation nonaktif: ${config.ai.disabledReason}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Menghentikan aplikasi...');
    // Safety net: never let a stuck connection keep the process alive after Ctrl+C.
    setTimeout(() => {
      logger.error(`Shutdown melebihi ${SHUTDOWN_TIMEOUT_MS / 1000} detik; keluar paksa.`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    await bot.stop();
    await prisma.$disconnect();
    logger.info('Aplikasi berhenti.');
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.init();
  await registerCommandMenu(bot);
  logger.info({ bot: bot.botInfo.username }, 'Bot Telegram berjalan (long polling)');
  await bot.start({ drop_pending_updates: true });
}

main().catch((error: unknown) => {
  console.error('Gagal menjalankan aplikasi:', error instanceof Error ? error.message : error);
  process.exit(1);
});
