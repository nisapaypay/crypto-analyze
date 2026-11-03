import 'dotenv/config';
import { PrismaIndicatorRepository } from './analysis/indicator-repository.js';
import { TechnicalAnalysisService } from './analysis/technical-analysis-service.js';
import { PrismaAuditLog } from './app/audit/audit-log.js';
import { ConfigError, collectSecrets, loadConfig, type AppConfig } from './app/config/env.js';
import { createPrismaClient } from './app/database/prisma.js';
import { HealthService } from './app/health/health-service.js';
import { RequestMeter } from './app/http/request-meter.js';
import { PrismaNotificationRepository } from './notify/notification-repository.js';
import { Notifier } from './notify/notifier.js';
import { NOTIFY_DEFAULTS } from './notify/rules.js';
import { buildSummaryView, SummaryScheduler } from './notify/summary.js';
import { SystemAlerts } from './notify/system-alerts.js';
import { TelegramSender } from './notify/telegram-sender.js';
import { PrismaSignalHistory } from './notify/transitions.js';
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
import { adviceNotification } from './bot/messages/notifications.js';
import { PrismaActiveBuyReader } from './scheduler/active-buys.js';
import { ClockGuard } from './scheduler/clock-guard.js';
import { EntryMonitor } from './scheduler/entry-monitor.js';
import { STRATEGY_DEFAULTS } from './strategy/config.js';
import { CandleContinuity, PrismaCandleStore } from './scheduler/candle-continuity.js';
import { SCHEDULER_DEFAULTS } from './scheduler/config.js';
import { PrismaGapRepository } from './scheduler/data-gaps.js';
import { Heartbeat } from './scheduler/heartbeat.js';
import { InstanceLock } from './scheduler/instance-lock.js';
import { JobRunner } from './scheduler/job-runner.js';
import { guardMarket, preflight } from './scheduler/market-guard.js';
import { ScanScheduler } from './scheduler/scan-scheduler.js';
import { PrismaSchedulerRepository } from './scheduler/scheduler-repository.js';
import { PrismaSchedulerControl } from './scheduler/scheduler-settings.js';
import { ServerClock } from './scheduler/server-clock.js';
import { collectReport, strategyReport } from './scheduler/tasks.js';
import { PrismaWatchlistRepository } from './watchlist/watchlist-repository.js';

