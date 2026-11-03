/**
 * Record real Indodax Public API responses as test fixtures
 * (tests/fixtures/indodax). Responses are trimmed for size while every
 * number keeps its original JSON type (number vs string) and exact digits.
 *
 * Usage: pnpm exec tsx scripts/record-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://indodax.com';
const OUT = join(import.meta.dirname, '..', 'tests', 'fixtures', 'indodax');

type Num = { __num: string };
const isNum = (v: unknown): v is Num => typeof v === 'object' && v !== null && '__num' in v;

function parseMarked(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown, ctx?: { source?: string }) =>
    typeof v === 'number' ? { __num: ctx?.source ?? String(v) } : v,
  );
}

function stringifyMarked(value: unknown): string {
  const json = JSON.stringify(value, (_k, v: unknown) => (isNum(v) ? `\u0000${v.__num}\u0000` : v), 2);
  return json.replace(/"\\u0000([^"\\]+)\\u0000"/g, '$1') + '\n';
}

async function fetchText(path: string): Promise<string> {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  return res.text();
}

mkdirSync(OUT, { recursive: true });
const save = (name: string, value: unknown) => writeFileSync(join(OUT, name), stringifyMarked(value));
const now = Math.floor(Date.now() / 1000);

const pairs = parseMarked(await fetchText('/api/pairs')) as { id: string; is_maintenance?: Num }[];
const keep = new Set(['qntidr', 'dogeidr', 'xrpidr', 'linkidr', 'btcidr']);
const maintenance = pairs.find((p) => p.is_maintenance && p.is_maintenance.__num !== '0');
save('pairs.json', pairs.filter((p) => keep.has(p.id) || p === maintenance));

save('ticker-qntidr.json', parseMarked(await fetchText('/api/ticker/qntidr')));
save('depth-qntidr.json', parseMarked(await fetchText('/api/depth/qntidr')));
save('trades-qntidr.json', (parseMarked(await fetchText('/api/trades/qntidr')) as unknown[]).slice(0, 20));
const ohlc = parseMarked(await fetchText(`/tradingview/history_v2?from=${now - 86400 * 3}&symbol=QNTIDR&tf=15&to=${now}`)) as unknown[];
save('ohlc-qntidr-15.json', ohlc.slice(-200));
save('error-invalid-pair.json', parseMarked(await fetchText('/api/ticker/notapairidr')));
save('server-time.json', parseMarked(await fetchText('/api/server_time')));

console.log(`Fixtures written to ${OUT} (recorded at ${new Date().toISOString()})`);
