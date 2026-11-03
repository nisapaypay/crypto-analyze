import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sum } from '../app/decimal.js';
import { withStrategyOverrides } from '../strategy/config.js';
import type { Combo, PairSeries, SimResult, SimTrade } from './simulator.js';

const TF_MS = 900_000;

export interface Period {
  label: string;
  start: Date;
  end: Date;
}

/**
 * 12 equal blocks after the indicator warm-up: blocks 1–9 = development
 * (walk-forward), blocks 10–12 = holdout, locked until final parameters exist.
 */
export function planPeriods(series: PairSeries[], months = 12, holdoutMonths = 3, window = 300, settleSec = 90) {
  const first = Math.max(
    ...series.map((s) =>
      Math.max(s.c15[window - 1]!.openTime.getTime(), s.c60[window - 1]!.openTime.getTime() + 3_600_000 + settleSec * 1000),
    ),
  );
  const start = Math.ceil(first / TF_MS) * TF_MS;
  const dataEnd = Math.min(...series.map((s) => s.c15.at(-1)!.openTime.getTime() + TF_MS));
  const blockMs = Math.floor((dataEnd - start) / months / TF_MS) * TF_MS;
  const blocks: Period[] = Array.from({ length: months }, (_, i) => ({
    label: `bulan ${i + 1}`,
    start: new Date(start + i * blockMs),
    end: new Date(start + (i + 1) * blockMs),
  }));
  const dev = months - holdoutMonths;
  return {
    blocks,
    development: { label: `bulan 1–${dev}`, start: blocks[0]!.start, end: blocks[dev - 1]!.end },
    holdout: { label: `bulan ${dev + 1}–${months} (holdout)`, start: blocks[dev]!.start, end: blocks[months - 1]!.end },
  };
}

/** Copy of the series without any candle at/after `end` (physically hides the holdout). */
export function truncateSeries(series: PairSeries[], end: Date): PairSeries[] {
  return series.map((s) => ({ ...s, c15: s.c15.filter((c) => c.openTime < end), c60: s.c60.filter((c) => c.openTime < end) }));
}

export const DEFAULT_COMBO_ID = 'atr1.5_rr3_vol1.2';

/** Small, pre-declared grid (8 combinations). */
export function parameterGrid(): Combo[] {
  const out: Combo[] = [];
  for (const atr of [1.5, 2.0]) {
    for (const rr of [3, 2.5]) {
      for (const vol of [1.2, 1.5]) {
        out.push({
          id: `atr${atr}_rr${rr}_vol${vol}`,
          cfg: withStrategyOverrides({ stop: { atrMultiple: atr }, takeProfit: { rrCap: rr }, gates: { volumeRatioMin: vol } }),
        });
      }
    }
  }
  return out;
}

export function tradesIn(trades: SimTrade[], p: Period): SimTrade[] {
  return trades.filter((t) => t.decisionAt >= p.start && t.decisionAt < p.end);
}

const expectancyR = (trades: SimTrade[]) => (trades.length ? sum(trades.map((t) => t.r)).div(trades.length) : null);

/** Highest mean net R among combos with ≥ minTrades in the window; otherwise the default. */
export function selectCombo(results: SimResult[], window: Period, minTrades = 30) {
  const scored = results.map((r) => {
    const t = tradesIn(r.trades, window);
    return { combo: r.combo, trades: t.length, expectancyR: expectancyR(t) };
  });
  const eligible = scored.filter((s) => s.trades >= minTrades && s.expectancyR !== null);
  if (eligible.length === 0) {
    return { combo: DEFAULT_COMBO_ID, reason: `tidak ada kombinasi dengan ≥${minTrades} trade: memakai default`, scored };
  }
  eligible.sort((a, b) => b.expectancyR!.comparedTo(a.expectancyR!) || (a.combo === DEFAULT_COMBO_ID ? -1 : 0) || a.combo.localeCompare(b.combo));
  return { combo: eligible[0]!.combo, reason: `expectancy R tertinggi dengan ≥${minTrades} trade`, scored };
}

/** Anchored-length rolling folds: train `trainBlocks` blocks, test the next one. */
export function walkForward(results: SimResult[], blocks: Period[], devBlocks: number, trainBlocks = 4, minTrades = 30) {
  const folds = [];
  for (let k = 0; k + trainBlocks < devBlocks; k++) {
    const train: Period = { label: `${blocks[k]!.label}–${blocks[k + trainBlocks - 1]!.label}`, start: blocks[k]!.start, end: blocks[k + trainBlocks - 1]!.end };
    const test = blocks[k + trainBlocks]!;
    const choice = selectCombo(results, train, minTrades);
    const chosen = results.find((r) => r.combo === choice.combo);
    folds.push({ train, test, chosen: choice.combo, reason: choice.reason, testTrades: chosen ? tradesIn(chosen.trades, test) : [] });
  }
  return folds;
}

// ---- Holdout lock -------------------------------------------------------

export interface HoldoutLock {
  createdAt: string;
  combo: string;
  paramsHash: string;
  dataHash: string;
  period: { start: string; end: string };
}

export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function holdoutDataHash(series: PairSeries[], p: Period): string {
  return hash(
    series.map((s) => [
      s.pair,
      s.c15.filter((c) => c.openTime >= p.start && c.openTime < p.end).map((c) => [c.openTime.getTime(), c.close.toFixed(), c.volume.toFixed()]),
    ]),
  );
}

/**
 * The holdout may be evaluated once per (final parameters, data). Re-running
 * the same pair reproduces the same result; different parameters after the
 * holdout was seen are refused unless explicitly reset (and then reported as
 * no longer a clean out-of-sample test).
 */
export function checkHoldoutLock(path: string, paramsHash: string, dataHash: string, reset: boolean) {
  if (!existsSync(path)) return { ok: true as const, firstRun: true, contaminated: false };
  const lock = JSON.parse(readFileSync(path, 'utf8')) as HoldoutLock;
  if (lock.paramsHash === paramsHash && lock.dataHash === dataHash) return { ok: true as const, firstRun: false, contaminated: false };
  if (reset) return { ok: true as const, firstRun: true, contaminated: true };
  return {
    ok: false as const,
    reason:
      `Holdout sudah pernah dievaluasi pada ${lock.createdAt} dengan parameter ${lock.combo}. ` +
      'Parameter/data berbeda → holdout tidak lagi out-of-sample. Gunakan --reset-holdout hanya jika Anda menerima itu.',
  };
}

export function writeHoldoutLock(path: string, lock: HoldoutLock): void {
  writeFileSync(path, JSON.stringify(lock, null, 2));
}

export const sumNet = (trades: SimTrade[]) => sum(trades.map((t) => t.netPnl));
