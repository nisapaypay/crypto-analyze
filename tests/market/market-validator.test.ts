import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { MARKET_DATA_DEFAULTS } from '../../src/market/config.js';
import { canProduceBuySignal, validateMarketData, type ValidationInput } from '../../src/market/market-validator.js';
import { computeOrderBookMetrics } from '../../src/market/orderbook-service.js';
import { healthyBook, LATEST_FINAL_OPEN, makeBook, makeCandles, makePair, makeTicker, makeTrade, NOW } from '../helpers/market.js';

function input(overrides: Partial<ValidationInput> = {}): ValidationInput {
  const orderBook = overrides.orderBook === undefined ? healthyBook() : overrides.orderBook;
  return {
    pair: 'qnt_idr',
    pairInfo: makePair(),
    ticker: makeTicker(),
    orderBook,
    metrics: orderBook ? computeOrderBookMetrics(orderBook, [1, 2]) : null,
    finalCandles: makeCandles(200, LATEST_FINAL_OPEN),
    timeframe: '15',
    trades: [makeTrade(60, 'buy', 3590000, '0.1')],
    fetchErrors: [],
    now: NOW,
    ...overrides,
  };
}

const validate = (o: Partial<ValidationInput> = {}) => validateMarketData(input(o), MARKET_DATA_DEFAULTS);
const codes = (o: Partial<ValidationInput> = {}) => validate(o).issues.map((i) => i.code);

describe('validateMarketData', () => {
  it('returns OK for complete, fresh data', () => {
    const report = validate();
    expect(report).toMatchObject({ status: 'OK', issues: [] });
    expect(canProduceBuySignal(report)).toBe(true);
  });

  describe('UNAVAILABLE — can never produce BUY', () => {
    const cases: [string, Partial<ValidationInput>, string][] = [
      ['pair not found', { pairInfo: null }, 'PAIR_NOT_FOUND'],
      ['pair in maintenance', { pairInfo: makePair({ isMaintenance: true }) }, 'PAIR_MAINTENANCE'],
      ['market suspended', { pairInfo: makePair({ isSuspended: true }) }, 'PAIR_SUSPENDED'],
      ['ticker missing', { ticker: null }, 'TICKER_MISSING'],
      ['ticker stale (> 90 s)', { ticker: makeTicker({ serverTime: new Date(NOW.getTime() - 91_000) }) }, 'TICKER_STALE'],
      ['ticker from the future', { ticker: makeTicker({ serverTime: new Date(NOW.getTime() + 11_000) }) }, 'TICKER_FUTURE'],
      ['ticker zero price', { ticker: makeTicker({ last: new Dec(0) }) }, 'TICKER_INVALID_PRICE'],
      ['ticker bid ≥ ask', { ticker: makeTicker({ bid: new Dec(3600000), ask: new Dec(3596000) }) }, 'TICKER_INVALID_PRICE'],
      ['order book missing', { orderBook: null }, 'ORDERBOOK_MISSING'],
      ['order book side empty', { orderBook: makeBook([], [[3596000, '1']]) }, 'ORDERBOOK_EMPTY_SIDE'],
      ['order book crossed', { orderBook: makeBook([[3600000, '1']], [[3596000, '1']]) }, 'ORDERBOOK_CROSSED'],
      ['order book stale (Cloudflare age)', { orderBook: { ...healthyBook(), cacheAgeSec: 61 } }, 'ORDERBOOK_STALE'],
      ['fewer than 150 final candles', { finalCandles: makeCandles(149, LATEST_FINAL_OPEN) }, 'CANDLES_INSUFFICIENT'],
      ['candles lagging behind', { finalCandles: makeCandles(200, new Date(LATEST_FINAL_OPEN.getTime() - 900_000)) }, 'CANDLES_STALE'],
      ['ticker fetch failed', { fetchErrors: [{ source: 'ticker', message: 'timeout' }] }, 'FETCH_FAILED_TICKER'],
    ];

    it.each(cases)('%s', (_name, overrides, code) => {
      const report = validate(overrides);
      expect(report.status).toBe('UNAVAILABLE');
      expect(report.issues.map((i) => i.code)).toContain(code);
      expect(canProduceBuySignal(report)).toBe(false);
    });

    it('detects gaps in stored candles', () => {
      const c = makeCandles(200, LATEST_FINAL_OPEN);
      expect(codes({ finalCandles: [...c.slice(0, 100), ...c.slice(101)] })).toContain('CANDLES_GAP');
    });
  });

  describe('DEGRADED — valid with warnings', () => {
    it('flags low liquidity when > 30% of the last 20 candles have zero volume', () => {
      const report = validate({ finalCandles: makeCandles(200, LATEST_FINAL_OPEN, { zeroVolumeFromEnd: [0, 1, 2, 3, 4, 5, 6] }) });
      expect(report.status).toBe('DEGRADED');
      expect(report.issues).toEqual([expect.objectContaining({ code: 'LOW_LIQUIDITY', severity: 'warning' })]);
      expect(canProduceBuySignal(report)).toBe(true);
    });

    it('does not flag liquidity at exactly 30%', () => {
      expect(codes({ finalCandles: makeCandles(200, LATEST_FINAL_OPEN, { zeroVolumeFromEnd: [0, 1, 2, 3, 4, 5] }) })).toEqual([]);
    });

    it('treats no recent trades or a failed trades fetch as warnings only', () => {
      expect(validate({ trades: [] }).status).toBe('DEGRADED');
      const failed = validate({ trades: null, fetchErrors: [{ source: 'trades', message: 'HTTP 503' }] });
      expect(failed.status).toBe('DEGRADED');
      expect(failed.issues).toEqual([expect.objectContaining({ code: 'FETCH_FAILED_TRADES', severity: 'warning' })]);
    });

    it('warns when the order book does not cover a depth band', () => {
      expect(codes({ orderBook: makeBook([[3585000, '1']], [[3596000, '1'], [5000000, '1']]) })).toContain('ORDERBOOK_BAND_TRUNCATED');
    });
  });
});
