import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guardrail for PRD §1.1 / §15: the codebase must never contain order
 * execution, fund transfer, or Indodax Private API integration.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SCANNED_DIRS = ['src', 'prisma'];
const EXCLUDED = ['src/generated'];

const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /\/tapi\b/i, reason: 'Indodax Private/Trade API endpoint' },
  { pattern: /private-?websocket|private_?ws/i, reason: 'Indodax Private WebSocket' },
  { pattern: /INDODAX_(API|SECRET)_KEY/, reason: 'reading Indodax private credentials' },
  { pattern: /\bcreateHmac\b|\bhmac\b/i, reason: 'request signing (private API)' },
  { pattern: /\b(place|create|submit|cancel)_?orders?\b/i, reason: 'order execution' },
  { pattern: /['"](trade|cancelOrder|withdrawCoin|openOrders)['"]\s*[,}]/, reason: 'Private API method name' },
  { pattern: /\bwithdraw/i, reason: 'fund transfer' },
];

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (EXCLUDED.some((ex) => relative(ROOT, full).startsWith(ex))) return [];
    if (entry.isDirectory()) return listFiles(full);
    return /\.(ts|prisma|sql)$/.test(entry.name) ? [full] : [];
  });
}

describe('no trading functionality', () => {
  const files = SCANNED_DIRS.flatMap((d) => listFiles(join(ROOT, d)));

  it('scans a non-empty set of source files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN)('source contains no $reason', ({ pattern }) => {
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('.env.example keeps Indodax credentials empty', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    expect(example).toMatch(/^INDODAX_API_KEY=$/m);
    expect(example).toMatch(/^INDODAX_SECRET_KEY=$/m);
  });
});
