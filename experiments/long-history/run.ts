/**
 * Simulate every variant over the whole DEVELOPMENT period for one universe and
 * one timeframe setup; walk-forward selection happens in report.ts. No holdout
 * data exists in the loaded dataset (checked), no database, no lock file.
 *
 *   pnpm exec tsx experiments/long-history/run.ts --universe fokus|semua --tf 15|60
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../../src/app/config/defaults.js';
import { Dec } from '../../src/app/decimal.js';
import { parameterGrid } from '../../src/backtest/walk-forward.js';
import { DEFAULT_COSTS } from '../../src/risk/costs.js';
import { STRATEGY_DEFAULTS } from '../../src/strategy/config.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import type { BreakoutParams } from '../m4-followup/lib/breakout.js';
import { costScenarios } from '../m4-followup/lib/cost-scenarios.js';
import type { PairFees } from '../m4-followup/lib/series.js';
import { simulateExperiment, type TfSetup, type Variant } from '../m4-followup/lib/sim.js';
import { ALL_PAIRS, LONG_DATA_DIR, LONG_REPORT_DIR, PRIMARY } from './config.js';
import { DEV, loadDevSeries } from './lib/periods.js';
import { tradeToJson, type RawRun } from './lib/serialize.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const universe = arg('universe') ?? 'fokus';
const tfArg = arg('tf') ?? '60';
if (!['fokus', 'semua'].includes(universe) || !['15', '60'].includes(tfArg)) throw new Error('--universe fokus|semua --tf 15|60');

export const TF15: TfSetup = { id: '15m/1j', label: 'entry 15m, tren 1j (produksi)', main: '15', trend: '60', regime: STRATEGY_DEFAULTS.regime, candles24h: 96 };
export const TF60: TfSetup = { id: '1j/4j', label: 'entry 1j, tren 4j', main: '60', trend: '240', regime: { ...STRATEGY_DEFAULTS.regime, highVolLookback: 24 }, candles24h: 24 };
const tf = tfArg === '15' ? TF15 : TF60;
const timeStopPath = STRATEGY_DEFAULTS.signal.timeStopCandles * (tf.main === '60' ? 4 : 1);

const manifest = JSON.parse(readFileSync(join(LONG_DATA_DIR, 'manifest.json'), 'utf8')) as { pairs: Record<string, { takerFeePct: string | null; makerFeePct: string | null }>; createdAt: string };
const fees: Record<string, PairFees> = Object.fromEntries(
  Object.entries(manifest.pairs).map(([p, v]) => [p, { takerFeePct: v.takerFeePct, makerFeePct: v.makerFeePct, fetchedAt: manifest.createdAt }]),
);
const scenarios = costScenarios(fees);

const variants: (Variant & { family: string; paramId: string })[] = [];
const pullbackFamily = tf.main === '15' ? 'baseline-15m1j' : 'pullback-1j4j';
for (const g of parameterGrid()) {
  for (const c of scenarios) {
    variants.push({ kind: 'pullback', id: `${pullbackFamily} ${g.id} · ${c.id}`, group: pullbackFamily, family: pullbackFamily, paramId: g.id, cfg: g.cfg, cost: c, timeStopPath });
  }
}
if (tf.main === '60') {
  for (const entry of ['konfirmasi', 'retest'] as const) {
    for (const tp of ['resistance', 'atr'] as const) {
      for (const maxExtAtr of [0.5, 1.0]) {
        const bo: BreakoutParams = { entry, tp, tpAtr: 3, maxExtAtr, marketSlipPct: new Dec(DEFAULT_COSTS.stopSlippagePct) };
        const paramId = `${tp === 'atr' ? 'atr3' : 'res'}-ext${maxExtAtr}`;
        for (const c of scenarios) {
          variants.push({ kind: 'breakout', id: `bo-${entry} ${paramId} · ${c.id}`, group: `bo-${entry}`, family: `bo-${entry}`, paramId, cfg: STRATEGY_DEFAULTS, cost: c, timeStopPath, bo });
        }
      }
    }
  }
}

const settings = defaultStrategySettings();
const series = loadDevSeries(universe === 'fokus' ? PRIMARY : ALL_PAIRS);
const t0 = Date.now();
const results = simulateExperiment({
  series,
  tf,
  variants,
  start: DEV.start,
  end: DEV.end,
  limits: settings.limits,
  maxAllocPct: settings.maxAllocPct,
  activeHours: settings.activeHours,
  timeZone: DEFAULT_SETTINGS.timezone,
  onProgress: (at) => at.getUTCDate() === 1 && process.stderr.write(`  ${universe} ${tf.id}: ${at.toISOString().slice(0, 10)}\n`),
});
const run: RawRun = {
  universe,
  tf: tf.id,
  createdAt: new Date().toISOString(),
  seconds: (Date.now() - t0) / 1000,
  variants: results.map((r, i) => ({
    id: r.variant.id,
    family: variants[i]!.family,
    paramId: variants[i]!.paramId,
    costId: r.variant.cost.id,
    signals: r.signals,
    signalTimes: r.signalTimes.map((d) => d.toISOString()),
    expiredUnfilled: r.expiredUnfilled,
    cancelled: r.cancelled,
    rejections: r.rejections,
    trades: r.trades.map(tradeToJson),
  })),
};
const dir = join(LONG_REPORT_DIR, 'raw');
mkdirSync(dir, { recursive: true });
const path = join(dir, `${universe}-${tfArg}.json`);
writeFileSync(path, JSON.stringify(run));
console.log(`${universe} ${tf.id}: ${variants.length} varian, ${run.seconds.toFixed(0)} dtk → ${path}`);
