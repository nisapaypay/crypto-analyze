import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { buyCostRate, resolveCosts, roundTripCostPct, sellCostRate, sellProceeds } from '../../src/risk/costs.js';
import { entryRange } from '../../src/risk/entry-range.js';
import { sizePosition, type SizingInput } from '../../src/risk/position-sizing.js';
import { tradePnl } from '../../src/risk/pnl.js';
import { sellSlippagePct } from '../../src/risk/slippage.js';
import { stopLoss } from '../../src/risk/stop-loss.js';
import { takeProfit } from '../../src/risk/take-profit.js';
import { ceilToStep, floorToStep } from '../../src/risk/ticks.js';
import { STRATEGY_DEFAULTS as C } from '../../src/strategy/config.js';

const d = (v: string | number) => new Dec(v);

describe('cost assumptions', () => {
  it('defaults: 0,20% fee + 0,11% tax per side, unverified, separate parameters', () => {
    const c = resolveCosts();
    expect([c.buyFeePct, c.sellFeePct, c.buyTaxPct, c.sellTaxPct].map((x) => x.toFixed())).toEqual(['0.2', '0.2', '0.11', '0.11']);
    expect(c.verified).toBe(false);
    expect(buyCostRate(c).toFixed()).toBe('0.0031');
    expect(sellCostRate(c).toFixed()).toBe('0.0031');
    expect(roundTripCostPct(c).toFixed()).toBe('0.77');
  });

  it('every parameter is configurable, including tax (no hard-coded rate)', () => {
    const c = resolveCosts({ buyTaxPct: '0', sellTaxPct: '0.21', buyFeePct: '0.1', stopSlippagePct: '0.3', verified: true });
    expect(buyCostRate(c).toFixed()).toBe('0.001');
    expect(sellCostRate(c).toFixed()).toBe('0.0041');
    expect(roundTripCostPct(c).toFixed()).toBe('0.81');
    expect(c.verified).toBe(true);
  });

  it('itemised sell: slippage, fee and tax on the slipped proceeds', () => {
    const r = sellProceeds(d(2), d(1000), d('0.15'), resolveCosts());
    expect(r.fillPrice.toFixed()).toBe('998.5');
    expect(r.slippage.toFixed()).toBe('3');
    expect(r.fee.toFixed()).toBe('3.994');
    expect(r.tax.toFixed()).toBe('2.1967');
    expect(r.net.toFixed()).toBe('1990.8093');
  });

  it('trade P/L matches sizing formulas (fees both sides, never gross as net)', () => {
    const p = tradePnl(d(1), d(1000), d(1100), d(0), resolveCosts());
    expect(p.grossPnl.toFixed()).toBe('100');
    expect(p.fees.toFixed()).toBe('4.2');
    expect(p.taxes.toFixed()).toBe('2.31');
    expect(p.netPnl.toFixed()).toBe('93.49');
  });
});

describe('ticks and entry range', () => {
  it('rounds to the pair tick', () => {
    expect(floorToStep(d('1234.9'), d(1)).toFixed()).toBe('1234');
    expect(ceilToStep(d('1234.1'), d(1)).toFixed()).toBe('1235');
    expect(floorToStep(d('0.123456789'), d('0.00000001')).toFixed()).toBe('0.12345678');
    expect(floorToStep(d('5.5'), null).toFixed()).toBe('5.5');
  });

  it('entry max never above the best ask; width 0,25 ATR', () => {
    expect(entryRange(d(3_580_000), d(3_578_000), d(30_000), d(1), 0.25)).toEqual({ max: d(3_580_000), min: d(3_572_500) });
    // Price moved up since the candle closed: do not chase above close + 0,25 ATR.
    const r = entryRange(d(3_700_000), d(3_578_000), d(30_000), d(1), 0.25);
    expect(r.max.toFixed()).toBe('3585500');
  });
});

describe('stop loss', () => {
  const tick = d(1);

  it('ATR stop when no support is below the entry', () => {
    const r = stopLoss(d(10_000), d(100), d(5), tick, [], C.stop);
    expect(r.ok && r.price.toFixed()).toBe('9850');
    expect(r.ok && r.method).toBe('atr');
  });

  it('takes the further (lower) of structural and ATR stops', () => {
    const near = stopLoss(d(10_000), d(100), d(5), tick, [d(9_950)], C.stop); // structural 9925 is closer than ATR 9850
    expect(near.ok && near.price.toFixed()).toBe('9850');
    const far = stopLoss(d(10_000), d(100), d(5), tick, [d(9_840)], C.stop); // structural 9815 is further
    expect(far.ok && far.price.toFixed()).toBe('9815');
    expect(far.ok && far.method).toBe('struktural');
  });

  it('never too close: minimum max(1 ATR, 3 spreads, 5 ticks)', () => {
    const cfg = { ...C.stop, atrMultiple: 0.5 };
    const r = stopLoss(d(10_000), d(100), d(40), tick, [], cfg); // 3 × 40 = 120 > 1 ATR
    expect(r.ok && r.price.toFixed()).toBe('9880');
    expect(r.ok && r.method).toBe('jarak_minimum');
    const ticks = stopLoss(d(100), d(2), d(1), tick, [], C.stop); // 5 ticks (2,5 ATR) dominate
    expect(ticks.ok && ticks.price.toFixed()).toBe('95');
  });

  it('rejects stops further than 3 ATR', () => {
    const r = stopLoss(d(10_000), d(100), d(5), tick, [d(9_600)], C.stop);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('stop terlalu jauh');
  });

  it('rejects a missing ATR', () => {
    expect(stopLoss(d(10_000), d(0), d(5), tick, [], C.stop).ok).toBe(false);
  });
});

