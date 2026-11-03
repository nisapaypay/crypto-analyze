/**
 * Cross-check: the experiment simulator must reproduce the production
 * simulator trade-for-trade. With default gates the development period gives
 * 0 trades (nothing to compare), so both run here with LOOSENED gates (for
 * validation only — not a strategy proposal). Development data only.
 *
 *   pnpm exec tsx experiments/m4-followup/validate.ts
 */
import { DEFAULT_SETTINGS } from '../../src/app/config/defaults.js';
import { simulate } from '../../src/backtest/simulator.js';
import { STRATEGY_DEFAULTS, withStrategyOverrides } from '../../src/strategy/config.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import { costScenarios } from './lib/cost-scenarios.js';
import { assertNoHoldout, experimentPeriods, hideHoldout, loadExpSeries, loadPairFees } from './lib/series.js';
import { simulateExperiment } from './lib/sim.js';

const settings = defaultStrategySettings();
const full = ['doge_idr', 'xrp_idr'].map((p) => loadExpSeries(p));
const periods = experimentPeriods(full);
const series = hideHoldout(full, periods.holdout.start);
assertNoHoldout(series, periods.holdout.start);
const cost = costScenarios(loadPairFees()).find((c) => c.id === 'C0_produksi')!;
const cfg = withStrategyOverrides({ gates: { rsiMin: 40, rsiMax: 85, volumeRatioMin: 0.8, maxExtensionAtr: 3 }, minNetRr: 1.2 });
const base = { limits: settings.limits, maxAllocPct: settings.maxAllocPct, activeHours: settings.activeHours, timeZone: DEFAULT_SETTINGS.timezone, start: periods.development.start, end: periods.development.end };

const [prod] = simulate({ ...base, series, costs: cost.planning, combos: [{ id: 'longgar', cfg }] });
const [exp] = simulateExperiment({
  ...base,
  series,
  tf: { id: '15m/1j', label: '', main: '15', trend: '60', regime: STRATEGY_DEFAULTS.regime, candles24h: 96 },
  variants: [{ kind: 'pullback', id: 'longgar', group: 'validasi', cfg, cost, timeStopPath: STRATEGY_DEFAULTS.signal.timeStopCandles }],
});
const key = (t: { pair: string; entryAt: Date; exitAt: Date; entryFill: { toFixed(): string }; exitPrice: { toFixed(): string }; netPnl: { toFixed(): string } }) =>
  `${t.pair} ${t.entryAt.toISOString()} ${t.exitAt.toISOString()} ${t.entryFill.toFixed()} ${t.exitPrice.toFixed()} ${t.netPnl.toFixed()}`;
const a = prod!.trades.map(key);
const b = exp!.trades.map(key);
const diff = a.filter((x, i) => x !== b[i]).length + Math.abs(a.length - b.length);
console.log(`Produksi: ${prod!.signals} sinyal, ${a.length} trade · Eksperimen: ${exp!.signals} sinyal, ${b.length} trade · trade berbeda: ${diff}`);
console.log(diff === 0 && prod!.signals === exp!.signals ? 'IDENTIK ✅' : 'BERBEDA ❌');
process.exitCode = diff === 0 ? 0 : 1;
