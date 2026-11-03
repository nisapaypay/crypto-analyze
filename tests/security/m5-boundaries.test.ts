import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Milestone 5 separation of responsibilities: the scheduler, notifier and
 * entry monitor may READ recommendations but never write trading_signals,
 * advance a lifecycle, or produce a BUY decision themselves. Decisions come
 * only from the M4 StrategyService, wired in src/main.ts.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const list = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

const M5_FILES = [...list('src/scheduler'), ...list('src/notify')];
const MONITOR_FILES = ['src/scheduler/entry-monitor.ts', 'src/scheduler/active-buys.ts'];
const importsOf = (src: string) => [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
/** Imports that bring runtime values (not `import type`). */
const valueImportsOf = (src: string) => [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
const ENGINE = /(strategy\/(strategy-engine|strategy-service|plan|gates|lifecycle|signal-repository)|risk\/(risk-ledger|position-sizing|stop-loss|take-profit))\.js$/;
const WRITE = /tradingSignal\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;

describe('M5 boundaries', () => {
  it('scans the M5 sources', () => {
    expect(M5_FILES.length).toBeGreaterThan(15);
    expect(M5_FILES).toEqual(expect.arrayContaining(MONITOR_FILES));
  });

  it.each(M5_FILES)('%s never writes trading_signals or advances a lifecycle', (file) => {
    const src = read(file);
    expect(src).not.toMatch(WRITE);
    expect(src).not.toMatch(/\bupdateLifecycle\b/);
    expect(src).not.toMatch(/\badvanceLifecycle\b/);
    expect(src).not.toMatch(/\.record\(\s*d\b|signals\.record\(/);
  });

  it.each(M5_FILES)('%s never runs the strategy engine or risk engine itself (type imports only)', (file) => {
    const valueImports = valueImportsOf(read(file));
    expect(valueImports.filter((i) => ENGINE.test(i))).toEqual([]);
  });

  it('the detectors catch violations (self-check)', () => {
    expect(valueImportsOf("import { evaluateStrategy } from '../strategy/strategy-engine.js';").filter((i) => ENGINE.test(i))).toHaveLength(1);
    expect(valueImportsOf("import type { ScanResult } from '../strategy/strategy-service.js';").filter((i) => ENGINE.test(i))).toHaveLength(0);
    expect('await this.prisma.tradingSignal.update({ where: { id } })').toMatch(WRITE);
    expect('await this.prisma.tradingSignal.findMany({})').not.toMatch(WRITE);
  });

  it.each(MONITOR_FILES)('%s (entry monitor) cannot create a BUY or a trading message', (file) => {
    const src = read(file);
    const imports = importsOf(src);
    expect(imports.some((i) => /strategy\/|risk\//.test(i))).toBe(false);
    expect(src).not.toMatch(/buyNotification|earlyWarningNotification|strategyMessage/);
    if (file.endsWith('entry-monitor.ts')) expect(src).not.toMatch(/BUY_CANDIDATE|EARLY_WARNING/);
  });

  it('the read-only BUY reader only uses findMany', () => {
    const src = read('src/scheduler/active-buys.ts');
    expect([...src.matchAll(/this\.prisma\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual(['tradingSignal.findMany']);
  });

  it('the entry monitor only advises through the notifier with kind ADVICE_DO_NOT_ENTER (main.ts wiring)', () => {
    const main = read('src/main.ts');
    const block = main.slice(main.indexOf('new EntryMonitor('), main.indexOf('maxTicksPerSignal'));
    expect(block).toContain("kind: 'ADVICE_DO_NOT_ENTER'");
    expect(block).not.toMatch(/BUY_CANDIDATE|EARLY_WARNING|strategy\.scan|signals\.record/);
    expect(block).toContain('guardedMarket.refresh(pair, { force: true })');
  });

  it('M5 code never relaxes trading limits or touches capital/risk settings', () => {
    for (const file of M5_FILES) {
      const src = read(file);
      expect(src, relative(ROOT, join(ROOT, file))).not.toMatch(/userSettings\.(update|upsert)\b(?![\s\S]{0,80}scanningEnabled)/);
      expect(src).not.toMatch(/\b(capital|riskPerTrade|dailyLossLimit|maxDailyTrades)\s*:/);
    }
  });
});
