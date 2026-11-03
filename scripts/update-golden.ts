/**
 * Regenerate golden indicator values from the frozen fixtures.
 * Run only after an intentional engine change (and bump engineVersion);
 * review the diff before committing.
 *
 * Usage: pnpm exec tsx scripts/update-golden.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANALYSIS_DEFAULTS } from '../src/analysis/config.js';
import { computeTechnicalAnalysis } from '../src/analysis/engine.js';
import { goldenView } from '../tests/helpers/golden.js';
import { FIXTURE_PAIRS, fixtureMarketData, GOLDEN_DIR } from '../tests/helpers/analysis-fixtures.js';

mkdirSync(GOLDEN_DIR, { recursive: true });
for (const pair of FIXTURE_PAIRS) {
  const { data, now } = fixtureMarketData(pair);
  const analysis = computeTechnicalAnalysis(data, ANALYSIS_DEFAULTS, now, 90);
  writeFileSync(join(GOLDEN_DIR, `${pair}.json`), JSON.stringify(goldenView(analysis), null, 2) + '\n');
  console.log(`golden/${pair}.json written (engine ${analysis.engineVersion})`);
}
