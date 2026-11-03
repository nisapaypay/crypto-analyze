import { Decimal } from 'decimal.js';
import type { Dec } from '../app/decimal.js';
import type { Pressure } from '../indicators/orderbook-pressure.js';
import type { LevelDistance, Zone } from '../indicators/support-resistance.js';
import type { VolumeStats } from '../indicators/volume.js';
import type { QualityStatus } from '../market/market-validator.js';
import type { Timeframe } from '../market/types.js';

/**
 * Every indicator carries its own reliability: market data being OK does not
 * make every indicator reliable (e.g. volume ratio on an illiquid pair).
 */
export type Reliability = 'andal' | 'kurang_andal' | 'tidak_tersedia';

export interface Reading<T> {
  value: T | null;
  reliability: Reliability;
  /** Why the reading is unavailable or less reliable. */
  notes: string[];
}

export type EmaStack = 'naik' | 'turun' | 'campuran';

export interface TrendAnalysis {
  timeframe: Timeframe;
  /** Set when the whole timeframe could not be analysed. */
  unavailableReason: string | null;
  candleCount: number;
  windowStart: Date | null;
  lastCandleOpen: Date | null;
  /** Close of the last final candle (confirmed). */
  close: Dec | null;
  ema9: Reading<Dec>;
  ema20: Reading<Dec>;
  ema50: Reading<Dec>;
  stack: Reading<EmaStack>;
  closeVsEma20Pct: Dec | null;
  closeVsEma50Pct: Dec | null;
  ema20SlopePct: Reading<Dec>;
  crossover: { direction: 'ke_atas' | 'ke_bawah'; candlesAgo: number } | null;
  rsi14: Reading<Dec>;
  /** Descriptive label only — never a trading instruction. */
  rsiLabel: string | null;
}

export interface VolatilityAnalysis {
  atr14: Reading<Dec>;
  atr14Pct: Dec | null;
  /** ATR over traded candles only (zero-volume candles skipped). */
  atr14Traded: Reading<Dec>;
  zeroVolumeCount: number;
}

export interface VolumeAnalysis {
  stats: VolumeStats | null;
  ratio: Reading<Dec>;
  label: string | null;
}

export interface OrderBookAnalysis {
  reliability: Reliability;
  notes: string[];
  bands: { pct: number; imbalance: Dec | null; pressure: Pressure | null }[];
  tradeBuyRatio: Dec | null;
  tradeFlow: Pressure | null;
  /** False when order book and trade flow point in opposite directions. */
  consistent: boolean | null;
}

export interface LevelsAnalysis {
  reliability: Reliability;
  notes: string[];
  /** Reference price the zones are measured from (last final close). */
  reference: Dec | null;
  supports: LevelDistance[];
  resistances: LevelDistance[];
  inside: Zone[];
  pivotCount: number;
  rangeHigh: Dec | null;
  rangeLow: Dec | null;
  /** Live (unconfirmed) 24 h high/low from the ticker. */
  high24h: Dec | null;
  low24h: Dec | null;
}

export interface TechnicalAnalysis {
  pair: string;
  engineVersion: string;
  computedAt: Date;
  /** Data-quality status from Milestone 2. UNAVAILABLE → no indicators. */
  status: QualityStatus;
  unavailableReasons: string[];
  dataWarnings: string[];
  /** Ticker last price: live, unconfirmed, never used by candle indicators. */
  livePrice: Dec | null;
  pendingCandleOpen: Date | null;
  main: TrendAnalysis | null;
  trend: TrendAnalysis | null;
  volatility: VolatilityAnalysis | null;
  volume: VolumeAnalysis | null;
  orderBook: OrderBookAnalysis | null;
  levels: LevelsAnalysis | null;
}

/** JSON-safe deep copy: decimals → exact strings, dates → ISO strings. */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Decimal.isDecimal(value)) return (value as Dec).toFixed();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}
