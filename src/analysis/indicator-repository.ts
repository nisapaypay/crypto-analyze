import type { Dec } from '../app/decimal.js';
import type { PrismaClient } from '../app/database/prisma.js';
import type { Timeframe } from '../market/types.js';
import { toJsonSafe, type TechnicalAnalysis, type TrendAnalysis } from './types.js';

/** One stored row: indicator values for one timeframe at one final candle. */
export interface IndicatorRecord {
  pair: string;
  timeframe: Timeframe;
  candleOpenTime: Date;
  windowStart: Date;
  windowSize: number;
  engineVersion: string;
  computedAt: Date;
  marketSnapshotId: bigint | null;
  qualityStatus: 'OK' | 'DEGRADED' | 'UNAVAILABLE';
  values: Record<string, string | null>;
  zeroVolumeCount20: number | null;
  supports: unknown;
  resistances: unknown;
  interpretation: unknown;
  issues: unknown;
}

export interface IndicatorRepository {
  /** Insert or update by (pair, timeframe, candleOpenTime, engineVersion). */
  upsert(records: IndicatorRecord[]): Promise<void>;
  find(pair: string, timeframe: Timeframe, candleOpenTime: Date, engineVersion: string): Promise<IndicatorRecord | null>;
}

/** Derived values are rounded to the column scale on purpose (12 decimals). */
const round = (d: Dec | null | undefined) => (d ? d.toDecimalPlaces(12).toFixed() : null);

function trendValues(t: TrendAnalysis) {
  return {
    close: round(t.close),
    ema9: round(t.ema9.value),
    ema20: round(t.ema20.value),
    ema50: round(t.ema50.value),
    rsi14: round(t.rsi14.value),
  };
}

/** Build the rows to store: the main (15m) timeframe and the trend (1H) timeframe. */
export function toIndicatorRecords(a: TechnicalAnalysis, marketSnapshotId: bigint | null): IndicatorRecord[] {
  if (a.status === 'UNAVAILABLE' || !a.main) return [];
  const records: IndicatorRecord[] = [];
  const common = { pair: a.pair, engineVersion: a.engineVersion, computedAt: a.computedAt, marketSnapshotId, qualityStatus: a.status };

  const m = a.main;
  if (m.lastCandleOpen && m.windowStart) {
    const v = a.volatility;
    const vol = a.volume?.stats ?? null;
    records.push({
      ...common,
      timeframe: m.timeframe,
      candleOpenTime: m.lastCandleOpen,
      windowStart: m.windowStart,
      windowSize: m.candleCount,
      values: {
        ...trendValues(m),
        atr14: round(v?.atr14.value),
        atr14Traded: round(v?.atr14Traded.value),
        atr14Pct: round(v?.atr14Pct),
        volumeLast: round(vol?.current),
        volumeMa20: round(vol?.ma),
        volumeMa20Traded: round(vol?.maTraded),
        volumeRatio: round(vol?.ratio),
        volumeRatioTraded: round(vol?.ratioTraded),
      },
      zeroVolumeCount20: vol?.zeroCount ?? null,
      supports: toJsonSafe(a.levels?.supports ?? []),
      resistances: toJsonSafe(a.levels?.resistances ?? []),
      interpretation: toJsonSafe({ trend: m, volatility: v, volume: a.volume && { ratio: a.volume.ratio, label: a.volume.label }, levels: a.levels && { reliability: a.levels.reliability, notes: a.levels.notes, inside: a.levels.inside, pivotCount: a.levels.pivotCount } }),
      issues: toJsonSafe({ dataWarnings: a.dataWarnings }),
    });
  }

  const t = a.trend;
  if (t && !t.unavailableReason && t.lastCandleOpen && t.windowStart) {
    records.push({
      ...common,
      timeframe: t.timeframe,
      candleOpenTime: t.lastCandleOpen,
      windowStart: t.windowStart,
      windowSize: t.candleCount,
      values: trendValues(t),
      zeroVolumeCount20: null,
      supports: null,
      resistances: null,
      interpretation: toJsonSafe({ trend: t }),
      issues: toJsonSafe({ dataWarnings: a.dataWarnings }),
    });
  }
  return records;
}

export class PrismaIndicatorRepository implements IndicatorRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(records: IndicatorRecord[]): Promise<void> {
    await this.prisma.$transaction(
      records.map((r) => {
        const data = {
          pair: r.pair,
          timeframe: r.timeframe,
          candleOpenTime: r.candleOpenTime,
          windowStart: r.windowStart,
          windowSize: r.windowSize,
          engineVersion: r.engineVersion,
          computedAt: r.computedAt,
          marketSnapshotId: r.marketSnapshotId,
          qualityStatus: r.qualityStatus,
          ...r.values,
          zeroVolumeCount20: r.zeroVolumeCount20,
          supports: r.supports as object,
          resistances: r.resistances as object,
          interpretation: r.interpretation as object,
          issues: r.issues as object,
        };
        return this.prisma.indicatorSnapshot.upsert({
          where: {
            pair_timeframe_candleOpenTime_engineVersion: {
              pair: r.pair,
              timeframe: r.timeframe,
              candleOpenTime: r.candleOpenTime,
              engineVersion: r.engineVersion,
            },
          },
          create: data,
          update: data,
        });
      }),
    );
  }

  async find(pair: string, timeframe: Timeframe, candleOpenTime: Date, engineVersion: string): Promise<IndicatorRecord | null> {
    const row = await this.prisma.indicatorSnapshot.findUnique({
      where: { pair_timeframe_candleOpenTime_engineVersion: { pair, timeframe, candleOpenTime, engineVersion } },
    });
    if (!row) return null;
    const dec = (d: { toString(): string } | null) => (d === null ? null : d.toString());
    return {
      pair: row.pair,
      timeframe: row.timeframe as Timeframe,
      candleOpenTime: row.candleOpenTime,
      windowStart: row.windowStart,
      windowSize: row.windowSize,
      engineVersion: row.engineVersion,
      computedAt: row.computedAt,
      marketSnapshotId: row.marketSnapshotId,
      qualityStatus: row.qualityStatus,
      values: {
        close: dec(row.close),
        ema9: dec(row.ema9),
        ema20: dec(row.ema20),
        ema50: dec(row.ema50),
        rsi14: dec(row.rsi14),
        atr14: dec(row.atr14),
        atr14Traded: dec(row.atr14Traded),
        atr14Pct: dec(row.atr14Pct),
        volumeLast: dec(row.volumeLast),
        volumeMa20: dec(row.volumeMa20),
        volumeMa20Traded: dec(row.volumeMa20Traded),
        volumeRatio: dec(row.volumeRatio),
        volumeRatioTraded: dec(row.volumeRatioTraded),
      },
      zeroVolumeCount20: row.zeroVolumeCount20,
      supports: row.supports,
      resistances: row.resistances,
      interpretation: row.interpretation,
      issues: row.issues,
    };
  }
}

export class InMemoryIndicatorRepository implements IndicatorRepository {
  readonly rows = new Map<string, IndicatorRecord>();
  private key = (pair: string, tf: string, t: Date, v: string) => `${pair}|${tf}|${t.getTime()}|${v}`;

  async upsert(records: IndicatorRecord[]): Promise<void> {
    for (const r of records) this.rows.set(this.key(r.pair, r.timeframe, r.candleOpenTime, r.engineVersion), r);
  }

  async find(pair: string, timeframe: Timeframe, candleOpenTime: Date, engineVersion: string): Promise<IndicatorRecord | null> {
    return this.rows.get(this.key(pair, timeframe, candleOpenTime, engineVersion)) ?? null;
  }
}