/** Covers draining a running slot (20 s) plus closing the bot and database. */
const SHUTDOWN_TIMEOUT_MS = 30_000;
/** A slot run includes per-attempt timeouts and up to two retry waits. */
const SLOT_RUN_WATCHDOG_MS = 8 * 60_000;

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

  // Single instance: a second process must not poll Telegram or run the scheduler.
  const lock = new InstanceLock(config.databaseUrl, logger);
  if (!(await lock.acquire())) {
    console.error('Instance lain aplikasi ini sedang berjalan (lock PostgreSQL dipegang). Hentikan instance itu dahulu.');
    await prisma.$disconnect();
    process.exit(1);
  }
  const audit = new PrismaAuditLog(prisma, logger);

  // Counts every HTTP attempt (retries included) for /status and the soak report.
  const meter = new RequestMeter();
  const fetchFn = meter.wrap(fetch);
  // One limiter shared by every Indodax client keeps the combined rate bounded.
  const limiter = new RateLimiter({
    maxRequests: INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute,
    windowMs: 60_000,
    maxConcurrent: INDODAX_CLIENT_DEFAULTS.maxConcurrent,
  });
  const indodaxMarket = new IndodaxPublicRest(config.indodax.publicBaseUrl, { limiter, fetchFn });
  // Health checks and the scheduler preflight should fail fast, without retries.
  const indodax = new IndodaxPublicRest(config.indodax.publicBaseUrl, { limiter, fetchFn, retry: { retries: 0, baseDelayMs: 0 } });
  const pairs = new PairRegistry(indodaxMarket);
  const marketRepository = new PrismaMarketRepository(prisma);
  // Trading path: M2 with the local clock (only used while the clock guard is VALID).
  const market = new MarketDataService({ client: indodaxMarket, pairs, repository: marketRepository, logger });
  // Data-collection path: the same M2 class, given trusted Indodax time as its clock
  // (constructor injection, M2 unchanged), so collection does not depend on the local clock.
  const serverClock = new ServerClock({
    maxDriftMs: SCHEDULER_DEFAULTS.serverTimeMaxDriftMs,
    maxAnchorAgeMs: SCHEDULER_DEFAULTS.serverTimeMaxAnchorAgeMs,
    maxCacheAgeSec: SCHEDULER_DEFAULTS.serverTimeMaxCacheAgeSec,
  });
  const collectorMarket = new MarketDataService({ client: indodaxMarket, pairs, repository: marketRepository, logger, now: () => serverClock.estimate() });
  const collectRefresh = async (pair: string) => {
    serverClock.current(); // throws ServerTimeUntrustedError → slot recorded as a data gap
    return collectorMarket.refresh(pair, { force: true });
  };

  // Every consumer gets market data only while the local clock agrees with Indodax.
  const clock = new ClockGuard({
    maxSkewMs: SCHEDULER_DEFAULTS.clockMaxSkewMs,
    validChecks: SCHEDULER_DEFAULTS.clockValidChecks,
    onChange: (status, skewMs) => {
      const log = status === 'VALID' ? logger.info.bind(logger) : logger.error.bind(logger);
      log({ status, skewMs }, 'Status jam berubah');
      void audit.record({ action: 'scheduler.clock', details: { status, skewMs } });
    },
  });
  const guardedMarket = guardMarket(market, clock);

  const analysis = new TechnicalAnalysisService({ market: guardedMarket, repository: new PrismaIndicatorRepository(prisma), logger });
  const strategy = new StrategyService({
    analysis,
    market: guardedMarket,
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

  const watchlist = new PrismaWatchlistRepository(prisma);
  const enabledPairs = async () => (await watchlist.listForTelegramUser(config.telegram.allowedUserId)).filter((e) => e.enabled).map((e) => e.pair);
  const schedulerControl = new PrismaSchedulerControl(prisma, config.telegram.allowedUserId);
  const schedulerRepo = new PrismaSchedulerRepository(prisma);
  const slotRunner = new JobRunner(schedulerRepo, logger, { watchdogMs: SLOT_RUN_WATCHDOG_MS });
  const gapRepo = new PrismaGapRepository(prisma);
  const continuity = new CandleContinuity({
    store: new PrismaCandleStore(prisma),
    client: indodaxMarket,
    upsert: (candles) => marketRepository.upsertCandles(candles),
    gaps: gapRepo,
    serverClock,
    logger,
    timeframes: [...SCHEDULER_DEFAULTS.continuityTimeframes],
    lookbackMs: SCHEDULER_DEFAULTS.continuityLookbackMs,
    maxRequestsPerPass: SCHEDULER_DEFAULTS.continuityMaxRequests,
    settleSec: SCHEDULER_DEFAULTS.settleSec,
    chunkCandles: SCHEDULER_DEFAULTS.continuityChunkCandles,
  });
  // Notifications: only scheduled strategy scans notify (a manual /scan already answers in chat).
  // The send function is bound to the bot once it exists; the scheduler never waits for Telegram.
  let sendTelegram: (text: string) => ReturnType<TelegramSender['send']> = async () => ({ ok: false, error: 'bot belum siap', attempts: 0, rateLimited: false });
  const notificationRepo = new PrismaNotificationRepository(prisma);
  const notifier = new Notifier({
    repo: notificationRepo,
    send: (text) => sendTelegram(text),
    history: new PrismaSignalHistory(prisma),
    settings: () => schedulerControl.load(),
    audit,
    logger,
    timeZone: config.timezone,
    config: NOTIFY_DEFAULTS,
  });
  const systemAlerts = new SystemAlerts((c) => notifier.dispatch(c), {
    failuresThreshold: SCHEDULER_DEFAULTS.circuitBreakerFailures,
    serverTimeDebounceMs: 15 * 60_000,
    timeZone: config.timezone,
  });

  const scheduler = new ScanScheduler({
    repo: schedulerRepo,
    runner: slotRunner,
    clock,
    serverClock,
    preflight: (pair) => preflight(indodax, pair),
    settings: () => schedulerControl.load(),
    watchlist: enabledPairs,
    strategyScan: async (pairs) => {
      const scan = await strategy.scan(pairs);
      void notifier.afterStrategyScan(scan); // fire-and-forget: notifications never delay the slot
      return strategyReport(scan);
    },
    collect: (pairs) => collectReport(collectRefresh, pairs),
    gaps: gapRepo,
    continuity,
    isLockHeld: () => lock.isHeld,
    logger,
    timeZone: config.timezone,
    config: SCHEDULER_DEFAULTS,
  });
  let lastMetricsAt = Date.now();
  const recordMetrics = async () => {
    const mem = process.memoryUsage();
    await audit.record({
      action: 'scheduler.metrics',
      details: {
        windowMs: SCHEDULER_DEFAULTS.metricsIntervalMs,
        attempts: meter.countSince(SCHEDULER_DEFAULTS.metricsIntervalMs),
        peakPerMinute: meter.peakPerMinute(SCHEDULER_DEFAULTS.metricsIntervalMs),
        byEndpoint: meter.byEndpointSince(SCHEDULER_DEFAULTS.metricsIntervalMs),
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        clock: clock.status,
        serverTimeTrusted: serverClock.isTrusted,
      },
    });
  };
  const firstPair = async () => (await enabledPairs().catch(() => []))[0] ?? SCHEDULER_DEFAULTS.fallbackClockPair;
  const heartbeat = new Heartbeat({
    intervalMs: SCHEDULER_DEFAULTS.heartbeatMs,
    sleepDetectMs: SCHEDULER_DEFAULTS.sleepDetectMs,
    onWake: (from, to) => scheduler.onWake(from, to),
    onTick: async (now) => {
      if (!(await lock.verify())) {
        // Lock lost (e.g. database restart): reacquire before scheduling again.
        if (await lock.acquire().catch(() => false)) await scheduler.start();
        return;
      }
      await scheduler.heartbeat(now, await firstPair()).catch((error: unknown) => logger.warn({ err: error instanceof Error ? error.message : error }, 'Heartbeat gagal'));
      const st = scheduler.status();
      await systemAlerts
        .observe(
          { consecutiveFailures: st.consecutiveFailures, lastCause: st.lastRun?.cause ?? null, clock: clock.status, skewMs: clock.skewMs, serverTimeTrusted: st.serverTime.trusted, serverTimeReason: st.serverTime.reason },
          now,
        )
        .catch((error: unknown) => logger.warn({ err: error instanceof Error ? error.message : error }, 'Pemeriksaan alert sistem gagal'));
      if (Date.now() - lastMetricsAt >= SCHEDULER_DEFAULTS.metricsIntervalMs) {
        lastMetricsAt = Date.now();
        await recordMetrics();
      }
    },
  });
  lock.onLost(() => scheduler.stop());

  const bot = createBot({
    token: config.telegram.botToken,
    allowedUserId: config.telegram.allowedUserId,
    timeZone: config.timezone,
    logger,
    audit,
    health,
    watchlist,
    watchlistMax: MARKET_DATA_DEFAULTS.watchlistMax,
    pairs,
    analysis,
    strategy,
    ai: config.ai,
    schedulerControl,
    schedulerStatus: async () => {
      const s = scheduler.status();
      const settings = await schedulerControl.load().catch(() => null);
      return {
        running: s.started,
        paused: settings ? !settings.scanningEnabled : null,
        lockHeld: lock.isHeld,
        clock: { status: clock.status, skewMs: clock.skewMs, checkedAt: clock.lastCheckedAt },
        nextSlotAt: s.nextSlotAt,
        nextSlotKind: s.nextSlotKind,
        lastRun: s.lastRun,
        consecutiveFailures: s.consecutiveFailures,
        breakerOpen: s.breakerOpen,
        requests: { lastHour: meter.countSince(3_600_000), peakPerMinute: meter.peakPerMinute(3_600_000), limitPerMinute: INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute },
      };
    },
  });

  const sender = new TelegramSender(bot.api, config.telegram.allowedUserId, {
    retries429: NOTIFY_DEFAULTS.telegram429Retries,
    maxRetryAfterMs: NOTIFY_DEFAULTS.telegramMaxRetryAfterMs,
    minIntervalMs: NOTIFY_DEFAULTS.minSendIntervalMs,
  });
  sendTelegram = (text) => sender.send(text);
  const signalsReadOnly = new PrismaSignalRepository(prisma);
  const summaries = new SummaryScheduler({
    times: ['09:05', '21:30'],
    repo: schedulerRepo,
    runner: new JobRunner(schedulerRepo, logger, { watchdogMs: 60_000 }),
    clock,
    settings: () => schedulerControl.load(),
    build: (at, label) =>
      buildSummaryView(
        {
          prisma,
          watchlist: enabledPairs,
          riskOverview: () => strategy.riskOverview(),
          openBuys: async () => (await signalsReadOnly.openBuySignals()).map((b) => ({ id: b.id, pair: b.pair, lifecycle: b.lifecycle })),
          notifications: notificationRepo,
          schedulerHealth: () => ({ consecutiveFailures: scheduler.status().consecutiveFailures, clock: clock.status, serverTimeTrusted: serverClock.isTrusted }),
          timeZone: config.timezone,
        },
        at,
        label,
      ),
    dispatch: (c) => notifier.dispatch(c),
    isLockHeld: () => lock.isHeld,
    logger,
    timeZone: config.timezone,
    graceMs: 30 * 60_000,
  });

  // Entry monitor: 1-minute data + protective advice for ACTIVE BUYs only (read-only on trading_signals).
  const entryMonitor = new EntryMonitor({
    buys: new PrismaActiveBuyReader(prisma, STRATEGY_DEFAULTS.signal.chaseAtr),
    refresh: (pair) => guardedMarket.refresh(pair, { force: true }),
    advise: ({ signal, reason, at }) =>
      notifier.dispatch({
        dedupKey: `advice:${signal.id}:${reason}`,
        kind: 'ADVICE_DO_NOT_ENTER',
        pair: signal.pair,
        signalId: signal.id,
        template: `advice_${reason.toLowerCase()}`,
        advice: { signalIssuedAt: signal.createdAt, signalExpiresAt: signal.expiresAt, lifecycle: 'ACTIVE' },
        render: () => adviceNotification({ signalId: signal.id, pair: signal.pair, reason, at }, config.timezone),
      }),
    repo: schedulerRepo,
    runner: new JobRunner(schedulerRepo, logger, { watchdogMs: 50_000 }),
    isPaused: async () => !(await schedulerControl.load()).scanningEnabled,
    isLockHeld: () => lock.isHeld,
    logger,
    tickMs: SCHEDULER_DEFAULTS.monitorTickMs,
    maxTicksPerSignal: SCHEDULER_DEFAULTS.monitorMaxTicks,
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
    heartbeat.stop();
    scheduler.stop();
    summaries.stop();
    entryMonitor.stop();
    if (!(await slotRunner.drain(SCHEDULER_DEFAULTS.shutdownDrainMs))) {
      logger.warn('Run scheduler masih berjalan saat shutdown; ditandai INTERRUPTED');
      await schedulerRepo.interruptRunning(new Date()).catch(() => undefined);
    }
    // Let queued notifications finish (bounded), then stop polling.
    await Promise.race([notifier.idle(), new Promise((r) => setTimeout(r, 5_000))]);
    await bot.stop();
    await lock.release();
    await prisma.$disconnect();
    logger.info('Aplikasi berhenti.');
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.init();
  await registerCommandMenu(bot);

  // Fail-closed: no decision or data storage until the clock is verified against Indodax.
  if (!(await scheduler.verifyClock(await firstPair()))) {
    logger.error('Jam belum terverifikasi terhadap Indodax: keputusan dan penyimpanan data ditahan sampai valid (dicek setiap menit).');
  }
  await notifier.recoverPending(NOTIFY_DEFAULTS.stalePendingMs);
  const startedAt = new Date();
  await scheduler.start();
  // One notice when slots were missed while the process was down (recorded as gaps).
  const missedOffline = await prisma.scheduledScan.findMany({ where: { status: 'MISSED', cause: 'OFFLINE', finishedAt: { gte: startedAt } }, orderBy: { scheduledAt: 'asc' }, select: { scheduledAt: true } });
  void systemAlerts.restarted(scheduler.instanceId, missedOffline.length, missedOffline[0]?.scheduledAt ?? null, new Date());
  await summaries.start();
  entryMonitor.start();
  heartbeat.start();
  logger.info('Scheduler berjalan (slot candle 15m + 90 dtk, 24/7)');
  logger.info({ bot: bot.botInfo.username }, 'Bot Telegram berjalan (long polling)');
  await bot.start({ drop_pending_updates: true });
}

main().catch((error: unknown) => {
  console.error('Gagal menjalankan aplikasi:', error instanceof Error ? error.message : error);
  process.exit(1);
});
