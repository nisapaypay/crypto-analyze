import { describe, expect, it } from 'vitest';
import { summarizeTrades } from '../../src/market/trade-activity.js';
import { makeTrade, NOW } from '../helpers/market.js';

describe('summarizeTrades', () => {
  it('summarizes buyer/seller activity inside the window', () => {
    const trades = [
      makeTrade(30, 'buy', 1000, '2', '144115188260077793'),
      makeTrade(600, 'sell', 1000, '1', '144115188260077792'),
      makeTrade(7200, 'buy', 1000, '50', '144115188260077791'), // outside 60 min
    ];
    const a = summarizeTrades(trades, NOW, 60);
    expect(a).toMatchObject({ count: 2, buyCount: 1, sellCount: 1, newestTradeAgeSec: 30, newestTradeId: '144115188260077793' });
    expect(a.buyValueIdr.toFixed()).toBe('2000');
    expect(a.sellValueIdr.toFixed()).toBe('1000');
    expect(a.buyRatio!.toDecimalPlaces(4).toFixed()).toBe('0.6667');
  });

  it('handles a quiet market', () => {
    const a = summarizeTrades([makeTrade(9000, 'sell', 1000, '1')], NOW, 60);
    expect(a.count).toBe(0);
    expect(a.buyRatio).toBeNull();
    expect(a.newestTradeAgeSec).toBe(9000);
    expect(summarizeTrades([], NOW, 60).newestTradeId).toBeNull();
  });
});
