import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { createPrismaClient, type PrismaClient } from '../../src/app/database/prisma.js';
import { seedDefaults } from '../../src/app/database/seed-defaults.js';
import { createLogger } from '../../src/app/logger/logger.js';
import { MarketDataService } from '../../src/market/market-data-service.js';
import { PrismaMarketRepository } from '../../src/market/market-repository.js';
import { PrismaWatchlistRepository } from '../../src/watchlist/watchlist-repository.js';
import { FakeMarketClient, LATEST_FINAL_OPEN, makeCandles, makePair, NOW } from '../helpers/market.js';

/**
 * Milestone 2 persistence against a real, migrated PostgreSQL database.
 * Skipped unless TEST_DATABASE_URL is set. Uses its own pair names and
 * Telegram user so existing data is never touched.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PAIR = 'itest_idr';
const TEST_USER_ID = 900_000_002;

describe.skipIf(!TEST_DATABASE_URL)('market data persistence (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let repo: PrismaMarketRepository;

  const cleanup = async () => {
    // Exact pair only: other integration files run in parallel on the same database.
    await prisma.candle.deleteMany({ where: { pair: PAIR } });
    await prisma.marketSnapshot.deleteMany({ where: { pair: PAIR } });
    await prisma.user.deleteMany({ where: { telegramUserId: BigInt(TEST_USER_ID) } });
  };

  beforeAll(async () => {
    prisma = createPrismaClient(TEST_DATABASE_URL!);
    repo = new PrismaMarketRepository(prisma);
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('upserts candles idempotently and lets later values overwrite the overlap', async () => {
    const candles = makeCandles(5, LATEST_FINAL_OPEN, { pair: PAIR });
    await repo.upsertCandles(candles);
    await repo.upsertCandles(candles);

    const corrected = { ...candles[4]!, close: new Dec('3500999.5') };
    await repo.upsertCandles([corrected, ...makeCandles(1, new Date(LATEST_FINAL_OPEN.getTime() + 900_000), { pair: PAIR })]);

    const stored = await repo.loadCandles(PAIR, '15', 100);
    expect(stored).toHaveLength(6);
    expect(stored[4]!.close.toFixed()).toBe('3500999.5');
    expect(await repo.latestCandleOpenTime(PAIR, '15')).toEqual(new Date(LATEST_FINAL_OPEN.getTime() + 900_000));
  });

  it('round-trips prices and volumes without precision loss', async () => {
    const [c] = makeCandles(1, LATEST_FINAL_OPEN, { pair: PAIR });
    const precise = {
      ...c!,
      open: new Dec('0.000001234567'),
      high: new Dec('12345678901234567890.123456789012'),
      low: new Dec('0.000001'),
      close: new Dec('0.000001234568'),
      volume: new Dec('295787979.17653000'),
    };
    await repo.upsertCandles([precise]);
    const [back] = await repo.loadCandles(PAIR, '15', 1);
    expect(back!.open.toFixed()).toBe('0.000001234567');
    expect(back!.high.toFixed()).toBe('12345678901234567890.123456789012');
    expect(back!.volume.toFixed()).toBe('295787979.17653');
  });

  it('refuses values that PostgreSQL would round (more than 12 decimals)', async () => {
    const [c] = makeCandles(1, LATEST_FINAL_OPEN, { pair: PAIR });
    await expect(repo.upsertCandles([{ ...c!, close: new Dec('0.0000000000001') }])).rejects.toThrow('melebihi 12 desimal');
    expect(await repo.loadCandles(PAIR, '15', 10)).toEqual([]);
  });

  it('end to end: stores only final candles and a traceable snapshot', async () => {
    const client = new FakeMarketClient();
    client.candles = makeCandles(860, new Date('2026-11-02T09:15:00Z'), { pair: PAIR });
    client.candles1h = makeCandles(400, new Date('2026-11-02T09:00:00Z'), { pair: PAIR, timeframe: '60' });
    const service = new MarketDataService({
      client,
      pairs: { get: async () => makePair({ tickerId: PAIR }) },
      repository: repo,
      logger: createLogger({ level: 'silent' }),
      now: () => NOW,
    });

    const data = await service.refresh(PAIR);
    expect(data.quality.status).toBe('OK');

    const latest = await prisma.candle.findFirst({ where: { pair: PAIR }, orderBy: { openTime: 'desc' } });
    expect(latest!.openTime).toEqual(LATEST_FINAL_OPEN);
    expect(await prisma.candle.count({ where: { pair: PAIR, openTime: new Date('2026-11-02T09:15:00Z') } })).toBe(0);

    const snap = await prisma.marketSnapshot.findFirstOrThrow({ where: { pair: PAIR } });
    expect(snap.timestamp).toEqual(NOW);
    expect(snap.serverTime).toEqual(new Date(NOW.getTime() - 5_000));
    expect(snap.spread.toString()).toBe('11000');
    expect(snap.spreadPct!.toString()).toBe('0.30636402');
    expect(snap.qualityStatus).toBe('OK');
    expect(snap.orderBookAgeSec).toBe(0);
    expect(snap.tradeActivity).toMatchObject({ newestTradeId: '144115188260077791', count: 2 });
    expect(snap.orderBookData).toMatchObject({ bands: [{ pct: 1, imbalance: '0.087925' }, { pct: 2 }] });
  });

  it('adds, re-enables, limits and removes watchlist pairs', async () => {
    await seedDefaults(prisma, TEST_USER_ID);
    const watchlist = new PrismaWatchlistRepository(prisma);

    expect(await watchlist.add(TEST_USER_ID, 'qnt_idr', 10)).toBe('exists');
    expect(await watchlist.add(TEST_USER_ID, 'itest_idr', 4)).toBe('limit_reached');
    expect(await watchlist.add(TEST_USER_ID, 'itest_idr', 10)).toBe('added');
    await prisma.watchlistItem.updateMany({ where: { pair: 'itest_idr' }, data: { enabled: false } });
    expect(await watchlist.add(TEST_USER_ID, 'itest_idr', 10)).toBe('reenabled');

    expect(await watchlist.remove(TEST_USER_ID, 'itest_idr')).toBe(true);
    expect(await watchlist.remove(TEST_USER_ID, 'itest_idr')).toBe(false);
    expect((await watchlist.listForTelegramUser(TEST_USER_ID)).map((w) => w.pair)).toEqual([
      'qnt_idr',
      'doge_idr',
      'xrp_idr',
      'link_idr',
    ]);
  });
});
