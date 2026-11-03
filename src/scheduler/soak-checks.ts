/**
 * Pure evaluation of operational soak-test data (read from the database by
 * scripts/soak-report.ts). Every function only classifies; nothing repairs.
 */

export interface SlotRow {
  slotAt: Date;
  kind: string;
  status: string;
  cause: string | null;
}

export interface RunSpan {
  id: number;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface Interval {
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** S1: expected slots that have no row of any kind (must be empty). */
export function unrecordedSlots(expected: Date[], rows: SlotRow[]): Date[] {
  const seen = new Set(rows.map((r) => r.slotAt.getTime()));
  return expected.filter((s) => !seen.has(s.getTime()));
}

/** S4: runs that started before the previous run had finished (single flight broken). */
export function overlappingRuns(runs: RunSpan[]): [number, number][] {
  const sorted = [...runs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const out: [number, number][] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    if (prev.finishedAt && sorted[i]!.startedAt < prev.finishedAt) out.push([prev.id, sorted[i]!.id]);
  }
  return out;
}

const inside = (t: Date, gaps: Interval[]) => gaps.some((g) => t >= g.start && t < g.end);

/** S2: slots of a pair with neither a stored snapshot nor a recorded gap (must be empty). */
export function unexplainedSnapshotSlots(expected: Date[], covered: Set<number>, gaps: Interval[]): Date[] {
  return expected.filter((s) => !covered.has(s.getTime()) && !inside(s, gaps));
}

/** S3: missing candle open times not covered by a recorded candle gap (must be empty). */
export function unexplainedCandles(missing: Interval[], recorded: Interval[], stepMs: number): Date[] {
  const out: Date[] = [];
  for (const m of missing) {
    for (let t = m.start.getTime(); t < m.end.getTime(); t += stepMs) {
      const d = new Date(t);
      if (!inside(d, recorded)) out.push(d);
    }
  }
  return out;
}

export type Verdict = 'PASS' | 'FAIL' | 'N/A';

export interface CheckResult {
  id: string;
  title: string;
  verdict: Verdict;
  detail: string;
}
