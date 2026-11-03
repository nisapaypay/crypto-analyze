import type { PairMarketData } from '../market/market-data-service.js';
import type { ScanResult } from '../strategy/strategy-service.js';
import type { SlotTaskReport } from './scan-scheduler.js';
import type { RunItem } from './scheduler-repository.js';

/** Run items from an M4 scan: one per pair, linked to its stored signal and market snapshot. */
export function strategyReport(scan: ScanResult): SlotTaskReport {
  const items: RunItem[] = scan.results.map((r) => ({
    pair: r.market.pair,
    status: r.market.snapshotId !== null ? 'OK' : 'FAILED',
    decision: r.decision.decision,
    signalId: r.signalId,
    marketSnapshotId: r.market.snapshotId,
    qualityStatus: r.market.quality.status,
    error: r.market.snapshotId === null ? issuesText(r.market) : null,
  }));
  const decisions: Record<string, number> = {};
  for (const r of scan.results) decisions[r.decision.decision] = (decisions[r.decision.decision] ?? 0) + 1;
  return { items, summary: { decisions, best: scan.best?.decision.pair ?? null } };
}

/**
 * Market data only: refresh every pair independently (one failure does not
 * hide the others). A pair without a stored snapshot is a FAILED item — a
 * snapshot gap, never assumed complete.
 */
export async function collectReport(refresh: (pair: string) => Promise<PairMarketData>, pairs: string[]): Promise<SlotTaskReport> {
  const settled = await Promise.allSettled(pairs.map((p) => refresh(p)));
  const items: RunItem[] = settled.map((s, i) => {
    if (s.status === 'rejected') {
      const reason = s.reason instanceof Error ? s.reason : new Error(String(s.reason));
      // A time problem stops the whole slot (CLOCK_SKEW / SERVER_TIME_UNTRUSTED), not just one pair.
      if (reason.name === 'ClockNotValidError' || reason.name === 'ServerTimeUntrustedError') throw reason;
      return { pair: pairs[i]!, status: 'FAILED', error: reason.message };
    }
    const d = s.value;
    return {
      pair: d.pair,
      status: d.snapshotId !== null ? 'OK' : 'FAILED',
      marketSnapshotId: d.snapshotId,
      qualityStatus: d.quality.status,
      error: d.snapshotId === null ? issuesText(d) : null,
    };
  });
  return { items };
}

function issuesText(d: PairMarketData): string {
  const issues = d.quality.issues.map((i) => i.message);
  return issues.length ? issues.join('; ').slice(0, 500) : 'snapshot tidak tersimpan';
}
