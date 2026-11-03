import { describe, expect, it } from 'vitest';
import { ANALYSIS_DEFAULTS } from '../../src/analysis/config.js';
import { computeTechnicalAnalysis, NonFinalCandleError } from '../../src/analysis/engine.js';
import { rsiLabel } from '../../src/analysis/interpretation.js';
import { toIndicatorRecords } from '../../src/analysis/indicator-repository.js';
import { Dec } from '../../src/app/decimal.js';
import { analysisMessage, analysisSummaryLine } from '../../src/bot/messages/analysis.js';
import { computeOrderBookMetrics } from '../../src/market/orderbook-service.js';
import { summarizeTrades } from '../../src/market/trade-activity.js';
import { fixtureMarketData } from '../helpers/analysis-fixtures.js';
import { healthyBook, makeBook, makeTicker, makeTrade } from '../helpers/market.js';

const cfg = ANALYSIS_DEFAULTS;
const run = (pair = 'qnt_idr', mutate: (d: ReturnType<typeof fixtureMarketData>['data']) => void = () => undefined) => {
  const { data, now } = fixtureMarketData(pair);
  mutate(data);
  return computeTechnicalAnalysis(data, cfg, now, 90);
};

describe('quality gate', () => {
  it('UNAVAILABLE market data → no indicators at all, reasons shown, nothing to store', () => {
    const a = run('qnt_idr', (d) => {
      d.quality = { status: 'UNAVAILABLE', issues: [{ code: 'PAIR_MAINTENANCE', severity: 'critical', message: 'Pair sedang maintenance' }], checkedAt: d.fetchedAt };
    });
    expect(a).toMatchObject({ status: 'UNAVAILABLE', main: null, trend: null, volatility: null, volume: null, orderBook: null, levels: null });
    expect(a.unavailableReasons).toEqual(['Pair sedang maintenance']);
    expect(toIndicatorRecords(a, null)).toEqual([]);
  });

  it('DEGRADED market data → indicators computed, warnings carried along', () => {
    const a = run('link_idr', (d) => {
      d.quality = { status: 'DEGRADED', issues: [{ code: 'LOW_LIQUIDITY', severity: 'warning', message: '8 dari 20 candle tanpa transaksi' }], checkedAt: d.fetchedAt };
    });
    expect(a.status).toBe('DEGRADED');
    expect(a.main?.ema20.value).not.toBeNull();
    expect(a.dataWarnings).toEqual(['8 dari 20 candle tanpa transaksi']);
    expect(toIndicatorRecords(a, null).map((r) => r.qualityStatus)).toEqual(['DEGRADED', 'DEGRADED']);
  });

  it('market data OK does not make every indicator reliable (LINK)', () => {
    const a = run('link_idr');
    expect(a.status).toBe('OK');
    const reliabilities = [a.main!.ema50.reliability, a.main!.rsi14.reliability, a.volatility!.atr14.reliability];
    expect(reliabilities).toContain('kurang_andal');
    expect(a.volatility!.atr14.notes.join(' ')).toContain('tanpa transaksi');
  });
});

describe('final candles only', () => {
  it('rejects a non-final (in-progress) candle passed to the engine', () => {
    const { data, now } = fixtureMarketData('qnt_idr');
    const last = data.finalCandles.at(-1)!;
    const inProgress = { ...last, openTime: new Date(now.getTime() - 60_000) };
    expect(() => computeTechnicalAnalysis({ ...data, finalCandles: [...data.finalCandles, inProgress] }, cfg, now, 90)).toThrow(NonFinalCandleError);
  });

  it('rejects a candle that closed but is still inside the settle period', () => {
    const { data, now } = fixtureMarketData('qnt_idr');
    const settling = { ...data.finalCandles.at(-1)!, openTime: new Date(now.getTime() - 900_000 - 30_000) };
    expect(() => computeTechnicalAnalysis({ ...data, finalCandles: [...data.finalCandles, settling] }, cfg, now, 90)).toThrow(NonFinalCandleError);
  });

  it('rejects 15m candles mixed into the 1H series (no implicit aggregation)', () => {
    const { data, now } = fixtureMarketData('qnt_idr');
    expect(() => computeTechnicalAnalysis({ ...data, trendCandles: data.finalCandles.slice(-60) }, cfg, now, 90)).not.toThrow();
    const a = computeTechnicalAnalysis({ ...data, trendCandles: data.finalCandles.slice(-60) }, cfg, now, 90);
    // 15m candles are not aligned/labelled as 1H: the trend timeframe is reported unavailable.
    expect(a.trend!.unavailableReason).not.toBeNull();
  });

  it('a pending candle in the market data never affects the result', () => {
    const base = run('qnt_idr');
    const withPending = run('qnt_idr', (d) => {
      d.pendingCandle = { ...d.finalCandles.at(-1)!, openTime: new Date(d.fetchedAt.getTime() - 60_000), close: new Dec(1) };
    });
    expect(withPending.main!.ema9.value!.eq(base.main!.ema9.value!)).toBe(true);
    expect(withPending.main!.rsi14.value!.eq(base.main!.rsi14.value!)).toBe(true);
  });
});

