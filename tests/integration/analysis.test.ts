import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ANALYSIS_DEFAULTS } from '../../src/analysis/config.js';
import { analyzeTrend } from '../../src/analysis/engine.js';
import { PrismaIndicatorRepository } from '../../src/analysis/indicator-repository.js';
import { TechnicalAnalysisService } from '../../src/analysis/technical-analysis-service.js';
import { createPrismaClient, type PrismaClient } from '../../src/app/database/prisma.js';
import { createLogger } from '../../src/app/logger/logger.js';
import { MarketDataService } from '../../src/market/market-data-service.js';
import { PrismaMarketRepository } from '../../src/market/market-repository.js';
import { FakeMarketClient, makeCandles, makePair, NOW } from '../helpers/market.js';

/**
 * Milestone 3 persistence against a real, migrated PostgreSQL database.
 * Skipped unless TEST_DATABASE_URL is set. Uses its own pair name only.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PAIR = 'tatest_idr';

describe.skipIf(!TEST_DATABASE_URL)('technical analysis persistence (PostgreSQL)', () => {
  let prisma: PrismaClient;

  const cleanup = async () => {
    await prisma.indicatorSnapshot.deleteMany({ where: { pair: PAIR } });
    await prisma.marketSnapshot.deleteMany({ where: { pair: PAIR } });
    await prisma.candle.deleteMany({ where: { pair: PAIR } });
  };

  function services() {
    const client = new FakeMarketClient();
    client.candles = makeCandles(860, new Date('2026-11-02T09:15:00Z'), { pair: PAIR, zeroVolumeFromEnd: [2, 5, 9] });
    client.candles1h = makeCandles(400, new Date('2026-11-02T09:00:00Z'), { pair: PAIR, timeframe: '60' });
    const logger = createLogger({ level: 'silent' });
    const market = new MarketDataService({
      client,
      pairs: { get: async () => makePair({ tickerId: PAIR }) },
      repository: new PrismaMarketRepository(prisma),
      logger,
      now: () => NOW,
    });
    return new TechnicalAnalysisService({ market, repository: new PrismaIndicatorRepository(prisma), logger, now: () => NOW });
  }

  beforeAll(() => {
    prisma = createPrismaClient(TEST_DATABASE_URL!);
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('stores one row per timeframe, linked to the market snapshot', async () => {
    const { market, analysis } = await services().analyze(PAIR);
    const rows = await prisma.indicatorSnapshot.findMany({ where: { pair: PAIR }, orderBy: { timeframe: 'asc' } });

    expect(rows.map((r) => r.timeframe)).toEqual(['15', '60']);
    const r15 = rows[0]!;
    expect(r15.candleOpenTime).toEqual(new Date('2026-11-02T09:00:00Z'));
    expect(r15.windowSize).toBe(300);
    expect(r15.engineVersion).toBe(ANALYSIS_DEFAULTS.engineVersion);
    expect(r15.qualityStatus).toBe('OK');
    expect(r15.marketSnapshotId).toBe(market.snapshotId);
    expect(r15.ema20!.toString()).toBe(analysis.main!.ema20.value!.toDecimalPlaces(12).toFixed());
    expect(r15.zeroVolumeCount20).toBe(3);
    expect(rows[1]!.candleOpenTime).toEqual(new Date('2026-11-02T08:00:00Z'));
    expect(rows[1]!.atr14).toBeNull();
  });

  it('is idempotent: analysing the same candle again updates, never duplicates', async () => {
    await services().analyze(PAIR);
    await services().analyze(PAIR);
    expect(await prisma.indicatorSnapshot.count({ where: { pair: PAIR } })).toBe(2);
  });

  it('recomputing from the stored candles reproduces the stored values exactly', async () => {
    await services().analyze(PAIR);
    const stored = await prisma.indicatorSnapshot.findFirstOrThrow({ where: { pair: PAIR, timeframe: '15' } });
    const candles = await new PrismaMarketRepository(prisma).loadCandles(PAIR, '15', 300);
    const t = analyzeTrend(candles, '15', ANALYSIS_DEFAULTS);
    expect(t.ema9.value!.toDecimalPlaces(12).toFixed()).toBe(stored.ema9!.toString());
    expect(t.ema50.value!.toDecimalPlaces(12).toFixed()).toBe(stored.ema50!.toString());
    expect(t.rsi14.value!.toDecimalPlaces(12).toFixed()).toBe(stored.rsi14!.toString());
  });

  it('never modifies Milestone 2 candles or snapshots', async () => {
    await services().analyze(PAIR);
    const before = await prisma.candle.findMany({ where: { pair: PAIR }, orderBy: { openTime: 'asc' } });
    const snapshotsBefore = await prisma.marketSnapshot.count({ where: { pair: PAIR } });

    // Analysing again from the same stored data (market cache bypassed by a new service).
    await services().analyze(PAIR);
    const after = await prisma.candle.findMany({ where: { pair: PAIR }, orderBy: { openTime: 'asc' } });
    expect(after.map((c) => [c.openTime.getTime(), c.close.toString(), c.volume.toString()])).toEqual(
      before.map((c) => [c.openTime.getTime(), c.close.toString(), c.volume.toString()]),
    );
    expect(await prisma.marketSnapshot.count({ where: { pair: PAIR } })).toBe(snapshotsBefore + 1); // new snapshot only, nothing altered
  });
});
