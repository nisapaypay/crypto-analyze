import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { resolveCosts } from '../../src/risk/costs.js';
import { sizePosition, type SizingInput } from '../../src/risk/position-sizing.js';
import { computeRiskState } from '../../src/risk/risk-ledger.js';
import { stopLoss } from '../../src/risk/stop-loss.js';
import { takeProfit } from '../../src/risk/take-profit.js';
import { STRATEGY_DEFAULTS as C } from '../../src/strategy/config.js';
import { evaluateStrategy } from '../../src/strategy/strategy-engine.js';
import { DAY_START, engineInput, ledgerSignal, LIMITS, marketCtx, UNAVAILABLE } from '../helpers/strategy.js';

/**
 * Simulations A–D from the approved Milestone 4 plan, recomputed exactly with
 * Decimal. Assumptions: QNT best ask Rp3.580.000, spread Rp5.000, support zone
 * from Rp3.540.000, costs 0,20% fee + 0,11% tax per side, stop slippage 0,15%.
 */
const costs = resolveCosts();
const E = new Dec(3_580_000);
const TICK = new Dec(1);

function plan(atr: string, resistance: string) {
  const A = new Dec(atr);
  const sl = stopLoss(E, A, new Dec(5_000), TICK, [new Dec(3_540_000)], C.stop);
  if (!sl.ok) throw new Error(sl.reason);
  const tp = takeProfit(E, sl.price, A, TICK, [new Dec(resistance)], C.takeProfit);
  if (!tp.ok) throw new Error(tp.reason);
  const input: SizingInput = {
    entry: E,
    stop: sl.price,
    takeProfit: tp.price,
    costs,
    riskBudget: new Dec(25_000),
    capital: new Dec(5_000_000),
    maxAllocPct: new Dec(50),
    quantityIncrement: new Dec('0.00000001'),
    minOrderIdr: new Dec(10_000),
    minOrderBase: new Dec('0.0027'),
    liquidity: { askDepthBase: new Dec(10), volumeIdr24h: new Dec('626978777'), depthShare: 0.5, volumeShare: 0.01 },
    bids: [{ price: new Dec(3_575_000), volume: new Dec(5) }],
  };
  const sizing = sizePosition(input);
  if (!sizing.ok) throw new Error(sizing.reason);
  return { sl, tp, sizing };
}

describe('simulation A — accepted setup (sizing layer, exact)', () => {
  const { sl, tp, sizing: s } = plan('22715', '3760000');

  it('stop loss: structural (support − 0,25 ATR), 2,01 ATR, −1,28%', () => {
    expect(sl.price.toFixed()).toBe('3534321');
    expect(sl.ok && sl.method).toBe('struktural');
    expect(sl.ok && sl.distanceAtr.toFixed(2)).toBe('2.01');
    expect(sl.ok && sl.distancePct.toFixed(2)).toBe('1.28');
  });

  it('take profit: capped at 3R (resistance further away)', () => {
    expect(tp.ok && tp.price.toFixed()).toBe('3717037');
    expect(tp.ok && tp.method).toBe('rr_cap');
  });

  it('quantity 0,34237925 QNT, position ≈ Rp1.225.718 (24,5% modal)', () => {
    expect(s.quantity.toFixed()).toBe('0.34237925');
    expect(s.lossPerCoin.toFixed()).toBe('73018.44200735');
    expect(s.positionValue.toFixed()).toBe('1225717.715');
    expect(s.allocationPct.toFixed(1)).toBe('24.5');
    expect(s.cappedBy).toBe('risiko');
  });

  it('net loss at stop ≤ Rp25.000 and itemised exactly', () => {
    expect(s.atStop.netLoss.toFixed()).toBe('24999.9994106449874875');
    expect(s.atStop.netLoss.lte(25_000)).toBe(true);
    expect(s.buy.fee.toFixed()).toBe('2451.43543');
    expect(s.buy.tax.toFixed()).toBe('1348.2894865');
    expect(s.buy.fee.plus(s.buy.tax).toFixed(0)).toBe('3800');
    expect(s.atStop.grossLoss.toFixed(0)).toBe('15640');
    expect(s.atStop.slippage.toFixed(0)).toBe('1815');
    expect(s.atStop.fee.plus(s.atStop.tax).toFixed(0)).toBe('3746');
    // gross loss + buy costs + stop slippage + sell costs = net loss
    expect(s.atStop.grossLoss.plus(s.buy.fee).plus(s.buy.tax).plus(s.atStop.slippage).plus(s.atStop.fee).plus(s.atStop.tax).toFixed()).toBe(
      s.atStop.netLoss.toFixed(),
    );
  });

  it('net reward Rp39.173,73 · R/R gross 3,00 → net 1,57', () => {
    expect(s.atTarget.netWin.toFixed()).toBe('39173.727710875025');
    expect(s.atTarget.grossWin.toFixed(0)).toBe('46919');
    expect(s.atTarget.fee.plus(s.atTarget.tax).toFixed(0)).toBe('3945');
    expect(s.grossRr.toFixed(2)).toBe('3.00');
    expect(s.netRr.toFixed(2)).toBe('1.57');
    expect(s.netRr.gte(C.minNetRr)).toBe(true);
  });
});

