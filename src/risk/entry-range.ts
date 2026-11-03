import { Dec } from '../app/decimal.js';
import { ceilToStep, floorToStep } from './ticks.js';

export interface EntryRange {
  /** Upper bound: never above the best ask (do not chase). Risk is sized here (worst case). */
  max: Dec;
  min: Dec;
}

/**
 *   max = floor_tick(min(bestAsk, close + width·ATR))
 *   min = ceil_tick(max − width·ATR)
 */
export function entryRange(bestAsk: Dec, close: Dec, atr: Dec, tick: Dec | null, widthAtr: number): EntryRange {
  const width = atr.times(widthAtr);
  const max = floorToStep(Dec.min(bestAsk, close.plus(width)), tick);
  const min = Dec.min(ceilToStep(max.minus(width), tick), max);
  return { max, min };
}
