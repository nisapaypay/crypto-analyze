import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { startOfDayInZone, withinActiveHours } from '../../src/app/time.js';
import type { Candle } from '../../src/market/types.js';
import { resolveCosts } from '../../src/risk/costs.js';
import { computeRiskState, holdsPositionSlot, isReservationHeld, UnavailableJournalLedger } from '../../src/risk/risk-ledger.js';
import { advanceLifecycle, type LifecycleSignal } from '../../src/strategy/lifecycle.js';
import { DAY_START, ledgerSignal, LIMITS, UNAVAILABLE } from '../helpers/strategy.js';

const TF = 900_000;
const ISSUE_CANDLE = new Date('2026-11-02T04:00:00Z');
const costs = resolveCosts();

/** Candles after the issue candle: [open, high, low, close, volume]. */
function after(rows: [number, number, number, number, number?][]): Candle[] {
  return rows.map(([o, h, l, c, v], i) => ({
    pair: 'qnt_idr',
    timeframe: '15',
    openTime: new Date(ISSUE_CANDLE.getTime() + (i + 1) * TF),
    open: new Dec(o),
    high: new Dec(h),
    low: new Dec(l),
    close: new Dec(c),
    volume: new Dec(v ?? 1),
  }));
}

const signal = (lifecycle: LifecycleSignal['lifecycle'] = 'ACTIVE'): LifecycleSignal => ({
  lifecycle,
  candleOpenTime: ISSUE_CANDLE,
  expiresAt: new Date(ISSUE_CANDLE.getTime() + 3 * TF), // 2 further candles
  order: { entryMax: new Dec(100), stop: new Dec(95), takeProfit: new Dec(110), quantity: new Dec(10) },
});

describe('acceptance #1: the risk ledger never double-counts and releases consistently', () => {
  it('ACTIVE → POSSIBLY_FILLED keeps exactly one reservation', () => {
    const active = ledgerSignal({ id: 7, lifecycle: 'ACTIVE' });
    const filled = { ...active, lifecycle: 'POSSIBLY_FILLED' as const };
    const before = computeRiskState([active], LIMITS, UNAVAILABLE, DAY_START);
    const afterTransition = computeRiskState([filled], LIMITS, UNAVAILABLE, DAY_START);
    expect(before.reservedRiskToday.toFixed()).toBe('25000');
    expect(afterTransition.reservedRiskToday.toFixed()).toBe('25000');
    expect(afterTransition.recommendationsToday).toBe(1);
  });

  it('the same signal seen twice (old + new state in one list) still counts once', () => {
    const s = computeRiskState(
      [ledgerSignal({ id: 7, lifecycle: 'ACTIVE' }), ledgerSignal({ id: 7, lifecycle: 'POSSIBLY_FILLED' })],
      LIMITS,
      UNAVAILABLE,
      DAY_START,
    );
    expect(s.reservedRiskToday.toFixed()).toBe('25000');
    expect(s.recommendationsToday).toBe(1);
  });

  it('EXPIRED_UNFILLED releases the reservation but still counts the recommendation', () => {
    const s = computeRiskState([ledgerSignal({ id: 1, lifecycle: 'EXPIRED_UNFILLED' })], LIMITS, UNAVAILABLE, DAY_START);
    expect(s.reservedRiskToday.toFixed()).toBe('0');
    expect(s.recommendationsToday).toBe(1);
    expect(s.slotTaken).toBe(false);
  });

  it('reservation rules per state are consistent', () => {
    const states = ['ACTIVE', 'POSSIBLY_FILLED', 'HYPO_CLOSED', 'EXPIRED_UNFILLED'] as const;
    expect(states.map((l) => isReservationHeld(ledgerSignal({ id: 1, lifecycle: l })))).toEqual([true, true, true, false]);
    expect(states.map((l) => holdsPositionSlot(ledgerSignal({ id: 1, lifecycle: l })))).toEqual([true, true, false, false]);
    // M6 hooks: journal NOT_TAKEN or a closed journal trade releases it.
    expect(isReservationHeld(ledgerSignal({ id: 1, execution: 'NOT_TAKEN' }))).toBe(false);
    expect(isReservationHeld(ledgerSignal({ id: 1, journalClosed: true }))).toBe(false);
  });

  it('nothing assumes execution: execution stays UNKNOWN and realized loss is unavailable', async () => {
    expect(await new UnavailableJournalLedger().realizedLossSince()).toEqual({
      available: false,
      reason: 'jurnal transaksi baru tersedia di Milestone 6',
    });
    const s = computeRiskState([ledgerSignal({ id: 1, lifecycle: 'HYPO_CLOSED' })], LIMITS, UNAVAILABLE, DAY_START);
    expect(s.realizedLossEnforced).toBe(false);
  });

  it('an open recommendation from yesterday still holds the slot but not today’s reserved risk', () => {
    const y = ledgerSignal({ id: 3, createdAt: new Date('2026-11-01T15:00:00Z'), lifecycle: 'POSSIBLY_FILLED' });
    const s = computeRiskState([y], LIMITS, UNAVAILABLE, DAY_START);
    expect(s.slotTaken).toBe(true);
    expect(s.reservedRiskToday.toFixed()).toBe('0');
  });
});

