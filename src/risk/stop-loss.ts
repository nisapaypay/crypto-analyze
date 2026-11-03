import { Dec } from '../app/decimal.js';
import { floorToStep } from './ticks.js';

export interface StopLossParams {
  /** ATR stop: entry − atrMultiple·ATR. */
  atrMultiple: number;
  /** Structural stop: support zone low − bufferAtr·ATR. */
  structuralBufferAtr: number;
  /** Minimum distance = max(minAtr·ATR, minSpreads·spread, minTicks·tick). */
  minAtr: number;
  minSpreads: number;
  minTicks: number;
  /** Maximum distance in ATR; beyond it the setup is rejected. */
  maxAtr: number;
}

export type StopMethod = 'struktural' | 'atr' | 'jarak_minimum';

export type StopLossResult =
  | { ok: true; price: Dec; method: StopMethod; distance: Dec; distanceAtr: Dec; distancePct: Dec }
  | { ok: false; reason: string; price: Dec | null; distanceAtr: Dec | null };

/**
 * Long spot stop loss. Takes the LOWER (further) of the structural and ATR
 * stops so it is never too close, enforces a minimum distance, rounds down
 * to the tick, and rejects stops further than `maxAtr` ATR.
 *
 * `supportLows`: lows of support zones below the entry (any order).
 */
export function stopLoss(
  entry: Dec,
  atr: Dec,
  spread: Dec,
  tick: Dec | null,
  supportLows: Dec[],
  p: StopLossParams,
): StopLossResult {
  if (atr.lte(0)) return { ok: false, reason: 'ATR tidak tersedia', price: null, distanceAtr: null };

  const atrStop = entry.minus(atr.times(p.atrMultiple));
  const below = supportLows.filter((l) => l.lt(entry));
  const nearestSupport = below.length ? Dec.max(...below) : null;
  const structural = nearestSupport ? nearestSupport.minus(atr.times(p.structuralBufferAtr)) : null;

  let price = structural && structural.lt(atrStop) ? structural : atrStop;
  let method: StopMethod = structural && structural.lt(atrStop) ? 'struktural' : 'atr';

  const minDistance = Dec.max(atr.times(p.minAtr), spread.times(p.minSpreads), (tick ?? new Dec(0)).times(p.minTicks));
  if (entry.minus(price).lt(minDistance)) {
    price = entry.minus(minDistance);
    method = 'jarak_minimum';
  }
  price = floorToStep(price, tick);

  const distance = entry.minus(price);
  const distanceAtr = distance.div(atr);
  if (price.lte(0)) return { ok: false, reason: 'stop loss ≤ 0', price, distanceAtr };
  if (distanceAtr.gt(p.maxAtr)) {
    return { ok: false, reason: `stop terlalu jauh (${distanceAtr.toFixed(2)} ATR > ${p.maxAtr} ATR)`, price, distanceAtr };
  }
  return { ok: true, price, method, distance, distanceAtr, distancePct: distance.div(entry).times(100) };
}
