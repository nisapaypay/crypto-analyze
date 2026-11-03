import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { findEntry, findExit, type PlannedOrder } from '../../src/backtest/fill-model.js';
import type { Candle } from '../../src/market/types.js';

const order: PlannedOrder = { entryMax: new Dec(100), stop: new Dec(95), takeProfit: new Dec(110), quantity: new Dec(2) };
const bt = { requireVolumeForQuantity: true, inclusive: false };

function c(o: number, h: number, l: number, cl: number, v = 10): Candle {
  return { pair: 'x_idr', timeframe: '15', openTime: new Date(0), open: new Dec(o), high: new Dec(h), low: new Dec(l), close: new Dec(cl), volume: new Dec(v) };
}

describe('entry fills (always estimates)', () => {
  it('fills at min(open, entryMax) only when price trades strictly below the limit', () => {
    expect(findEntry([c(102, 103, 100, 101)], order, bt)).toBeNull(); // touched exactly: queue unknown → no fill
    expect(findEntry([c(102, 103, 99, 101)], order, bt)).toMatchObject({ kind: 'normal', fillPrice: new Dec(100) });
    expect(findEntry([c(98, 99, 97, 98)], order, bt)).toMatchObject({ kind: 'normal', fillPrice: new Dec(98) });
  });

  it('zero-volume candles and candles with volume below the order size never fill', () => {
    expect(findEntry([c(99, 99, 99, 99, 0)], order, bt)).toBeNull();
    expect(findEntry([c(99, 99, 98, 99, 1)], order, bt)).toBeNull();
  });

  it('GAP THROUGH THE STOP BEFORE ENTRY: filled at the open and stopped out immediately', () => {
    const f = findEntry([c(93, 94, 90, 92)], order, bt);
    expect(f).toMatchObject({ kind: 'gap_sebelum_entry', fillPrice: new Dec(93), immediateExit: new Dec(93) });
  });

  it('entry and stop in the same candle: assumed filled then stopped (pessimistic)', () => {
    const f = findEntry([c(101, 102, 94, 97)], order, bt);
    expect(f).toMatchObject({ kind: 'sl_di_candle_entry', fillPrice: new Dec(100), immediateExit: new Dec(95) });
  });

  it('lifecycle mode is more conservative (touch counts as a possible fill)', () => {
    expect(findEntry([c(102, 103, 100, 101, 1)], order, { requireVolumeForQuantity: false, inclusive: true })).not.toBeNull();
  });
});

describe('exits', () => {
  it('stop wins when stop and target are touched in the same candle', () => {
    expect(findExit([c(100, 111, 94, 105)], order, 48)).toMatchObject({ reason: 'sl', price: new Dec(95), stopType: true });
  });

  it('gap below the stop exits at the open (loss larger than planned)', () => {
    expect(findExit([c(90, 92, 88, 91)], order, 48)).toMatchObject({ reason: 'gap_sl', price: new Dec(90) });
  });

  it('gap above the target exits at the target (no positive slippage); needs high strictly above TP', () => {
    expect(findExit([c(115, 118, 114, 116)], order, 48)).toMatchObject({ reason: 'tp', price: new Dec(110) });
    expect(findExit([c(105, 110, 104, 109)], order, 48)).toBeNull();
  });

  it('time stop after N candles at the close; zero-volume candles cannot exit', () => {
    const candles = [c(101, 102, 100, 101, 0), c(101, 102, 100, 101), c(101, 103, 100, 102)];
    expect(findExit(candles, order, 3)).toMatchObject({ reason: 'waktu', price: new Dec(102), index: 2 });
    expect(findExit([c(90, 90, 90, 90, 0)], order, 48)).toBeNull();
  });
});
