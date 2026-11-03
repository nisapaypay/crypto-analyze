import { Dec, sum, ZERO } from '../app/decimal.js';
import type { SimTrade } from './simulator.js';

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: Dec | null;
  avgWin: Dec | null;
  avgLoss: Dec | null;
  /** Mean net P/L per trade after fees, taxes and slippage. */
  expectancyIdr: Dec | null;
  /** Mean of netPnl / planned risk. */
  expectancyR: Dec | null;
  /** Gross wins / gross losses (net of costs); null without losses. */
  profitFactor: Dec | null;
  totalNet: Dec;
  totalFees: Dec;
  totalTaxes: Dec;
  totalSlippage: Dec;
  maxDrawdownIdr: Dec;
  maxDrawdownPct: Dec;
  /** Longest time below a previous equity peak, in days. */
  maxDrawdownDays: number;
  worstDay: { key: string; net: Dec } | null;
  worstWeek: { key: string; net: Dec } | null;
  worstMonth: { key: string; net: Dec } | null;
  longestLosingStreak: number;
  overshootCount: number;
  maxOvershootIdr: Dec;
  exits: Record<string, number>;
  entryKinds: Record<string, number>;
  /** Approximate 95% bootstrap interval of the mean R (2000 resamples, fixed seed). */
  expectancyRCi95: [number, number] | null;
  /** Never "profitable": only how much the sample can say. */
  sampleNote: string;
}

const mean = (xs: Dec[]) => (xs.length ? sum(xs).div(xs.length) : null);

function dayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function worst(groups: Map<string, Dec>): { key: string; net: Dec } | null {
  let out: { key: string; net: Dec } | null = null;
  for (const [key, net] of groups) if (!out || net.lt(out.net)) out = { key, net };
  return out;
}

function groupSum(trades: SimTrade[], key: (t: SimTrade) => string): Map<string, Dec> {
  const m = new Map<string, Dec>();
  for (const t of trades) m.set(key(t), (m.get(key(t)) ?? ZERO).plus(t.netPnl));
  return m;
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap of the mean (statistics on R multiples, not money; floats are fine here). */
export function bootstrapMeanCi(values: number[], resamples = 2000, seed = 7): [number, number] | null {
  if (values.length < 2) return null;
  const rand = seeded(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[Math.floor(rand() * values.length)]!;
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(resamples * 0.025)]!, means[Math.floor(resamples * 0.975)]!];
}

export function sampleNote(n: number): string {
  if (n === 0) return 'tidak ada trade: tidak ada yang bisa disimpulkan';
  if (n < 30) return `${n} trade: TIDAK BERMAKNA secara statistik`;
  return `${n} trade: sampel masih kecil; ≥30 trade BUKAN bukti keunggulan strategi`;
}

export function computeMetrics(trades: SimTrade[], capital: Dec, timeZone: string): Metrics {
  const sorted = [...trades].sort((a, b) => a.exitAt.getTime() - b.exitAt.getTime());
  const wins = sorted.filter((t) => t.netPnl.gt(0));
  const losses = sorted.filter((t) => t.netPnl.lte(0));
  const grossWin = sum(wins.map((t) => t.netPnl));
  const grossLoss = sum(losses.map((t) => t.netPnl)).abs();

  // Equity curve in trade-exit order (fixed capital, no compounding).
  let equity: Dec = ZERO;
  let peak: Dec = ZERO;
  let peakAt: Date | null = sorted[0]?.entryAt ?? null;
  let maxDd: Dec = ZERO;
  let maxDdDays = 0;
  for (const t of sorted) {
    equity = equity.plus(t.netPnl);
    if (equity.gte(peak)) {
      peak = equity;
      peakAt = t.exitAt;
    } else {
      maxDd = Dec.max(maxDd, peak.minus(equity));
      if (peakAt) maxDdDays = Math.max(maxDdDays, (t.exitAt.getTime() - peakAt.getTime()) / 86_400_000);
    }
  }

  let streak = 0;
  let longest = 0;
  for (const t of sorted) {
    streak = t.netPnl.lte(0) ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }

  const count = (key: (t: SimTrade) => string) =>
    sorted.reduce<Record<string, number>>((acc, t) => ({ ...acc, [key(t)]: (acc[key(t)] ?? 0) + 1 }), {});
  const overshoots = sorted.filter((t) => t.overshoot);
  const weekKey = (t: SimTrade) => {
    // Monday of the local (time-zone) calendar week.
    const [y, m, d] = dayKey(t.exitAt, timeZone).split('-').map(Number);
    const utc = Date.UTC(y!, m! - 1, d!);
    const monday = new Date(utc - ((new Date(utc).getUTCDay() + 6) % 7) * 86_400_000);
    return `minggu mulai ${monday.toISOString().slice(0, 10)}`;
  };

  return {
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: sorted.length ? new Dec(wins.length).div(sorted.length).times(100) : null,
    avgWin: mean(wins.map((t) => t.netPnl)),
    avgLoss: mean(losses.map((t) => t.netPnl)),
    expectancyIdr: mean(sorted.map((t) => t.netPnl)),
    expectancyR: mean(sorted.map((t) => t.r)),
    profitFactor: grossLoss.gt(0) ? grossWin.div(grossLoss) : null,
    totalNet: sum(sorted.map((t) => t.netPnl)),
    totalFees: sum(sorted.map((t) => t.fees)),
    totalTaxes: sum(sorted.map((t) => t.taxes)),
    totalSlippage: sum(sorted.map((t) => t.slippage)),
    maxDrawdownIdr: maxDd,
    maxDrawdownPct: capital.gt(0) ? maxDd.div(capital).times(100) : ZERO,
    maxDrawdownDays: Math.round(maxDdDays * 10) / 10,
    worstDay: worst(groupSum(sorted, (t) => dayKey(t.exitAt, timeZone))),
    worstWeek: worst(groupSum(sorted, weekKey)),
    worstMonth: worst(groupSum(sorted, (t) => dayKey(t.exitAt, timeZone).slice(0, 7))),
    longestLosingStreak: longest,
    overshootCount: overshoots.length,
    maxOvershootIdr: overshoots.length ? Dec.max(...overshoots.map((t) => t.netPnl.neg().minus(t.reservedRisk))) : ZERO,
    exits: count((t) => t.exitReason),
    entryKinds: count((t) => t.entryKind),
    expectancyRCi95: bootstrapMeanCi(sorted.map((t) => t.r.toNumber())),
    sampleNote: sampleNote(sorted.length),
  };
}
