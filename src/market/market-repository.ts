import { Dec, type Dec as DecType } from '../app/decimal.js';
import type { PrismaClient } from '../app/database/prisma.js';
import type { QualityStatus } from './market-validator.js';
import type { Candle, Timeframe } from './types.js';

export interface SnapshotRecord {
  pair: string;
  /** When the data was fetched (local clock). */
  fetchedAt: Date;
  /** Ticker `server_time` reported by Indodax. */
  serverTime: Date | null;
  orderBookAgeSec: number | null;
  lastPrice: DecType;
  bestBid: DecType;
  bestAsk: DecType;
  spreadIdr: DecType;
  spreadPct: DecType;
  high24h: DecType | null;
  low24h: DecType | null;
  volumeBase24h: DecType | null;
  volumeIdr24h: DecType | null;
  orderBookData: Record<string, unknown>;
  tradeActivity: Record<string, unknown> | null;
  qualityStatus: QualityStatus;
  qualityIssues: unknown[];
}

export interface MarketRepository {
  latestCandleOpenTime(pair: string, timeframe: Timeframe): Promise<Date | null>;
  /** Insert or update final candles; idempotent. Returns the number written. */
  upsertCandles(candles: Candle[]): Promise<number>;
  /** Most recent final candles, ascending. */
  loadCandles(pair: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  /** Returns the id of the stored snapshot. */
  saveSnapshot(snapshot: SnapshotRecord): Promise<bigint>;
}

/** Scale of the DECIMAL(38, 12) price/volume columns. */
const DB_SCALE = 12;

/**
 * PostgreSQL silently rounds values beyond the column scale. Refuse instead,
 * so a price or volume is never stored with less precision than received.
 */
function exact(d: DecType, field: string): string {
  if (d.decimalPlaces() > DB_SCALE) {
    throw new Error(`${field} ${d.toFixed()} melebihi ${DB_SCALE} desimal; tidak disimpan agar presisi tidak hilang`);
  }
  return d.toFixed();
}

const exactOrNull = (d: DecType | null, field: string) => (d === null ? null : exact(d, field));

export class PrismaMarketRepository implements MarketRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async latestCandleOpenTime(pair: string, timeframe: Timeframe): Promise<Date | null> {
    const row = await this.prisma.candle.findFirst({
      where: { pair, timeframe },
      orderBy: { openTime: 'desc' },
      select: { openTime: true },
    });
    return row?.openTime ?? null;
  }

  async upsertCandles(candles: Candle[]): Promise<number> {
    if (candles.length === 0) return 0;
    const { pair, timeframe } = candles[0]!;
    const latest = await this.latestCandleOpenTime(pair, timeframe);
    const toRow = (c: Candle) => ({
      pair: c.pair,
      timeframe: c.timeframe,
      openTime: c.openTime,
      open: exact(c.open, 'open'),
      high: exact(c.high, 'high'),
      low: exact(c.low, 'low'),
      close: exact(c.close, 'close'),
      volume: exact(c.volume, 'volume'),
    });

    const fresh = candles.filter((c) => !latest || c.openTime > latest);
    const overlap = candles.filter((c) => latest && c.openTime <= latest);

    await this.prisma.$transaction([
      this.prisma.candle.createMany({ data: fresh.map(toRow), skipDuplicates: true }),
      ...overlap.map((c) =>
        this.prisma.candle.upsert({
          where: { pair_timeframe_openTime: { pair: c.pair, timeframe: c.timeframe, openTime: c.openTime } },
          create: toRow(c),
          update: toRow(c),
        }),
      ),
    ]);
    return candles.length;
  }

  async loadCandles(pair: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const rows = await this.prisma.candle.findMany({
      where: { pair, timeframe },
      orderBy: { openTime: 'desc' },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      pair: r.pair,
      timeframe,
      openTime: r.openTime,
      open: new Dec(r.open.toString()),
      high: new Dec(r.high.toString()),
      low: new Dec(r.low.toString()),
      close: new Dec(r.close.toString()),
      volume: new Dec(r.volume.toString()),
    }));
  }

  async saveSnapshot(s: SnapshotRecord): Promise<bigint> {
    const row = await this.prisma.marketSnapshot.create({
      select: { id: true },
      data: {
        pair: s.pair,
        timestamp: s.fetchedAt,
        serverTime: s.serverTime,
        orderBookAgeSec: s.orderBookAgeSec,
        lastPrice: exact(s.lastPrice, 'lastPrice'),
        bestBid: exact(s.bestBid, 'bestBid'),
        bestAsk: exact(s.bestAsk, 'bestAsk'),
        spread: exact(s.spreadIdr, 'spread'),
        // Derived ratio, intentionally rounded to the column scale.
        spreadPct: s.spreadPct.toDecimalPlaces(8).toFixed(),
        high24h: exactOrNull(s.high24h, 'high24h'),
        low24h: exactOrNull(s.low24h, 'low24h'),
        volumeBase24h: exactOrNull(s.volumeBase24h, 'volumeBase24h'),
        volumeIdr24h: exactOrNull(s.volumeIdr24h, 'volumeIdr24h'),
        orderBookData: s.orderBookData as object,
        tradeActivity: (s.tradeActivity ?? undefined) as object | undefined,
        qualityStatus: s.qualityStatus,
        qualityIssues: s.qualityIssues as object[],
      },
    });
    return row.id;
  }
}

/** Non-persistent repository for tests and `market:check --no-save`. */
export class InMemoryMarketRepository implements MarketRepository {
  readonly candles = new Map<string, Candle>();
  readonly snapshots: SnapshotRecord[] = [];

  private key = (c: Pick<Candle, 'pair' | 'timeframe' | 'openTime'>) => `${c.pair}|${c.timeframe}|${c.openTime.getTime()}`;

  private series(pair: string, timeframe: Timeframe): Candle[] {
    return [...this.candles.values()]
      .filter((c) => c.pair === pair && c.timeframe === timeframe)
      .sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  }

  async latestCandleOpenTime(pair: string, timeframe: Timeframe): Promise<Date | null> {
    return this.series(pair, timeframe).at(-1)?.openTime ?? null;
  }

  async upsertCandles(candles: Candle[]): Promise<number> {
    for (const c of candles) this.candles.set(this.key(c), c);
    return candles.length;
  }

  async loadCandles(pair: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    return this.series(pair, timeframe).slice(-limit);
  }

  async saveSnapshot(snapshot: SnapshotRecord): Promise<bigint> {
    this.snapshots.push(snapshot);
    return BigInt(this.snapshots.length);
  }
}
