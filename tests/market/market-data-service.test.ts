import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/app/logger/logger.js';
import { MarketDataService } from '../../src/market/market-data-service.js';
import { InMemoryMarketRepository } from '../../src/market/market-repository.js';
import { canProduceBuySignal } from '../../src/market/market-validator.js';
import type { PairInfo } from '../../src/market/types.js';
import { FakeMarketClient, LATEST_FINAL_OPEN, makePair, NOW } from '../helpers/market.js';

function setup(pairInfo: PairInfo | null = makePair()) {
  let clock = NOW.getTime();
  const client = new FakeMarketClient();
  const repository = new InMemoryMarketRepository();
  const service = new MarketDataService({
    client,
    pairs: { get: async () => pairInfo },
    repository,
    logger: createLogger({ level: 'silent' }),
    now: () => new Date(clock),
  });
  return { service, client, repository, advance: (ms: number) => (clock += ms) };
}

describe('MarketDataService', () => {
  it('fetches, validates and returns OK data for a healthy pair', async () => {
    const { service } = setup();
    const data = await service.refresh('qnt_idr');
    expect(data.quality.status).toBe('OK');
    expect(data.metrics!.spreadIdr.toFixed()).toBe('11000');
    expect(data.tradeActivity!.count).toBe(2);
  });

  it('never stores or returns the in-progress candle as final', async () => {
    const { service, repository } = setup();
    const data = await service.refresh('qnt_idr');

    expect(data.finalCandles.at(-1)!.openTime).toEqual(LATEST_FINAL_OPEN);
    expect(data.pendingCandle!.openTime).toEqual(new Date('2026-11-02T09:15:00Z'));
    const stored = await repository.loadCandles('qnt_idr', '15', 10_000);
    expect(stored.some((c) => c.openTime.getTime() === data.pendingCandle!.openTime.getTime())).toBe(false);
    expect(data.finalCandles).toHaveLength(300); // candleLoadLimit
  });

  it('backfills once, then fetches incrementally with a small overlap', async () => {
    const { service, client, advance } = setup();
    const requests15m = () => client.candleRequests.filter((r) => r.timeframe === '15');
    await service.refresh('qnt_idr');
    expect(requests15m()[0]!.from).toEqual(new Date(NOW.getTime() - 860 * 900_000));

    advance(60_000);
    await service.refresh('qnt_idr', { force: true });
    expect(requests15m()[1]!.from).toEqual(new Date(LATEST_FINAL_OPEN.getTime() - 2 * 900_000));
  });

  it('serves repeated requests from a 30 s cache to protect the rate limit', async () => {
    const { service, client, advance } = setup();
    await service.refresh('qnt_idr');
    advance(29_000);
    await service.refresh('qnt_idr');
    expect(client.calls.ticker).toBe(1);
    advance(2_000);
    await service.refresh('qnt_idr');
    expect(client.calls.ticker).toBe(2);
  });

  it('saves a traceable snapshot with fetch time, server time and quality', async () => {
    const { service, repository } = setup();
    await service.refresh('qnt_idr');
    const s = repository.snapshots[0]!;
    expect(s.fetchedAt).toEqual(NOW);
    expect(s.serverTime).toEqual(new Date(NOW.getTime() - 5_000));
    expect(s.spreadIdr.toFixed()).toBe('11000');
    expect(s.qualityStatus).toBe('OK');
    expect(s.tradeActivity).toMatchObject({ newestTradeId: '144115188260077791' });
    expect(s.orderBookData).toMatchObject({ levelsWithinPct: 2, bands: [{ pct: 1 }, { pct: 2 }] });
  });

  it('makes no market requests for maintenance pairs and marks them UNAVAILABLE', async () => {
    const { service, client, repository } = setup(makePair({ isMaintenance: true }));
    const data = await service.refresh('qnt_idr');
    expect(data.quality.status).toBe('UNAVAILABLE');
    expect(data.quality.issues.map((i) => i.code)).toContain('PAIR_MAINTENANCE');
    expect(canProduceBuySignal(data.quality)).toBe(false);
    expect(client.calls).toEqual({ ticker: 0, orderBook: 0, trades: 0, candles: 0 });
    expect(repository.snapshots).toHaveLength(0);
  });

  it('turns fetch failures into UNAVAILABLE instead of throwing', async () => {
    const { service, client } = setup();
    client.ticker = new Error('HTTP 503');
    const data = await service.refresh('qnt_idr');
    expect(data.quality.status).toBe('UNAVAILABLE');
    expect(data.quality.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['FETCH_FAILED_TICKER', 'TICKER_MISSING']));
  });

  it('fetches final 1H trend candles with Indodax tf=60, separately from 15m', async () => {
    const { service, client, repository } = setup();
    const data = await service.refresh('qnt_idr');
    expect(client.candleRequests.map((r) => r.timeframe).sort()).toEqual(['15', '60']);
    expect(data.trendTimeframe).toBe('60');
    expect(data.trendCandles.every((c) => c.timeframe === '60')).toBe(true);
    expect(data.trendCandles.at(-1)!.openTime).toEqual(new Date('2026-11-02T08:00:00Z')); // 09:00 is still forming
    expect(await repository.latestCandleOpenTime('qnt_idr', '60')).toEqual(new Date('2026-11-02T08:00:00Z'));
    expect(data.snapshotId).toBe(1n);
  });

  it('keeps the 15m quality unaffected when 1H candles fail', async () => {
    const { service, client } = setup();
    client.candles1h = new Error('HTTP 503');
    const data = await service.refresh('qnt_idr');
    expect(data.quality.status).toBe('OK');
    expect(data.trendCandles).toEqual([]);
    expect(data.trendError).toContain('HTTP 503');
  });

  it('reports insufficient history for a newly listed pair', async () => {
    const { service, client } = setup();
    client.candles = client.candles.slice(-50);
    const data = await service.refresh('qnt_idr');
    expect(data.quality.issues.map((i) => i.code)).toContain('CANDLES_INSUFFICIENT');
  });
});