describe('1H trend confirmation', () => {
  it('uses final 1H candles', () => {
    const a = run();
    expect(a.trend).toMatchObject({ timeframe: '60', unavailableReason: null, candleCount: 300 });
    expect(a.trend!.ema50.value).not.toBeNull();
  });

  it('shows null with a clear reason when 1H data failed to load', () => {
    const a = run('qnt_idr', (d) => {
      d.trendCandles = [];
      d.trendError = 'HTTP 503';
    });
    expect(a.trend!.unavailableReason).toBe('gagal mengambil candle 1 jam: HTTP 503');
    expect(a.trend!.ema9.value).toBeNull();
  });

  it('shows null with a clear reason when 1H history is missing or insufficient', () => {
    expect(run('qnt_idr', (d) => void (d.trendCandles = [])).trend!.unavailableReason).toBe('belum ada candle 1 jam final');
    const short = run('qnt_idr', (d) => void (d.trendCandles = d.trendCandles.slice(-30)));
    expect(short.trend!.unavailableReason).toBeNull();
    expect(short.trend!.ema50).toMatchObject({ value: null, reliability: 'tidak_tersedia', notes: ['butuh 50 candle final, tersedia 30'] });
    expect(short.trend!.ema20.reliability).toBe('kurang_andal'); // warming up: 30 < 60
  });

  it('flags a lagging 1H series', () => {
    const a = run('qnt_idr', (d) => void (d.trendCandles = d.trendCandles.slice(0, -2)));
    expect(a.trend!.unavailableReason).toBe('candle 1 jam tertinggal (belum diperbarui)');
  });
});

describe('interpretation never implies a trade', () => {
  it('RSI 100 is not a buy signal; low RSI is not automatically an opportunity', () => {
    expect(rsiLabel(new Dec(100))).toContain('bukan sinyal beli');
    expect(rsiLabel(new Dec(25))).toContain('bukan otomatis kesempatan beli');
    expect(rsiLabel(new Dec(0))).toContain('bukan otomatis kesempatan beli');
  });

  it.each(['qnt_idr', 'doge_idr', 'xrp_idr', 'link_idr'])('no BUY/SELL/WAIT wording in any output — %s', (pair) => {
    const a = run(pair, (d) => {
      d.ticker = makeTicker({ pair });
      d.metrics = computeOrderBookMetrics(healthyBook(), [1, 2]);
      d.tradeActivity = summarizeTrades([makeTrade(60, 'buy', 1, '1')], d.fetchedAt, 60);
    });
    const text = [analysisMessage(a, new Date(), 'Asia/Jakarta'), analysisSummaryLine(a), JSON.stringify(toIndicatorRecords(a, null))].join('\n');
    expect(text).not.toMatch(/\b(BUY|SELL|WAIT|BUY_CANDIDATE|NO TRADE)\b/i);
    expect(text).toContain('bukan sinyal beli/jual');
  });
});

describe('order book interpretation', () => {
  const trade = (at: Date, secondsAgo: number, side: 'buy' | 'sell', amount: string) => ({
    tid: '144115188260077791',
    time: new Date(at.getTime() - secondsAgo * 1000),
    price: new Dec(1000),
    amount: new Dec(amount),
    side,
  });

  it('combines ±1%/±2% imbalance with trade flow', () => {
    const a = run('qnt_idr', (d) => {
      d.metrics = computeOrderBookMetrics(healthyBook(), [1, 2]); // +8.8% / +13.4% → seimbang
      d.tradeActivity = summarizeTrades([trade(d.fetchedAt, 60, 'sell', '9'), trade(d.fetchedAt, 90, 'buy', '1')], d.fetchedAt, 60);
    });
    expect(a.orderBook!.bands.map((b) => b.pressure)).toEqual(['seimbang', 'seimbang']);
    expect(a.orderBook!.tradeFlow).toBe('jual');
    expect(a.orderBook!.consistent).toBe(true); // balanced vs sell is not a contradiction
  });

  it('flags order book and trade flow pointing in opposite directions', () => {
    const a = run('qnt_idr', (d) => {
      d.metrics = computeOrderBookMetrics(makeBook([[3585000, '10']], [[3596000, '1']]), [1, 2]); // strong bid side
      d.tradeActivity = summarizeTrades([trade(d.fetchedAt, 60, 'sell', '9'), trade(d.fetchedAt, 90, 'buy', '1')], d.fetchedAt, 60);
    });
    expect(a.orderBook!.bands[0]!.pressure).toBe('beli');
    expect(a.orderBook!.consistent).toBe(false);
    expect(a.orderBook!.notes).toContain('order book dan arus trade berlawanan arah');
  });
});

describe('stored records', () => {
  it('one row per timeframe, keyed by the last final candle, values rounded to 12 decimals', () => {
    const a = run();
    const records = toIndicatorRecords(a, 42n);
    expect(records.map((r) => r.timeframe)).toEqual(['15', '60']);
    expect(records[0]!.candleOpenTime).toEqual(a.main!.lastCandleOpen);
    expect(records[0]!.windowSize).toBe(300);
    expect(records[0]!.marketSnapshotId).toBe(42n);
    for (const v of Object.values(records[0]!.values)) if (v) expect(v.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(12);
    expect(records[1]!.values.atr14).toBeUndefined();
  });
});
