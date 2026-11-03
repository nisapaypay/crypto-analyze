/**
 * Freeze real Indodax OHLC history for deterministic indicator tests
 * (tests/fixtures/analysis). Only candles that are final at recording time
 * are kept; raw response format (numbers vs strings, exact digits) is preserved.
 *
 * Usage: pnpm exec tsx scripts/record-analysis-fixtures.ts
 * Then regenerate golden values: pnpm exec tsx scripts/update-golden.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://indodax.com';
const OUT = join(import.meta.dirname, '..', 'tests', 'fixtures', 'analysis');
const PAIRS = ['QNTIDR', 'DOGEIDR', 'XRPIDR', 'LINKIDR'];
const TIMEFRAMES = [
  { tf: '15', seconds: 900 },
  { tf: '60', seconds: 3600 },
];
const COUNT = 300;
const SETTLE_SEC = 90;

type Num = { __num: string };
const isNum = (v: unknown): v is Num => typeof v === 'object' && v !== null && '__num' in v;
const parseMarked = (text: string) =>
  JSON.parse(text, (_k, v: unknown, ctx?: { source?: string }) => (typeof v === 'number' ? { __num: ctx?.source ?? String(v) } : v));
const stringifyMarked = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) => (isNum(v) ? `\u0000${v.__num}\u0000` : v), 2).replace(/"\\u0000([^"\\]+)\\u0000"/g, '$1') + '\n';

mkdirSync(OUT, { recursive: true });
const recordedAt = Math.floor(Date.now() / 1000);

for (const symbol of PAIRS) {
  for (const { tf, seconds } of TIMEFRAMES) {
    const from = recordedAt - seconds * (COUNT + 10);
    const res = await fetch(`${BASE}/tradingview/history_v2?from=${from}&symbol=${symbol}&tf=${tf}&to=${recordedAt}`);
    const candles = parseMarked(await res.text()) as { Time: Num | string }[];
    const time = (c: { Time: Num | string }) => Number(isNum(c.Time) ? c.Time.__num : c.Time);
    const final = candles.filter((c) => time(c) + seconds + SETTLE_SEC <= recordedAt).slice(-COUNT);
    const name = `${symbol.toLowerCase().replace(/idr$/, '_idr')}-${tf}.json`;
    writeFileSync(join(OUT, name), stringifyMarked({ symbol, tf, recordedAt, candles: final }));
    console.log(`${name}: ${final.length} final candles`);
  }
}
