/**
 * Operational soak-test report (Milestone 5). READ-ONLY: it never writes,
 * repairs or fills anything.
 *
 *   pnpm soak:report                 # last 24 hours
 *   pnpm soak:report --hours 30
 *   pnpm soak:report --since 2026-11-03T10:00:00+07:00 [--until …]
 *
 * Exit code 1 when any applicable criterion fails.
 */
import 'dotenv/config';
import { createPrismaClient } from '../src/app/database/prisma.js';
import { expectedLatestFinalOpenTime } from '../src/market/candles.js';
import { TIMEFRAME_SECONDS, type Timeframe } from '../src/market/types.js';
import { missingRanges } from '../src/scheduler/candle-continuity.js';
import { SCHEDULER_DEFAULTS } from '../src/scheduler/config.js';
import { overlappingRuns, unexplainedCandles, unexplainedSnapshotSlots, unrecordedSlots, type CheckResult, type Interval } from '../src/scheduler/soak-checks.js';
import { slotAtOrAfter, slotsBetween } from '../src/scheduler/slots.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL kosong');
const prisma = createPrismaClient(url);

const now = new Date();
const until = opt('until') ? new Date(opt('until')!) : now;
const since = opt('since') ? new Date(opt('since')!) : new Date(until.getTime() - Number(opt('hours') ?? 24) * 3_600_000);
const wib = (d: Date) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'medium' }).format(d);
const results: CheckResult[] = [];
const lines: string[] = [];
const log = (l = '') => lines.push(l);
const list = (ds: Date[], n = 8) => ds.slice(0, n).map(wib).join(', ') + (ds.length > n ? ` … (+${ds.length - n})` : '');

const SLOT_KINDS = ['STRATEGY_SCAN', 'COLLECT'] as const;

// ---- window -------------------------------------------------------------
const firstSlotRow = await prisma.scheduledScan.findFirst({ where: { kind: { in: [...SLOT_KINDS] } }, orderBy: { scheduledAt: 'asc' }, select: { scheduledAt: true } });
if (!firstSlotRow) {
  console.log('Belum ada run scheduler. Jalankan aplikasi dahulu.');
  process.exit(1);
}
const windowStart = since > firstSlotRow.scheduledAt ? since : firstSlotRow.scheduledAt;
// Slots still inside the 5-minute window at report time may legitimately have no row yet.
const lastJudged = new Date(Math.min(until.getTime(), now.getTime() - SCHEDULER_DEFAULTS.staleSlotSec * 1000));
const expected = slotsBetween(new Date(slotAtOrAfter(windowStart, SCHEDULER_DEFAULTS.settleSec).getTime() - 1), lastJudged, SCHEDULER_DEFAULTS.settleSec);

log(`SOAK REPORT — ${wib(windowStart)} → ${wib(lastJudged)} WIB (${((lastJudged.getTime() - windowStart.getTime()) / 3_600_000).toFixed(1)} jam, ${expected.length} slot)`);
log('');

// ---- S1 slots ------------------------------------------------------------
const rows = await prisma.scheduledScan.findMany({
  where: { kind: { in: [...SLOT_KINDS] }, trigger: { not: 'RECOVERY' }, scheduledAt: { gte: windowStart, lte: lastJudged } },
  select: { id: true, kind: true, status: true, cause: true, scheduledAt: true, startedAt: true, finishedAt: true },
});
const slotRows = rows.map((r) => ({ slotAt: r.scheduledAt, kind: r.kind, status: r.status, cause: r.cause }));
const unrecorded = unrecordedSlots(expected, slotRows);
results.push({ id: 'S1', title: 'Setiap slot punya catatan (COMPLETED atau status + penyebab)', verdict: unrecorded.length ? 'FAIL' : 'PASS', detail: unrecorded.length ? `${unrecorded.length} slot tanpa catatan: ${list(unrecorded)}` : `${expected.length} slot tercatat` });
const noCause = slotRows.filter((r) => r.status !== 'COMPLETED' && !r.cause);
if (noCause.length) results.push({ id: 'S1b', title: 'Slot tidak selesai selalu punya penyebab', verdict: 'FAIL', detail: `${noCause.length} tanpa penyebab` });