describe('take profit', () => {
  it('rejects when the nearest resistance leaves no room above the entry', () => {
    const r = takeProfit(d(10_000), d(9_850), d(100), d(1), [d(10_005)], C.takeProfit);
    expect(r.ok).toBe(false);
  });

  it('ignores resistance below the entry', () => {
    const r = takeProfit(d(10_000), d(9_850), d(100), d(1), [d(9_990)], C.takeProfit);
    expect(r.ok && r.price.toFixed()).toBe('10450');
  });
});

describe('position sizing rules', () => {
  const base = (o: Partial<SizingInput> = {}): SizingInput => ({
    entry: d(10_000),
    stop: d(9_800),
    takeProfit: d(10_700),
    costs: resolveCosts(),
    riskBudget: d(25_000),
    capital: d(5_000_000),
    maxAllocPct: d(50),
    quantityIncrement: d('0.00000001'),
    minOrderIdr: d(10_000),
    minOrderBase: null,
    liquidity: { askDepthBase: null, volumeIdr24h: null, depthShare: 0.5, volumeShare: 0.01 },
    bids: null,
    ...o,
  });

  it('caps the position at 50% of capital (tight stop)', () => {
    const r = sizePosition(base({ stop: d(9_990), takeProfit: d(10_100) }));
    expect(r.ok && r.cappedBy).toBe('alokasi');
    expect(r.ok && r.positionValue.lte(2_500_000)).toBe(true);
    expect(r.ok && r.atStop.netLoss.lt(25_000)).toBe(true);
  });

  it('caps by liquidity: 50% of ask depth ±1% and 1% of 24h IDR volume', () => {
    const depth = sizePosition(base({ liquidity: { askDepthBase: d(10), volumeIdr24h: null, depthShare: 0.5, volumeShare: 0.01 } }));
    expect(depth.ok && depth.quantity.toFixed()).toBe('5');
    expect(depth.ok && depth.cappedBy).toBe('likuiditas');
    const vol = sizePosition(base({ liquidity: { askDepthBase: null, volumeIdr24h: d(3_000_000), depthShare: 0.5, volumeShare: 0.01 } }));
    expect(vol.ok && vol.quantity.toFixed()).toBe('3');
  });

  it('notes when liquidity cannot be assessed', () => {
    const r = sizePosition(base());
    expect(r.ok && r.notes.join(' ')).toContain('batas likuiditas order book tidak diterapkan');
  });

  it('rejects positions below the exchange minimum order', () => {
    const r = sizePosition(base({ riskBudget: d(1), minOrderIdr: d(10_000) }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe('min_order');
    const base2 = sizePosition(base({ minOrderBase: d(1_000) }));
    expect(!base2.ok && base2.reason).toContain('jumlah koin di bawah minimum');
  });

  it('order book slippage raises the stop slippage and lowers the quantity', () => {
    const thin = [
      { price: d(9_995), volume: d(1) },
      { price: d(9_900), volume: d(1_000) },
    ];
    const r = sizePosition(base({ bids: thin }));
    const plain = sizePosition(base());
    expect(r.ok && r.stopSlippagePct.gt('0.15')).toBe(true);
    expect(r.ok && plain.ok && r.quantity.lt(plain.quantity)).toBe(true);
    expect(r.ok && r.atStop.netLoss.lte(25_000)).toBe(true);
  });

  it('rejects when the visible bids cannot absorb the stop exit', () => {
    const r = sizePosition(base({ bids: [{ price: d(9_995), volume: d('0.01') }] }));
    expect(!r.ok && r.kind).toBe('liquidity');
  });

  it('rejects invalid price order', () => {
    expect(sizePosition(base({ stop: d(10_000) })).ok).toBe(false);
    expect(sizePosition(base({ takeProfit: d(9_000) })).ok).toBe(false);
  });

  it('slippage estimate walks the bid book', () => {
    const r = sellSlippagePct([{ price: d(100), volume: d(1) }, { price: d(90), volume: d(1) }], d(2));
    expect(r).toEqual({ pct: d(5), filled: true });
    expect(sellSlippagePct([{ price: d(100), volume: d(1) }], d(2)).filled).toBe(false);
  });
});