describe('lifecycle from observed market data', () => {
  it('stays ACTIVE while valid and no trade entered the range', () => {
    expect(advanceLifecycle(signal(), after([[102, 104, 101, 103]]), TF, 48, costs)).toBeNull();
  });

  it('EXPIRED_UNFILLED only when every candle of the validity window is known', () => {
    const candles = after([[102, 104, 101, 103], [103, 105, 102, 104]]);
    expect(advanceLifecycle(signal(), candles, TF, 48, costs)).toMatchObject({ lifecycle: 'EXPIRED_UNFILLED' });
    // A missing candle keeps the conservative state (lock held).
    expect(advanceLifecycle(signal(), candles.slice(0, 1), TF, 48, costs)).toBeNull();
  });

  it('zero-volume candles inside the range are not trades', () => {
    const candles = after([[102, 102, 99, 102, 0], [102, 104, 101, 103]]);
    expect(advanceLifecycle(signal(), candles, TF, 48, costs)).toMatchObject({ lifecycle: 'EXPIRED_UNFILLED' });
  });

  it('a trade at or below entry max → POSSIBLY_FILLED (not assumed executed)', () => {
    const u = advanceLifecycle(signal(), after([[101, 102, 100, 101]]), TF, 48, costs);
    expect(u).toMatchObject({ lifecycle: 'POSSIBLY_FILLED', hypo: null });
  });

  it('POSSIBLY_FILLED → HYPO_CLOSED at TP with a labelled hypothetical result', () => {
    const u = advanceLifecycle(signal('POSSIBLY_FILLED'), after([[101, 102, 99, 101], [101, 111, 100, 110]]), TF, 48, costs);
    expect(u?.lifecycle).toBe('HYPO_CLOSED');
    expect(u?.hypo).toMatchObject({ label: 'hipotetis', exitReason: 'tp', exitPrice: '110' });
    expect(u?.hypo?.note).toContain('bukan P/L Anda');
  });

  it('gap below the stop before entry: filled at the open and stopped immediately (hypothetical)', () => {
    const u = advanceLifecycle(signal(), after([[93, 94, 92, 93]]), TF, 48, costs);
    expect(u?.lifecycle).toBe('HYPO_CLOSED');
    expect(u?.hypo).toMatchObject({ entryKind: 'gap_sebelum_entry', entryFill: '93', exitPrice: '93' });
  });

  it('transitions are one-way: terminal states never change', () => {
    const candles = after([[101, 102, 100, 101]]);
    expect(advanceLifecycle(signal('EXPIRED_UNFILLED'), candles, TF, 48, costs)).toBeNull();
    expect(advanceLifecycle(signal('HYPO_CLOSED'), candles, TF, 48, costs)).toBeNull();
  });
});

describe('time helpers (WIB)', () => {
  it('day starts at 00:00 WIB', () => {
    expect(startOfDayInZone(new Date('2026-11-02T16:59:59Z'), 'Asia/Jakarta').toISOString()).toBe('2026-11-01T17:00:00.000Z');
    expect(startOfDayInZone(new Date('2026-11-02T17:00:00Z'), 'Asia/Jakarta').toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });

  it('active hours 09:00–22:00 WIB, end exclusive', () => {
    const at = (iso: string) => withinActiveHours(new Date(iso), 'Asia/Jakarta', '09:00', '22:00');
    expect(at('2026-11-02T01:59:00Z')).toBe(false); // 08:59
    expect(at('2026-11-02T02:00:00Z')).toBe(true); // 09:00
    expect(at('2026-11-02T14:59:00Z')).toBe(true); // 21:59
    expect(at('2026-11-02T15:00:00Z')).toBe(false); // 22:00
  });
});
