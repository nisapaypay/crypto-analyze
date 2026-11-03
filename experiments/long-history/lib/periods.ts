import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dec } from '../../../src/app/decimal.js';
import type { Period } from '../../../src/backtest/walk-forward.js';
import { hashCandles } from '../../../src/backtest/dataset.js';
import type { ExpSeries } from '../../m4-followup/lib/series.js';
import { assertNoHoldout, loadExpSeries } from '../../m4-followup/lib/series.js';
import { ALL_PAIRS, DEV_START, HOLDOUT_START, LONG_DATA_DIR, PHASE_THRESHOLD_PCT, WF } from '../config.js';

/** Calendar months (UTC) from DEV_START; the last block runs to HOLDOUT_START. */
export function monthBlocks(): Period[] {
  const out: Period[] = [];
  for (let i = 0; ; i++) {
    const start = new Date(Date.UTC(DEV_START.getUTCFullYear(), DEV_START.getUTCMonth() + i, 1));
    if (start >= HOLDOUT_START) break;
    const next = new Date(Date.UTC(DEV_START.getUTCFullYear(), DEV_START.getUTCMonth() + i + 1, 1));
    out.push({ label: start.toISOString().slice(0, 7), start, end: next < HOLDOUT_START ? next : HOLDOUT_START });
  }
  // A stub shorter than a week (2026-08-01 → 08-02) is folded into the previous month.
  const last = out.at(-1)!;
  if (out.length > 1 && last.end.getTime() - last.start.getTime() < 7 * 86_400_000) {
    out.pop();
    out.at(-1)!.end = last.end;
  }
  return out;
}

export interface Fold {
  label: string;
  train: Period;
  test: Period;
}

export function walkForwardFolds(blocks = monthBlocks()): Fold[] {
  const folds: Fold[] = [];
  for (let k = 0; k + WF.trainMonths < blocks.length; k += WF.stepMonths) {
    const testBlocks = blocks.slice(k + WF.trainMonths, k + WF.trainMonths + WF.testMonths);
    const train: Period = { label: `${blocks[k]!.label}…${blocks[k + WF.trainMonths - 1]!.label}`, start: blocks[k]!.start, end: blocks[k + WF.trainMonths - 1]!.end };
    const test: Period = { label: `${testBlocks[0]!.label}…${testBlocks.at(-1)!.label}`, start: testBlocks[0]!.start, end: testBlocks.at(-1)!.end };
    folds.push({ label: `F${folds.length + 1}`, train, test });
  }
  return folds;
}

export const DEV: Period = { label: `pengembangan ${DEV_START.toISOString().slice(0, 10)} → ${HOLDOUT_START.toISOString().slice(0, 10)}`, start: DEV_START, end: HOLDOUT_START };

/**
 * Load the development dataset with every isolation check: manifest boundary,
 * file hashes, and no candle closing after HOLDOUT_START.
 */
export function loadDevSeries(pairs = ALL_PAIRS): ExpSeries[] {
  const path = join(LONG_DATA_DIR, 'manifest.json');
  if (!existsSync(path)) throw new Error(`${path} belum ada. Jalankan experiments/long-history/fetch.ts`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { holdoutStart: string; quality: { pair: string; timeframe: string; sha256: string }[] };
  if (manifest.holdoutStart !== HOLDOUT_START.toISOString()) throw new Error(`Batas holdout manifest ${manifest.holdoutStart} ≠ ${HOLDOUT_START.toISOString()}`);
  const series = pairs.map((p) => loadExpSeries(p, LONG_DATA_DIR));
  for (const s of series) {
    for (const [tf, cs] of [['15', s.c15], ['60', s.c60], ['240', s.c240]] as const) {
      const q = manifest.quality.find((x) => x.pair === s.pair && x.timeframe === tf);
      const rows = cs.map((c) => [Math.floor(c.openTime.getTime() / 1000), c.open.toFixed(), c.high.toFixed(), c.low.toFixed(), c.close.toFixed(), c.volume.toFixed()] as [number, string, string, string, string, string]);
      if (!q || q.sha256 !== hashCandles(rows)) throw new Error(`Hash ${s.pair} ${tf}m tidak cocok dengan manifest`);
    }
  }
  assertNoHoldout(series, HOLDOUT_START);
  return series;
}

export type Phase = 'bullish' | 'bearish' | 'sideways';

/** Pair's own monthly return (first 4H open → last 4H close of the month) and its phase label. */
export function monthlyPhases(s: ExpSeries, blocks = monthBlocks()): Map<string, { phase: Phase; returnPct: Dec }> {
  const out = new Map<string, { phase: Phase; returnPct: Dec }>();
  for (const b of blocks) {
    const cs = s.c240.filter((c) => c.openTime >= b.start && c.openTime < b.end);
    if (cs.length === 0) continue;
    const r = cs.at(-1)!.close.div(cs[0]!.open).minus(1).times(100);
    out.set(b.label, { phase: r.gte(PHASE_THRESHOLD_PCT) ? 'bullish' : r.lte(-PHASE_THRESHOLD_PCT) ? 'bearish' : 'sideways', returnPct: r });
  }
  return out;
}

export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