log('Status slot (per jenis):');
const counts = new Map<string, number>();
for (const r of slotRows) counts.set(`${r.kind} ${r.status}${r.cause ? ` (${r.cause})` : ''}`, (counts.get(`${r.kind} ${r.status}${r.cause ? ` (${r.cause})` : ''}`) ?? 0) + 1);
for (const [k, v] of [...counts.entries()].sort()) log(`  ${k}: ${v}`);
const recoveries = await prisma.scheduledScan.count({ where: { trigger: 'RECOVERY', scheduledAt: { gte: windowStart, lte: until } } });
log(`  pengumpulan RECOVERY (di luar slot, tidak mengisi slot terlewat): ${recoveries}`);
log('');

// ---- S4 single flight ---------------------------------------------------
const spans = rows.filter((r) => r.startedAt).map((r) => ({ id: r.id, startedAt: r.startedAt!, finishedAt: r.finishedAt }));
const overlaps = overlappingRuns(spans);
results.push({ id: 'S4', title: 'Tidak ada slot ganda / run tumpang tindih', verdict: overlaps.length ? 'FAIL' : 'PASS', detail: overlaps.length ? `tumpang tindih: ${overlaps.map(([a, b]) => `#${a}/#${b}`).join(', ')}` : `${spans.length} run berurutan; slot unik dijamin constraint DB` });

// ---- S2 snapshots -------------------------------------------------------
const items = await prisma.scanRunItem.findMany({
  where: { status: 'OK', marketSnapshotId: { not: null }, scan: { kind: { in: [...SLOT_KINDS] }, trigger: { not: 'RECOVERY' }, scheduledAt: { gte: windowStart, lte: lastJudged } } },
  select: { pair: true, scan: { select: { scheduledAt: true } } },
});
const pairsSeen = [...new Set((await prisma.scanRunItem.findMany({ where: { scan: { scheduledAt: { gte: windowStart, lte: lastJudged } } }, select: { pair: true }, distinct: ['pair'] })).map((p) => p.pair))].sort();
const gapRows = await prisma.dataGap.findMany({ where: { gapEnd: { gt: windowStart }, gapStart: { lt: until } }, orderBy: [{ pair: 'asc' }, { gapStart: 'asc' }] });
log('Snapshot per pair:');
let unexplainedTotal = 0;
for (const pair of pairsSeen) {
  const covered = new Set(items.filter((i) => i.pair === pair).map((i) => i.scan.scheduledAt.getTime()));
  const gaps: Interval[] = gapRows.filter((g) => g.kind === 'SNAPSHOT' && g.pair === pair).map((g) => ({ start: g.gapStart, end: g.gapEnd }));
  const unexplained = unexplainedSnapshotSlots(expected, covered, gaps);
  unexplainedTotal += unexplained.length;
  const missing = expected.length - [...covered].filter((t) => expected.some((e) => e.getTime() === t)).length;
  log(`  ${pair}: ${expected.length - missing}/${expected.length} slot punya snapshot (${((100 * (expected.length - missing)) / Math.max(expected.length, 1)).toFixed(1)}%) · tanpa penjelasan: ${unexplained.length}${unexplained.length ? ` (${list(unexplained, 4)})` : ''}`);
}
results.push({ id: 'S2', title: 'Setiap slot tanpa snapshot tercatat sebagai gap', verdict: unexplainedTotal ? 'FAIL' : 'PASS', detail: `${unexplainedTotal} slot tanpa penjelasan` });
const nonPermanentSnapshotGaps = gapRows.filter((g) => g.kind === 'SNAPSHOT' && g.status !== 'PERMANENT');
if (nonPermanentSnapshotGaps.length) results.push({ id: 'S2b', title: 'Gap snapshot selalu PERMANENT', verdict: 'FAIL', detail: `${nonPermanentSnapshotGaps.length} tidak PERMANENT` });
log('');

// ---- S3 candles ---------------------------------------------------------
log('Kontinuitas candle (dari DB, setelah backfill):');
let unexplainedCandleTotal = 0;
for (const pair of pairsSeen) {
  for (const tf of SCHEDULER_DEFAULTS.continuityTimeframes as readonly Timeframe[]) {
    const step = TIMEFRAME_SECONDS[tf] * 1000;
    const first = await prisma.candle.findFirst({ where: { pair, timeframe: tf }, orderBy: { openTime: 'asc' }, select: { openTime: true } });
    if (!first) continue;
    const from = new Date(Math.max(Math.ceil(windowStart.getTime() / step) * step, first.openTime.getTime()));
    const to = expectedLatestFinalOpenTime(tf, lastJudged, SCHEDULER_DEFAULTS.settleSec); // newest final candle excluded (regular sync)
    const present = (await prisma.candle.findMany({ where: { pair, timeframe: tf, openTime: { gte: from, lt: to } }, select: { openTime: true } })).map((c) => c.openTime);
    const missing = missingRanges(present, from, to, step);
    const recorded = gapRows.filter((g) => g.kind === 'CANDLE' && g.pair === pair && g.timeframe === tf && g.status !== 'BACKFILLED').map((g) => ({ start: g.gapStart, end: g.gapEnd }));
    const unexplained = unexplainedCandles(missing, recorded, step);
    unexplainedCandleTotal += unexplained.length;
    const expectedCount = Math.max(0, Math.round((to.getTime() - from.getTime()) / step));
    log(`  ${pair} ${tf}m: ${present.length}/${expectedCount} candle · hilang ${missing.reduce((a, m) => a + (m.end.getTime() - m.start.getTime()) / step, 0)} · tanpa catatan gap: ${unexplained.length}`);
  }
}
results.push({ id: 'S3', title: 'Candle 15m/1j kontinu kecuali gap tercatat (PERMANENT/OPEN)', verdict: unexplainedCandleTotal ? 'FAIL' : 'PASS', detail: `${unexplainedCandleTotal} candle hilang tanpa catatan` });
log('');

log('Gap data tercatat:');
if (gapRows.length === 0) log('  (tidak ada)');
for (const g of gapRows) log(`  ${g.kind} ${g.pair}${g.timeframe !== '-' ? ` ${g.timeframe}m` : ''} ${wib(g.gapStart)} → ${wib(g.gapEnd)} · ${g.cause} · ${g.status}`);
log('');

// ---- S5 / S8 metrics (hourly audit entries) -------------------------------
const metrics = await prisma.auditLog.findMany({ where: { action: 'scheduler.metrics', createdAt: { gte: windowStart, lte: until } }, orderBy: { createdAt: 'asc' } });
const m = metrics.map((x) => x.details as { attempts: number; peakPerMinute: number; rssMb: number });
if (m.length === 0) {
  results.push({ id: 'S5', title: 'Puncak request ≤ 120/menit', verdict: 'N/A', detail: 'belum ada catatan metrik per jam (ditulis setiap 60 menit proses berjalan)' });
  results.push({ id: 'S8', title: 'Memori stabil (naik ≤ 50 MB)', verdict: 'N/A', detail: 'belum ada catatan metrik' });
} else {
  const peak = Math.max(...m.map((x) => x.peakPerMinute));
  const total = m.reduce((a, x) => a + x.attempts, 0);
  results.push({ id: 'S5', title: 'Puncak request ≤ 120/menit', verdict: peak <= 120 ? 'PASS' : 'FAIL', detail: `puncak ${peak}/menit · ${total} percobaan HTTP dalam ${m.length} jam (rata-rata ${(total / m.length).toFixed(0)}/jam)` });
  const growth = m.at(-1)!.rssMb - m[0]!.rssMb;
  results.push({ id: 'S8', title: 'Memori stabil (naik ≤ 50 MB)', verdict: m.length < 2 ? 'N/A' : growth <= 50 ? 'PASS' : 'FAIL', detail: `RSS ${m[0]!.rssMb} → ${m.at(-1)!.rssMb} MB (${growth >= 0 ? '+' : ''}${growth})` });
}
results.push({ id: 'S6', title: 'Tidak ada notifikasi trading di luar jam aktif', verdict: 'N/A', detail: 'berlaku mulai 5C (notifier)' });
results.push({ id: 'S7', title: 'Monitor tidak mengubah lifecycle / membuat BUY', verdict: 'N/A', detail: 'berlaku mulai 5D (entry monitor)' });

const size = await prisma.$queryRaw<{ total: string }[]>`SELECT pg_size_pretty(pg_database_size(current_database())) AS total`;
log(`Ukuran database: ${size[0]?.total}`);
log('');

log('HASIL');
for (const r of results.sort((a, b) => a.id.localeCompare(b.id))) log(`  ${r.verdict === 'PASS' ? '✅' : r.verdict === 'FAIL' ? '❌' : '⚪'} ${r.id} ${r.title}: ${r.verdict} — ${r.detail}`);
console.log(lines.join('\n'));
await prisma.$disconnect();
process.exitCode = results.some((r) => r.verdict === 'FAIL') ? 1 : 0;
