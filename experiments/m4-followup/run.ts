/**
 * Eksperimen lanjutan M4 (1–3): timeframe 1j/4j, entry breakout, skenario biaya.
 * HANYA data pengembangan bulan 1–9. Holdout bulan 10–12 dihapus secara fisik
 * sebelum simulasi dan tidak pernah dibaca. Tanpa database, tanpa jaringan,
 * tanpa mengubah kode/parameter produksi.
 *
 *   pnpm exec tsx experiments/m4-followup/run.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toJsonSafe } from '../../src/analysis/types.js';
import { DEFAULT_SETTINGS } from '../../src/app/config/defaults.js';
import { Dec, sum } from '../../src/app/decimal.js';
import { computeMetrics, type Metrics } from '../../src/backtest/metrics.js';
import { simulate } from '../../src/backtest/simulator.js';
import { DEFAULT_COMBO_ID, parameterGrid, tradesIn, type Period } from '../../src/backtest/walk-forward.js';
import { formatIdr, formatPercent } from '../../src/bot/messages/format.js';
import { DEFAULT_COSTS, buyCostRate, sellCostRate } from '../../src/risk/costs.js';
import { STRATEGY_DEFAULTS } from '../../src/strategy/config.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import { detectBreakout, windowAtr, type BreakoutParams } from './lib/breakout.js';
import { costScenarios, type CostScenario } from './lib/cost-scenarios.js';
import { assertNoHoldout, experimentPeriods, hideHoldout, loadExpSeries, loadPairFees, type ExpSeries } from './lib/series.js';
import { simulateExperiment, type ExpResult, type ExpTrade, type TfSetup, type Variant } from './lib/sim.js';

const TZ = DEFAULT_SETTINGS.timezone;
const PRIMARY = ['doge_idr', 'xrp_idr'];
const COMPARISON = ['qnt_idr', 'link_idr'];
const ALL = [...PRIMARY, ...COMPARISON];

const settings = defaultStrategySettings();
const capital = settings.limits.capital;
const out: string[] = [];
const log = (line = '') => {
  out.push(line);
  console.log(line);
};
const section = (t: string) => log(`\n## ${t}\n`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const idr = (v: Dec | null) => (v === null ? 'n/a' : v.lt(0) ? `−${formatIdr(v.abs().toDecimalPlaces(0))}` : formatIdr(v.toDecimalPlaces(0)));
const r2 = (v: Dec | number | null) => (v === null ? 'n/a' : (typeof v === 'number' ? v : v.toNumber()).toFixed(2));

// ---------------------------------------------------------------- data
const fees = loadPairFees();
const full: ExpSeries[] = ALL.map((p) => loadExpSeries(p));
const periods = experimentPeriods(full);
const dev = periods.development;
// Holdout: physically removed here, before anything else reads the series.
const series = hideHoldout(full, periods.holdout.start);
full.length = 0;
assertNoHoldout(series, periods.holdout.start);
const universe = (pairs: string[]) => series.filter((s) => pairs.includes(s.pair));

const scenarios = costScenarios(fees);
const C = Object.fromEntries(scenarios.map((s) => [s.id, s])) as Record<string, CostScenario>;

const TF15: TfSetup = { id: '15m/1j', label: 'entry 15m, tren 1j (produksi)', main: '15', trend: '60', regime: STRATEGY_DEFAULTS.regime, candles24h: 96 };
const TF60: TfSetup = {
  id: '1j/4j',
  label: 'entry 1j, tren 4j',
  main: '60',
  trend: '240',
  regime: { ...STRATEGY_DEFAULTS.regime, highVolLookback: 24 },
  candles24h: 24,
};
const timeStop = (tf: TfSetup) => STRATEGY_DEFAULTS.signal.timeStopCandles * (tf.main === '60' ? 4 : 1);

const BO_GRID: BreakoutParams[] = [];
for (const entry of ['pasar', 'konfirmasi', 'retest'] as const) {
  for (const tp of ['resistance', 'atr'] as const) {
    for (const maxExtAtr of [0.5, 1.0]) BO_GRID.push({ entry, tp, tpAtr: 3, maxExtAtr, marketSlipPct: new Dec(DEFAULT_COSTS.stopSlippagePct) });
  }
}
const boId = (b: BreakoutParams) => `BO-${b.entry}-${b.tp === 'atr' ? `atr${b.tpAtr}` : 'res'}-ext${b.maxExtAtr}`;

function variantsFor(tf: TfSetup): Variant[] {
  const v: Variant[] = [];
  const pull = (id: string, group: string, cfg = STRATEGY_DEFAULTS, cost = C.C0_produksi!) =>
    v.push({ kind: 'pullback', id, group, cfg, cost, timeStopPath: timeStop(tf) });
  pull(`${tf.id} pullback default · C0`, tf.main === '15' ? 'baseline' : 'E1');
  for (const c of ['C1_taker', 'C2_maker_ideal', 'C3_campuran']) pull(`${tf.id} pullback default · ${c.slice(0, 2)}`, 'E3', STRATEGY_DEFAULTS, C[c]!);
  if (tf.main === '60') {
    for (const g of parameterGrid()) if (g.id !== DEFAULT_COMBO_ID) pull(`${tf.id} pullback ${g.id} · C0`, 'E1-grid', g.cfg);
  }
  for (const bo of BO_GRID) {
    for (const c of scenarios) {
      v.push({ kind: 'breakout', id: `${tf.id} ${boId(bo)} · ${c.id.slice(0, 2)}`, group: c.id === 'C0_produksi' ? 'E2' : 'E2-E3', cfg: STRATEGY_DEFAULTS, cost: c, timeStopPath: timeStop(tf), bo });
    }
  }
  return v;
}

const simBase = { limits: settings.limits, maxAllocPct: settings.maxAllocPct, activeHours: settings.activeHours, timeZone: TZ, start: dev.start, end: dev.end };
const runs: { universe: string; tf: TfSetup; results: ExpResult[]; seconds: number }[] = [];
for (const [uName, pairs] of [
  ['DOGE+XRP', PRIMARY],
  ['4 pair', ALL],
] as const) {
  for (const tf of [TF15, TF60]) {
    const t0 = Date.now();
    const results = simulateExperiment({
      ...simBase,
      series: universe([...pairs]),
      tf,
      variants: variantsFor(tf),
      onProgress: (at) => at.getUTCDate() === 1 && process.stderr.write(`  ${uName} ${tf.id}: ${day(at)}\n`),
    });
    runs.push({ universe: uName, tf, results, seconds: (Date.now() - t0) / 1000 });
  }
}

// Production simulator (unchanged) on the same truncated data, for the baseline cross-check.
const prodCheck = (pairs: string[]) => {
  const [r] = simulate({ ...simBase, series: universe(pairs), costs: C.C0_produksi!.planning, combos: [parameterGrid().find((g) => g.id === DEFAULT_COMBO_ID)!] });
  return r!;
};
const prodPrimary = prodCheck(PRIMARY);
const prodAll = prodCheck(ALL);

// ---------------------------------------------------------------- helpers
const m = (t: ExpTrade[]) => computeMetrics(t, capital, TZ);
const totalCost = (x: Metrics) => x.totalFees.plus(x.totalTaxes).plus(x.totalSlippage);
const find = (u: string, id: string) => {
  for (const run of runs) if (run.universe === u) for (const r of run.results) if (r.variant.id === id) return r;
  throw new Error(`variant ${id} (${u}) tidak ada`);
};
const pfText = (x: Metrics) => (x.trades === 0 ? 'n/a' : x.profitFactor === null ? 'n/a (tanpa rugi)' : r2(x.profitFactor));
function row(r: ExpResult, trades = r.trades): string {
  const x = m(trades);
  if (x.trades === 0) return `| ${r.variant.id} | ${r.signals} | 0 | tidak dapat dihitung | – | – | – | – | – |`;
  const ci = x.expectancyRCi95 ? ` [${x.expectancyRCi95[0].toFixed(2)}…${x.expectancyRCi95[1].toFixed(2)}]` : '';
  return `| ${r.variant.id} | ${r.signals} | ${x.trades} | ${idr(x.expectancyIdr)} · ${r2(x.expectancyR)} R${ci} | ${pfText(x)} | ${idr(x.maxDrawdownIdr)} (${formatPercent(x.maxDrawdownPct)}) | ${idr(totalCost(x))} | ${idr(x.totalNet)} | ${x.winRatePct ? formatPercent(x.winRatePct, 0) : 'n/a'} |`;
}
const HEADER = [
  '| Varian | Sinyal | Trade | Expectancy bersih / trade (95% CI R) | Profit factor | Max drawdown | Total biaya | Total bersih | Win rate |',
  '|---|---:|---:|---|---:|---:|---:|---:|---:|',
];
const table = (rs: ExpResult[]) => {
  for (const h of HEADER) log(h);
  for (const r of rs) log(row(r));
};
const perPair = (r: ExpResult, pairs: string[]) => {
  log(`\n**${r.variant.id}** — per pair (universe 4 pair, slot posisi dipakai bersama):\n`);
  log('| Pair | Trade | Expectancy bersih | Profit factor | Max DD | Total biaya | Total bersih |');
  log('|---|---:|---|---:|---:|---:|---:|');
  for (const p of pairs) {
    const x = m(r.trades.filter((t) => t.pair === p));
    const tag = COMPARISON.includes(p) ? ' ⚠ likuiditas' : '';
    if (x.trades === 0) log(`| ${p}${tag} | 0 | tidak dapat dihitung | – | – | – | – |`);
    else log(`| ${p}${tag} | ${x.trades} | ${idr(x.expectancyIdr)} · ${r2(x.expectancyR)} R | ${pfText(x)} | ${idr(x.maxDrawdownIdr)} | ${idr(totalCost(x))} | ${idr(x.totalNet)} |`);
  }
};

// ---------------------------------------------------------------- report
log('# Eksperimen lanjutan M4 — timeframe, breakout, biaya (DATA PENGEMBANGAN SAJA)');
log(`\nDibuat ${new Date().toISOString()} · kode produksi, parameter default, database, dan watchlist TIDAK diubah.`);
log(`\nPeriode pengembangan: ${day(dev.start)} → ${day(dev.end)} (${dev.label}). Holdout ${day(periods.holdout.start)} → ${day(periods.holdout.end)}: **terkunci, tidak dijalankan, candle-nya dihapus sebelum simulasi** (dicek oleh assertNoHoldout).`);
log(`Modal Rp${capital.toFixed()} · risiko/trade ${settings.limits.riskPerTradePct.toFixed()}% · batas harian ${settings.limits.dailyLossLimitPct.toFixed()}% · maks ${settings.limits.maxDailyRecommendations} sinyal/hari · 1 posisi · jam ${settings.activeHours.start}–${settings.activeHours.end} WIB · R/R bersih minimum ${STRATEGY_DEFAULTS.minNetRr}`);

section('0. Asumsi biaya (eksperimen 3) — semua tarif belum terverifikasi = ASUMSI');
for (const s of scenarios) {
  log(`- **${s.id}** — ${s.label}`);
  for (const a of s.assumptions) log(`  - ${a}`);
}

section('1. Data dan likuiditas per pair (periode pengembangan)');
log('| Pair | Peran | Candle vol 0 (15m / 1j / 4j) | Median nilai transaksi harian | Spread sampel (live, konstan) |');
log('|---|---|---|---:|---:|');
for (const s of series) {
  const inDev = <T extends { openTime: Date }>(cs: T[]) => cs.filter((c) => c.openTime >= dev.start && c.openTime < dev.end);
  const z = (cs: ExpSeries['c15']) => formatPercent(new Dec(inDev(cs).filter((c) => c.volume.isZero()).length).div(Math.max(inDev(cs).length, 1)).times(100), 0);
  const byDay = new Map<string, Dec>();
  for (const c of inDev(s.c15)) byDay.set(day(c.openTime), (byDay.get(day(c.openTime)) ?? new Dec(0)).plus(c.close.times(c.volume)));
  const vals = [...byDay.values()].sort((a, b) => a.comparedTo(b));
  const med = vals[Math.floor(vals.length / 2)] ?? null;
  log(`| ${s.pair} | ${PRIMARY.includes(s.pair) ? 'fokus' : 'pembanding ⚠'} | ${z(s.c15)} / ${z(s.c60)} / ${z(s.c240)} | ${idr(med)} | ${formatPercent(s.spreadPct)} |`);
}
log('\n⚠ QNT: mayoritas candle 15m tanpa transaksi → indikator sering "kurang andal", fill sangat tidak pasti. ⚠ LINK: spread sampel > batas G7 (0,4%) → dengan asumsi spread konstan, LINK praktis tidak pernah lolos. Hasil kedua pair ini hanya pembanding, bukan dasar keputusan.');

section('2. Validasi simulator eksperimen terhadap simulator produksi');
for (const [u, prod] of [
  ['DOGE+XRP', prodPrimary],
  ['4 pair', prodAll],
] as const) {
  const mine = find(u, '15m/1j pullback default · C0');
  const a = sum(prod.trades.map((t) => t.netPnl));
  const b = sum(mine.trades.map((t) => t.netPnl));
  const same = prod.trades.length === mine.trades.length && a.eq(b) && prod.signals === mine.signals;
  log(`- ${u}: produksi ${prod.signals} sinyal / ${prod.trades.length} trade / total ${idr(a)} · eksperimen ${mine.signals} / ${mine.trades.length} / ${idr(b)} → ${same ? '**identik** ✅' : '**BERBEDA** ❌'}`);
}
log(`- Waktu simulasi: ${runs.map((r) => `${r.universe} ${r.tf.id} ${r.seconds.toFixed(0)} dtk`).join(' · ')}`);

for (const u of ['DOGE+XRP', '4 pair']) {
  const all = runs.filter((r) => r.universe === u).flatMap((r) => r.results);
  section(`3${u === '4 pair' ? 'b' : 'a'}. Hasil — universe ${u}${u === '4 pair' ? ' (QNT & LINK pembanding, keterbatasan likuiditas)' : ' (fokus)'}`);
  log('**Baseline vs eksperimen 1 (timeframe) — biaya C0 produksi**\n');
  table(all.filter((r) => r.variant.kind === 'pullback' && r.variant.cost.id === 'C0_produksi'));
  log('\n**Eksperimen 2 (breakout) — biaya C0 produksi**\n');
  table(all.filter((r) => r.variant.kind === 'breakout' && r.variant.cost.id === 'C0_produksi'));
  log('\n**Eksperimen 3 (biaya) — strategi yang sama, skenario fee berbeda**\n');
  table(all.filter((r) => r.variant.kind === 'pullback' && r.variant.id.includes('default')));
  log('');
  const boC = all.filter((r) => r.variant.kind === 'breakout');
  for (const h of HEADER) log(h);
  for (const r of boC) log(row(r));
}

section('4. Hasil per pair (universe 4 pair)');
for (const id of ['15m/1j pullback default · C0', '1j/4j pullback default · C0', '1j/4j BO-pasar-res-ext0.5 · C0', '1j/4j BO-konfirmasi-res-ext0.5 · C0', '1j/4j BO-retest-res-ext0.5 · C0', '15m/1j BO-pasar-res-ext0.5 · C0']) {
  perPair(find('4 pair', id), ALL);
}

section('5. Diagnostik breakout (universe DOGE+XRP, biaya C0)');
const mainOf = (tf: TfSetup, s: ExpSeries) => (tf.main === '15' ? s.c15 : s.c60);
const FALSE_N = 4;
const isFalse = (tf: TfSetup, t: ExpTrade) => {
  const s = series.find((x) => x.pair === t.pair)!;
  const cs = mainOf(tf, s);
  const i = cs.findIndex((c) => c.openTime.getTime() === t.breakoutOpenTime!.getTime());
  return cs.slice(i + 1, i + 1 + FALSE_N).some((c) => c.close.lte(t.zoneHigh!));
};
for (const run of runs.filter((r) => r.universe === 'DOGE+XRP')) {
  log(`\n**${run.tf.id}** — false breakout = close kembali ≤ puncak zona dalam ${FALSE_N} candle setelah candle breakout\n`);
  log('| Varian | Sinyal | Batal sebelum isi (alasan) | Trade | False breakout (trade) | Exp R false / tidak | Jarak isi dari zona (median ATR) | Gap open−close (median ATR) |');
  log('|---|---:|---|---:|---:|---|---:|---:|');
  for (const r of run.results.filter((x) => x.variant.kind === 'breakout' && x.variant.cost.id === 'C0_produksi')) {
    const cancels = Object.entries(r.cancelled).map(([k, v]) => `${k}: ${v}`).join('; ') || '–';
    const withZone = r.trades.filter((t) => t.zoneHigh && t.breakoutOpenTime);
    const fb = withZone.filter((t) => isFalse(run.tf, t));
    const ok = withZone.filter((t) => !isFalse(run.tf, t));
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!.toFixed(2) : 'n/a');
    const expR = (ts: ExpTrade[]) => (ts.length ? r2(m(ts).expectancyR) : 'n/a');
    log(`| ${r.variant.id} | ${r.signals} | ${cancels} | ${r.trades.length} | ${withZone.length ? `${fb.length}/${withZone.length} (${formatPercent(new Dec(fb.length).div(withZone.length).times(100), 0)})` : 'n/a'} | ${expR(fb)} / ${expR(ok)} | ${med(withZone.map((t) => t.fillExtAtr ?? NaN).filter(Number.isFinite))} | ${med(withZone.map((t) => t.gapAtr ?? NaN).filter(Number.isFinite))} |`);
  }
}

// Raw breakout events, no filters at all: how often does a close above a zone fail?
log('\n**Semua breakout mentah (tanpa filter regime/volume/R-R), periode pengembangan**\n');
log('| Timeframe | Pair | Breakout | False breakout ≤4 candle | Candle breakout dibuka di atas zona (gap) |');
log('|---|---|---:|---:|---:|');
for (const tf of [TF15, TF60]) {
  for (const s of series) {
    const cs = mainOf(tf, s);
    let n = 0;
    let f = 0;
    let gap = 0;
    for (let i = 300; i < cs.length - FALSE_N; i++) {
      if (cs[i]!.openTime < dev.start || cs[i]!.openTime >= dev.end) continue;
      const w = cs.slice(i - 299, i + 1);
      const z = detectBreakout(w, w.length - 1, windowAtr(w));
      if (!z) continue;
      n++;
      if (z.openedAbove) gap++;
      if (cs.slice(i + 1, i + 1 + FALSE_N).some((c) => c.close.lte(z.high))) f++;
    }
    log(`| ${tf.id} | ${s.pair}${COMPARISON.includes(s.pair) ? ' ⚠' : ''} | ${n} | ${n ? `${f} (${formatPercent(new Dec(f).div(n).times(100), 0)})` : 'n/a'} | ${gap} |`);
  }
}

section('6. Stabilitas per sub-periode (universe DOGE+XRP, C0)');
const thirds: Period[] = [0, 3, 6].map((k) => ({ label: `bulan ${k + 1}–${k + 3}`, start: periods.blocks[k]!.start, end: periods.blocks[k + 2]!.end }));
log(`| Varian | ${thirds.map((p) => p.label).join(' | ')} |`);
log(`|---|${thirds.map(() => '---').join('|')}|`);
for (const r of runs.filter((x) => x.universe === 'DOGE+XRP').flatMap((x) => x.results).filter((x) => x.variant.cost.id === 'C0_produksi' && (x.variant.id.includes('default') || x.variant.kind === 'breakout'))) {
  log(`| ${r.variant.id} | ${thirds.map((p) => { const x = m(tradesIn(r.trades, p) as ExpTrade[]); return x.trades ? `${x.trades} tr · ${r2(x.expectancyR)} R` : '0 tr · n/a'; }).join(' | ')} |`);
}

section('7. Pembanding pasif: buy & hold periode pengembangan (biaya C0)');
for (const s of series) {
  const inside = s.c15.filter((c) => c.openTime >= dev.start && c.openTime < dev.end);
  const cost = inside[0]!.open.times(Dec.add(1, buyCostRate(C.C0_produksi!.planning)));
  const proceeds = inside.at(-1)!.close.times(Dec.sub(1, sellCostRate(C.C0_produksi!.planning)));
  log(`- ${s.pair}: ${formatPercent(proceeds.minus(cost).div(cost).times(100))}`);
}

section('8. Penolakan per syarat (universe DOGE+XRP, C0) — langkah keputusan × pair');
for (const id of ['15m/1j pullback default · C0', '1j/4j pullback default · C0', '1j/4j BO-pasar-res-ext0.5 · C0', '15m/1j BO-pasar-res-ext0.5 · C0']) {
  const r = find('DOGE+XRP', id);
  log(`\n**${id}**: ${Object.entries(r.rejections).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
}

section('Keterbatasan');
for (const c of [
  'Semua fill adalah ESTIMASI (tanpa data antrean order). Order book, arus trade, dan spread historis tidak tersedia: G8 dinetralkan, spread konstan dari satu sampel live → hasil cenderung optimistis.',
  'Entry pasar breakout diisi di open candle 15m berikutnya; open itu terjadi ±90 detik sebelum keputusan (sama dengan pendekatan simulator produksi). Slippage pasar 0,15% + setengah spread adalah ASUMSI.',
  'Banyak varian diuji pada data yang sama (±110 varian): varian terbaik di tabel ini kemungkinan besar terlihat lebih baik daripada sebenarnya (multiple comparisons / data snooping). Jangan memilih varian hanya dari peringkat di sini.',
  'Sampel trade kecil; interval kepercayaan expectancy lebar. Hasil backtest TIDAK membuktikan strategi profitable.',
  'Fee maker/taker dari /api/pairs dan pajak 0,11% belum diverifikasi dengan bukti transaksi (ASUMSI). Maker pada skenario C3 hanya untuk limit yang benar-benar menunggu di bawah ask/TP, dan tetap tidak menjamin order terisi.',
  'Hanya 4 pair yang masih aktif hari ini (bias survivorship), satu periode pasar.',
]) log(`- ${c}`);

const dir = 'experiments/m4-followup/reports';
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join(dir, `report-${stamp}.md`), out.join('\n'));
writeFileSync(
  join(dir, `report-${stamp}.json`),
  JSON.stringify(
    toJsonSafe({
      periods: { development: dev, holdout: { start: periods.holdout.start, end: periods.holdout.end, status: 'terkunci — tidak dijalankan' } },
      runs: runs.map((r) => ({ universe: r.universe, tf: r.tf.id, results: r.results.map((x) => ({ id: x.variant.id, signals: x.signals, expired: x.expiredUnfilled, cancelled: x.cancelled, metrics: m(x.trades), trades: x.trades })) })),
    }),
    null,
    1,
  ),
);
console.log(`\nLaporan: ${join(dir, `report-${stamp}.md`)}`);
