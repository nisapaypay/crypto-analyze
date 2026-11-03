import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_DEFAULTS } from '../../src/analysis/config.js';
import { computeTechnicalAnalysis } from '../../src/analysis/engine.js';
import { FIXTURE_PAIRS, fixtureMarketData, GOLDEN_DIR } from '../helpers/analysis-fixtures.js';
import { goldenView } from '../helpers/golden.js';

/**
 * Golden values computed from frozen, real Indodax history. Any engine change
 * that alters a value fails here; regenerate deliberately with
 * `pnpm exec tsx scripts/update-golden.ts` and bump engineVersion.
 */
describe.each(FIXTURE_PAIRS)('golden indicators — %s', (pair) => {
  const { data, now } = fixtureMarketData(pair);
  const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, `${pair}.json`), 'utf8'));

  it('matches the committed golden values exactly', () => {
    expect(goldenView(computeTechnicalAnalysis(data, ANALYSIS_DEFAULTS, now, 90))).toEqual(golden);
  });

  it('is reproducible run after run', () => {
    const a = JSON.stringify(goldenView(computeTechnicalAnalysis(data, ANALYSIS_DEFAULTS, now, 90)));
    const b = JSON.stringify(goldenView(computeTechnicalAnalysis(fixtureMarketData(pair).data, ANALYSIS_DEFAULTS, now, 90)));
    expect(a).toBe(b);
  });

  it('golden file was produced by the current engine version', () => {
    expect(golden.engineVersion).toBe(ANALYSIS_DEFAULTS.engineVersion);
  });
});

describe('golden: LINK (≈ 40% zero-volume history) shows the planned effects', () => {
  const g = JSON.parse(readFileSync(join(GOLDEN_DIR, 'link_idr.json'), 'utf8'));

  it('keeps zero-volume candles in the window (no deletion)', () => {
    expect(g.main.candleCount).toBe(300);
  });

  it('standard ATR is below the traded-only ATR and is flagged', () => {
    expect(Number(g.volatility.atr14.value)).toBeLessThan(Number(g.volatility.atr14Traded.value));
    expect(g.volatility.atr14.reliability).toBe('kurang_andal');
  });
});