describe('simulation B — resistance too close (rejected)', () => {
  const { tp, sizing: s } = plan('22715', '3660000');

  it('TP capped below resistance: Rp3.657.728, net R/R 0,76 < 1,5', () => {
    expect(tp.ok && tp.price.toFixed()).toBe('3657728');
    expect(tp.ok && tp.method).toBe('resistance');
    expect(s.atTarget.netWin.toFixed()).toBe('18930.5059025336');
    expect(s.grossRr.toFixed(2)).toBe('1.70');
    expect(s.netRr.toFixed(2)).toBe('0.76');
  });

  it('the full engine returns WAIT with the R/R reason', () => {
    const d = evaluateStrategy(engineInput({ scenario: { resistances: [3_660_000] } }));
    expect(d.decision).toBe('WAIT');
    expect(d.gates.find((g) => g.id === 'G11')).toMatchObject({ passed: false });
    expect(d.reasons.join(' ')).toContain('R/R bersih');
  });
});

describe('simulation A in the full engine', () => {
  it('A (ATR 0,63% < round-trip cost 0,77%) is WAIT because of gate G10', () => {
    const d = evaluateStrategy(engineInput({ scenario: { atr: 22_715 } }));
    expect(d.decision).toBe('WAIT');
    expect(d.gates.find((g) => g.id === 'G10')).toMatchObject({ passed: false });
    // The sizing itself is still exactly simulation A.
    expect(d.plan?.sizing.ok && d.plan.sizing.quantity.toFixed()).toBe('0.34237925');
  });

  it("A′ (ATR Rp30.000 = 0,84%) is a BUY_CANDIDATE with exact numbers", () => {
    const d = evaluateStrategy(engineInput());
    expect(d.decision).toBe('BUY_CANDIDATE');
    const p = d.plan!;
    expect(p.entry.min.toFixed()).toBe('3572500');
    expect(p.entry.max.toFixed()).toBe('3580000');
    expect(p.stop.toFixed()).toBe('3532500');
    expect(p.takeProfit.toFixed()).toBe('3722500');
    const s = p.sizing;
    if (!s.ok) throw new Error('sizing');
    expect(s.quantity.toFixed()).toBe('0.33408581');
    expect(s.atStop.netLoss.toFixed()).toBe('24999.99992869921375');
    expect(s.atTarget.netWin.toFixed()).toBe('40044.2768796725');
    expect(s.netRr.toFixed(6)).toBe('1.601771');
    expect(p.expiresAt.toISOString()).toBe('2026-11-02T04:45:00.000Z'); // valid until 2 more 15m candles close
  });
});

describe('simulation C — DOGE: volatility smaller than costs', () => {
  it('ATR Rp4,23 on Rp1.385 (0,31%) < 0,77% → WAIT via G10', () => {
    const input = engineInput({
      scenario: { close: 1_385, atr: '4.23', ema9: 1_383, ema20: 1_380, ema50: 1_370, supports: [1_375], resistances: [1_420] },
      market: marketCtx({ bestBid: new Dec(1_385), bestAsk: new Dec(1_386), bids: [{ price: new Dec(1_385), volume: new Dec(1_000_000) }], askDepthBase1: new Dec(1_000_000) }),
    });
    const d = evaluateStrategy(input);
    expect(d.decision).toBe('WAIT');
    const g10 = d.gates.find((g) => g.id === 'G10')!;
    expect(g10.passed).toBe(false);
    expect(g10.detail).toContain('vs biaya 0,77%');
  });
});

