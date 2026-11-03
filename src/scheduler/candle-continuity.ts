import type { PrismaClient } from '../app/database/prisma.js';
import type { Logger } from '../app/logger/logger.js';
import { expectedLatestFinalOpenTime, hasValidOhlc, isFinalCandle } from '../market/candles.js';
import { TIMEFRAME_SECONDS, type Candle, type Timeframe } from '../market/types.js';
import type { GapRepository } from './data-gaps.js';
import type { ServerClock } from './server-clock.js';

/** Read-only view of stored candle open times (the M2 table, read directly; M2 code unchanged). */
export interface CandleStore {
  firstOpenTime(pair: string, timeframe: Timeframe): Promise<Date | null>;
  openTimes(pair: string, timeframe: Timeframe, from: Date, until: Date): Promise<Date[]>;
}

export class PrismaCandleStore implements CandleStore {
  constructor(private readonly prisma: PrismaClient) {}

  async firstOpenTime(pair: string, timeframe: Timeframe): Promise<Date | null> {
    const row = await this.prisma.candle.findFirst({ where: { pair, timeframe }, orderBy: { openTime: 'asc' }, select: { openTime: true } });
    return row?.openTime ?? null;
  }

  async openTimes(pair: string, timeframe: Timeframe, from: Date, until: Date): Promise<Date[]> {
    const rows = await this.prisma.candle.findMany({
      where: { pair, timeframe, openTime: { gte: from, lt: until } },
      orderBy: { openTime: 'asc' },
      select: { openTime: true },
    });
    return rows.map((r) => r.openTime);
  }
}

export interface Range {
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** Missing candle open times in [from, until), as half-open ranges. Pure. */
export function missingRanges(present: Date[], from: Date, until: Date, stepMs: number): Range[] {
  const have = new Set(present.map((d) => d.getTime()));
  const out: Range[] = [];
  let open: number | null = null;
  for (let t = from.getTime(); t < until.getTime(); t += stepMs) {
    if (!have.has(t)) open ??= t;
    else if (open !== null) {
      out.push({ start: new Date(open), end: new Date(t) });
      open = null;
    }
  }
  if (open !== null) out.push({ start: new Date(open), end: until });
  return out;
}

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

export interface ContinuityDeps {
  store: CandleStore;
  client: { getCandles(pair: string, timeframe: Timeframe, from: Date, to: Date): Promise<Candle[]> };
  /** M2 PrismaMarketRepository.upsertCandles (idempotent, refuses lossy precision). */
  upsert: (candles: Candle[]) => Promise<number>;
  gaps: GapRepository;
  serverClock: ServerClock;
  logger: Logger;
  timeframes: Timeframe[];
  lookbackMs: number;
  maxRequestsPerPass: number;
  settleSec: number;
  chunkCandles: Partial<Record<Timeframe, number>>;
}

export interface ContinuityReport {
  skipped?: string;
  detected: number;
  backfilled: number;
  permanent: number;
  open: number;
  requests: number;
}

/**
 * Candle continuity: finds missing 15m/1H candles between the first stored
 * candle and the latest candle that must be final by trusted Indodax time,
 * re-fetches them from Indodax (final candles only, never estimated or
 * interpolated) and records every gap: BACKFILLED, PERMANENT (Indodax has no
 * data) or OPEN (fetch failed / request budget used up; retried next pass).
 */
export class CandleContinuity {
  constructor(private readonly d: ContinuityDeps) {}

  async maintain(pairs: string[], trigger: string): Promise<ContinuityReport> {
    const report: ContinuityReport = { detected: 0, backfilled: 0, permanent: 0, open: 0, requests: 0 };
    const reason = this.d.serverClock.untrustedReason();
    if (reason !== null) return { ...report, skipped: `SERVER_TIME_UNTRUSTED: ${reason}` };
    const serverNow = this.d.serverClock.current();

    for (const pair of pairs) {
      for (const tf of this.d.timeframes) {
        const step = TIMEFRAME_SECONDS[tf] * 1000;
        const first = await this.d.store.firstOpenTime(pair, tf);
        if (!first) continue; // M2's first refresh backfills the initial history
        const floor = new Date(Math.ceil((serverNow.getTime() - this.d.lookbackMs) / step) * step);
        const from = first > floor ? first : floor;
        // The newest final candle is left to M2's regular sync (it may still sit in Cloudflare's
        // OHLC cache); never classify it as missing, let alone PERMANENT.
        const until = expectedLatestFinalOpenTime(tf, serverNow, this.d.settleSec);
        const permanent = await this.d.gaps.permanentCandleGaps(pair, tf);
        const ranges = missingRanges(await this.d.store.openTimes(pair, tf, from, until), from, until, step).filter(
          (r) => !permanent.some((p) => overlaps(p, r)),
        );
        for (const range of ranges) {
          report.detected++;
          await this.fill(pair, tf, range, step, serverNow, trigger, report);
        }
      }
    }
    if (report.detected > 0) this.d.logger.info({ trigger, ...report }, 'Kontinuitas candle diperiksa');
    return report;
  }

  private async fill(pair: string, tf: Timeframe, range: Range, step: number, serverNow: Date, trigger: string, report: ContinuityReport): Promise<void> {
    const details = { trigger, missingCandles: Math.round((range.end.getTime() - range.start.getTime()) / step) };
    const chunk = (this.d.chunkCandles[tf] ?? 500) * step;
    try {
      for (let s = range.start.getTime(); s < range.end.getTime(); s += chunk) {
        if (report.requests >= this.d.maxRequestsPerPass) {
          report.open++;
          await this.d.gaps.upsertCandleGap(pair, tf, range.start, range.end, 'DETECTED', 'OPEN', { ...details, note: 'batas request per pemeriksaan tercapai; dilanjutkan berikutnya' });
          return;
        }
        const end = Math.min(s + chunk, range.end.getTime()) - step;
        report.requests++;
        const fetched = await this.d.client.getCandles(pair, tf, new Date(s), new Date(end));
        const keep = fetched.filter(
          (c) => c.openTime >= range.start && c.openTime < range.end && isFinalCandle(c, serverNow, this.d.settleSec) && hasValidOhlc(c),
        );
        if (keep.length) await this.d.upsert(keep);
      }
    } catch (error) {
      report.open++;
      await this.d.gaps.upsertCandleGap(pair, tf, range.start, range.end, 'DETECTED', 'OPEN', { ...details, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
      return;
    }

    const remaining = missingRanges(await this.d.store.openTimes(pair, tf, range.start, range.end), range.start, range.end, step);
    if (remaining.length === 0) {
      report.backfilled++;
      await this.d.gaps.upsertCandleGap(pair, tf, range.start, range.end, 'DETECTED', 'BACKFILLED', details);
      return;
    }
    // Indodax returned nothing for these candles: recorded, never filled in.
    for (const r of remaining) {
      report.permanent++;
      await this.d.gaps.upsertCandleGap(pair, tf, r.start, r.end, 'NOT_AVAILABLE_FROM_INDODAX', 'PERMANENT', { ...details, missingCandles: Math.round((r.end.getTime() - r.start.getTime()) / step) });
    }
    if (remaining[0]!.start.getTime() !== range.start.getTime()) {
      report.backfilled++;
      await this.d.gaps.upsertCandleGap(pair, tf, range.start, remaining[0]!.start, 'DETECTED', 'BACKFILLED', details);
    }
  }
}
