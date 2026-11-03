import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'indodax');

/** Raw response text recorded from the real Indodax Public API. */
export function fixture(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

export interface MockRoute {
  body: string;
  status?: number;
  headers?: Record<string, string>;
}

/** fetch mock that routes by URL path (query string ignored). */
export function routedFetch(routes: Record<string, MockRoute | (() => MockRoute)>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    if (!route) return new Response('not found', { status: 404 });
    const r = typeof route === 'function' ? route() : route;
    return new Response(r.body, { status: r.status ?? 200, headers: r.headers ?? {} });
  });
}

export const noRetry = { retries: 0, baseDelayMs: 0 };