describe('simulation D — daily planned risk and recommendation count (no realized loss in M4)', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 2, h, 0, 0));

  it('after 1 and 2 recommendations the next budget is still Rp25.000', () => {
    const one = computeRiskState([ledgerSignal({ id: 1, createdAt: at(3) })], LIMITS, UNAVAILABLE, DAY_START);
    expect(one.reservedRiskToday.toFixed()).toBe('25000');
    expect(one.remainingDailyRisk.toFixed()).toBe('50000');
    expect(one.nextRiskBudget.toFixed()).toBe('25000');
    const two = computeRiskState([ledgerSignal({ id: 1, createdAt: at(3) }), ledgerSignal({ id: 2, createdAt: at(5), pair: 'xrp_idr' })], LIMITS, UNAVAILABLE, DAY_START);
    expect(two.recommendationsToday).toBe(2);
    expect(two.remainingDailyRisk.toFixed()).toBe('25000');
    expect(two.nextRiskBudget.toFixed()).toBe('25000');
    expect(two.blocks).toEqual([]);
  });

  it('after 3 recommendations: NO_TRADE until 00:00 WIB (count and planned budget exhausted)', () => {
    const three = computeRiskState(
      [1, 2, 3].map((id) => ledgerSignal({ id, createdAt: at(2 + id), lifecycle: 'HYPO_CLOSED' })),
      LIMITS,
      UNAVAILABLE,
      DAY_START,
    );
    expect(three.blocks.map((b) => b.code)).toEqual(['DAILY_RECOMMENDATION_LIMIT', 'DAILY_RISK_BUDGET']);
    const d = evaluateStrategy(engineInput({ risk: three }));
    expect(d.decision).toBe('NO_TRADE');
  });

  it('recommendations count even when they were never executed (execution UNKNOWN)', () => {
    const s = computeRiskState(
      [1, 2, 3].map((id) => ledgerSignal({ id, createdAt: at(2 + id), lifecycle: 'EXPIRED_UNFILLED' })),
      LIMITS,
      UNAVAILABLE,
      DAY_START,
    );
    expect(s.recommendationsToday).toBe(3);
    expect(s.reservedRiskToday.toFixed()).toBe('0'); // expired unfilled: reservation released
    expect(s.blocks.map((b) => b.code)).toEqual(['DAILY_RECOMMENDATION_LIMIT']);
  });

  it('the next day starts clean', () => {
    const nextDay = new Date('2026-11-02T17:00:00Z');
    const s = computeRiskState([1, 2, 3].map((id) => ledgerSignal({ id, createdAt: at(2 + id), lifecycle: 'HYPO_CLOSED' })), LIMITS, UNAVAILABLE, nextDay);
    expect(s.recommendationsToday).toBe(0);
    expect(s.blocks).toEqual([]);
  });

  it('M4 never claims the realized daily loss limit is enforced', () => {
    const s = computeRiskState([], LIMITS, UNAVAILABLE, DAY_START);
    expect(s.realizedLossEnforced).toBe(false);
    expect(s.realizedLoss).toEqual({ available: false, reason: 'jurnal transaksi baru tersedia di Milestone 6' });
  });

  it('M6 path: a known realized loss reduces the remaining budget (e.g. Rp52.000 → next Rp23.000)', () => {
    const s = computeRiskState([], LIMITS, { available: true, amount: new Dec(52_000) }, DAY_START);
    expect(s.realizedLossEnforced).toBe(true);
    expect(s.nextRiskBudget.toFixed()).toBe('23000');
    expect(s.blocks).toEqual([]);
    const hit = computeRiskState([], LIMITS, { available: true, amount: new Dec(75_000) }, DAY_START);
    expect(hit.blocks.map((b) => b.code)).toContain('REALIZED_LOSS_LIMIT');
  });
});
