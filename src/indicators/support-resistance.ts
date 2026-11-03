import type { Dec } from '../app/decimal.js';
import type { Candle } from '../market/types.js';

export interface Pivot {
  type: 'high' | 'low';
  price: Dec;
  /** Open time of the pivot candle. */
  time: Date;
  index: number;
  /** Open time of the candle that confirmed the pivot (k candles later). */
  confirmedAt: Date;
}

/**
 * Fractal swing pivots. Candle i is a swing high when its high is above the
 * k candles before it and not below the k candles after it (ties go to the
 * earlier candle); swing lows mirror this. Pivots need k candles to the right,
 * so the newest k candles can never be pivots (confirmation lag = k candles).
 *
 * Zero-volume candles are never pivots — no trade happened at that price —
 * but they still occupy their place in time as neighbours.
 */
export function findPivots(candles: Candle[], k: number): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const c = candles[i]!;
    if (c.volume.isZero()) continue;
    const left = candles.slice(i - k, i);
    const right = candles.slice(i + 1, i + 1 + k);
    const confirmedAt = candles[i + k]!.openTime;
    if (left.every((n) => c.high.gt(n.high)) && right.every((n) => c.high.gte(n.high))) {
      pivots.push({ type: 'high', price: c.high, time: c.openTime, index: i, confirmedAt });
    }
    if (left.every((n) => c.low.lt(n.low)) && right.every((n) => c.low.lte(n.low))) {
      pivots.push({ type: 'low', price: c.low, time: c.openTime, index: i, confirmedAt });
    }
  }
  return pivots;
}

export interface Zone {
  low: Dec;
  high: Dec;
  /** Number of pivots in the zone. */
  touches: number;
  swingHighs: number;
  swingLows: number;
  firstPivotAt: Date;
  lastPivotAt: Date;
  /** When the most recent pivot in the zone was confirmed. */
  lastConfirmedAt: Date;
  /** Candles between the last confirmation and the newest candle. */
  candlesSinceConfirmed: number;
  /** "baru" if the last pivot was confirmed within `freshCandles`, else "lama". */
  freshness: 'baru' | 'lama';
}

/**
 * Group pivots whose prices lie within `tolerance` of the zone's lowest pivot.
 * Deterministic: pivots are processed in ascending price order.
 * `newestIndex` is the index of the newest candle; a pivot at index i was
 * confirmed at index i + k.
 */
export function clusterZones(pivots: Pivot[], tolerance: Dec, k: number, newestIndex: number, freshCandles: number): Zone[] {
  const sorted = [...pivots].sort((a, b) => a.price.comparedTo(b.price) || a.index - b.index);
  const groups: Pivot[][] = [];
  for (const p of sorted) {
    const current = groups.at(-1);
    if (current && p.price.minus(current[0]!.price).lte(tolerance)) current.push(p);
    else groups.push([p]);
  }
  return groups.map((g) => {
    const last = g.reduce((a, b) => (b.index > a.index ? b : a));
    const first = g.reduce((a, b) => (b.index < a.index ? b : a));
    const candlesSinceConfirmed = newestIndex - (last.index + k);
    return {
      low: g[0]!.price,
      high: g.at(-1)!.price,
      touches: g.length,
      swingHighs: g.filter((p) => p.type === 'high').length,
      swingLows: g.filter((p) => p.type === 'low').length,
      firstPivotAt: first.time,
      lastPivotAt: last.time,
      lastConfirmedAt: last.confirmedAt,
      candlesSinceConfirmed,
      freshness: candlesSinceConfirmed <= freshCandles ? 'baru' : 'lama',
    };
  });
}

export interface LevelDistance {
  zone: Zone;
  /** Price distance from the reference price to the nearest zone edge. */
  distance: Dec;
  distancePct: Dec;
  /** Distance in ATR multiples; null when ATR is unavailable or zero. */
  distanceAtr: Dec | null;
}

export interface SupportResistance {
  supports: LevelDistance[];
  resistances: LevelDistance[];
  /** Zones the reference price currently sits inside. */
  inside: Zone[];
  pivotCount: number;
}

export interface SupportResistanceParams {
  k: number;
  /** Zone tolerance as a multiple of ATR (0.5 = half an ATR). */
  toleranceAtr: number;
  /** A zone is "baru" when its last pivot was confirmed within this many candles. */
  freshCandles: number;
  maxPerSide: number;
}

/** Support/resistance zones around `price`, nearest first. */
export function supportResistance(
  candles: Candle[],
  price: Dec,
  atr: Dec,
  params: SupportResistanceParams,
): SupportResistance {
  const pivots = findPivots(candles, params.k);
  const zones = clusterZones(pivots, atr.times(params.toleranceAtr), params.k, candles.length - 1, params.freshCandles);

  const measure = (zone: Zone, distance: Dec): LevelDistance => ({
    zone,
    distance,
    distancePct: distance.div(price).times(100),
    distanceAtr: atr.isZero() ? null : distance.div(atr),
  });

  const supports = zones
    .filter((z) => z.high.lt(price))
    .map((z) => measure(z, price.minus(z.high)))
    .sort((a, b) => a.distance.comparedTo(b.distance))
    .slice(0, params.maxPerSide);
  const resistances = zones
    .filter((z) => z.low.gt(price))
    .map((z) => measure(z, z.low.minus(price)))
    .sort((a, b) => a.distance.comparedTo(b.distance))
    .slice(0, params.maxPerSide);
  const inside = zones.filter((z) => z.low.lte(price) && z.high.gte(price));

  return { supports, resistances, inside, pivotCount: pivots.length };
}
