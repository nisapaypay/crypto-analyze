import { describe, expect, it } from 'vitest';
import { computeOrderBookMetrics } from '../../src/market/orderbook-service.js';
import { fixture } from '../helpers/fixtures.js';
import { makeBook } from '../helpers/market.js';
import { IndodaxPublicRest } from '../../src/exchange/indodax/public-rest.js';
import { routedFetch, noRetry } from '../helpers/fixtures.js';

describe('computeOrderBookMetrics', () => {
  // mid = 1000; ±1% = [990, 1010]; ±2% = [980, 1020]
  const book = makeBook(
    [[999, '2'], [995, '1'], [985, '4'], [900, '100']],
    [[1001, '1'], [1008, '1'], [1015, '2'], [1500, '100']],
  );
  const m = computeOrderBookMetrics(book, [1, 2])!;

  it('computes spread in IDR and percent of mid', () => {
    expect(m.bestBid.toFixed()).toBe('999');
    expect(m.bestAsk.toFixed()).toBe('1001');
    expect(m.mid.toFixed()).toBe('1000');
    expect(m.spreadIdr.toFixed()).toBe('2');
    expect(m.spreadPct.toFixed()).toBe('0.2');
    expect(m.crossed).toBe(false);
  });

  it('computes depth and imbalance inside ±1%', () => {
    const b1 = m.bands[0]!;
    expect(b1.pct).toBe(1);
    expect(b1.bidVolumeBase.toFixed()).toBe('3');
    expect(b1.askVolumeBase.toFixed()).toBe('2');
    expect(b1.bidValueIdr.toFixed()).toBe('2993'); // 999*2 + 995*1
    expect(b1.askValueIdr.toFixed()).toBe('2009'); // 1001 + 1008
    // (2993 − 2009) / (2993 + 2009)
    expect(b1.imbalance!.toDecimalPlaces(6).toFixed()).toBe('0.196721');
    expect(b1.truncated).toBe(false);
  });

  it('computes depth and imbalance inside ±2%', () => {
    const b2 = m.bands[1]!;
    expect(b2.bidValueIdr.toFixed()).toBe('6933'); // + 985*4
    expect(b2.askValueIdr.toFixed()).toBe('4039'); // + 1015*2
    expect(b2.imbalance!.toDecimalPlaces(6).toFixed()).toBe('0.263762');
  });

  it('flags a band as truncated when the fetched book ends inside it', () => {
    const shallow = makeBook([[999, '1'], [995, '1']], [[1001, '1'], [1500, '1']]);
    expect(computeOrderBookMetrics(shallow, [1])!.bands[0]!.truncated).toBe(true);
  });

  it('detects a crossed book and returns null for an empty side', () => {
    expect(computeOrderBookMetrics(makeBook([[1002, '1']], [[1001, '1']]), [1])!.crossed).toBe(true);
    expect(computeOrderBookMetrics(makeBook([], [[1001, '1']]), [1])).toBeNull();
  });

  it('works on a real recorded QNT order book', async () => {
    const client = new IndodaxPublicRest('https://indodax.com', {
      fetchFn: routedFetch({ '/api/depth/qntidr': { body: fixture('depth-qntidr.json') } }),
      retry: noRetry,
    });
    const real = computeOrderBookMetrics(await client.getOrderBook('qnt_idr'), [1, 2])!;
    expect(real.spreadIdr.gt(0)).toBe(true);
    expect(real.spreadPct.gt(0) && real.spreadPct.lt(5)).toBe(true);
    for (const band of real.bands) {
      expect(band.imbalance!.abs().lte(1)).toBe(true);
      expect(band.truncated).toBe(false);
    }
  });
});
