import { describe, expect, it, vi } from 'vitest';
import { IndodaxApiError, IndodaxPublicRest } from '../../../src/exchange/indodax/public-rest.js';
import { fixture, noRetry, routedFetch } from '../../helpers/fixtures.js';

const BASE = 'https://indodax.com';

function mockFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

function clientWith(fetchFn: typeof fetch, retry = noRetry) {
  return new IndodaxPublicRest(BASE, { fetchFn, retry: { ...retry, sleep: async () => undefined } });
}

describe('IndodaxPublicRest — server time (Milestone 1)', () => {
  it('fetches server time with an unauthenticated GET', async () => {
    const fetchFn = mockFetch({ timezone: 'UTC', server_time: 1793601448174 });
    const result = await clientWith(fetchFn).getServerTime();

    expect(result).toEqual({ timezone: 'UTC', serverTime: new Date(1793601448174) });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://indodax.com/api/server_time');
    expect(init?.method).toBe('GET');
    expect(Object.keys(init?.headers ?? {})).toEqual(['accept']);
  });

  it('throws IndodaxApiError on HTTP errors', async () => {
    await expect(clientWith(mockFetch({}, 503)).getServerTime()).rejects.toMatchObject({ name: 'IndodaxApiError', status: 503 });
  });

  it('rejects responses that do not match the documented schema', async () => {
    await expect(clientWith(mockFetch({ server_time: 'soon' })).getServerTime()).rejects.toBeInstanceOf(IndodaxApiError);
  });
});

describe('IndodaxPublicRest — market data (recorded fixtures)', () => {
  const fetchFn = routedFetch({
    '/api/pairs': { body: fixture('pairs.json') },
    '/api/ticker/qntidr': { body: fixture('ticker-qntidr.json'), headers: { age: '7' } },
    '/api/depth/qntidr': { body: fixture('depth-qntidr.json') },
    '/api/trades/qntidr': { body: fixture('trades-qntidr.json') },
    '/tradingview/history_v2': { body: fixture('ohlc-qntidr-15.json') },
  });
  const client = clientWith(fetchFn);
  const raw = <T>(name: string) => JSON.parse(fixture(name)) as T;

  it('normalizes pairs, including maintenance flags and tick size', async () => {
    const pairs = await client.getPairs();
    const qnt = pairs.find((p) => p.tickerId === 'qnt_idr')!;
    expect(qnt).toMatchObject({ pathId: 'qntidr', symbol: 'QNTIDR', baseAsset: 'qnt', quoteAsset: 'idr', isMaintenance: false, isSuspended: false });
    expect(qnt.tickSize?.toFixed()).toBe('1');
    expect(qnt.quantityIncrement?.toFixed()).toBe('0.00000001');
    expect(qnt.minOrderIdr?.toFixed()).toBe('10000');
    expect(pairs.some((p) => p.isMaintenance)).toBe(true);
  });

  it('normalizes the ticker; times are seconds and Cloudflare Age is captured', async () => {
    const r = raw<{ ticker: Record<string, string | number> }>('ticker-qntidr.json').ticker;
    const t = await client.getTicker('qnt_idr');
    expect(t.last.toFixed()).toBe(String(r.last));
    expect(t.bid.toFixed()).toBe(String(r.buy));
    expect(t.ask.toFixed()).toBe(String(r.sell));
    expect(t.volumeBase24h?.eq(String(r.vol_qnt))).toBe(true);
    expect(t.volumeIdr24h.eq(String(r.vol_idr))).toBe(true);
    expect(t.serverTime.getTime()).toBe(Number(r.server_time) * 1000);
    expect(t.cacheAgeSec).toBe(7);
  });

  it('normalizes the order book: sorted sides, exact string values', async () => {
    const r = raw<{ buy: [string, string][]; sell: [string, string][] }>('depth-qntidr.json');
    const book = await client.getOrderBook('qnt_idr');
    expect(book.bids).toHaveLength(r.buy.length);
    expect(book.asks).toHaveLength(r.sell.length);
    expect(book.bids[0]!.price.toFixed()).toBe(r.buy[0]![0]);
    expect(book.bids[0]!.volume.eq(r.buy[0]![1])).toBe(true);
    expect(book.bids.every((l, i, a) => i === 0 || a[i - 1]!.price.gt(l.price))).toBe(true);
    expect(book.asks.every((l, i, a) => i === 0 || a[i - 1]!.price.lt(l.price))).toBe(true);
    expect(book.cacheAgeSec).toBeNull();
  });

  it('keeps trade ids as exact strings beyond Number.MAX_SAFE_INTEGER', async () => {
    const r = raw<{ tid: string; date: string }[]>('trades-qntidr.json');
    const trades = await client.getTrades('qnt_idr');
    expect(trades[0]!.tid).toBe(r[0]!.tid);
    expect(typeof trades[0]!.tid).toBe('string');
    expect(Number.isSafeInteger(Number(r[0]!.tid))).toBe(false);
    expect(trades[0]!.time.getTime()).toBe(Number(r[0]!.date) * 1000);
  });

  it('requests candles with the documented symbol/tf/from/to parameters', async () => {
    const from = new Date('2026-11-01T00:00:00Z');
    const to = new Date('2026-11-02T00:00:00Z');
    const candles = await client.getCandles('qnt_idr', '15', from, to);

    const url = new URL(String(fetchFn.mock.calls.find(([u]) => String(u).includes('history_v2'))![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: String(from.getTime() / 1000),
      to: String(to.getTime() / 1000),
      symbol: 'QNTIDR',
      tf: '15',
    });
    const r = raw<{ Time: number; Open: number }[]>('ohlc-qntidr-15.json');
    expect(candles).toHaveLength(r.length);
    expect(candles[0]!.openTime.getTime()).toBe(r[0]!.Time * 1000);
    expect(candles[0]!.open.toFixed()).toBe(String(r[0]!.Open));
  });

  it('sends only GET requests with no credentials', () => {
    for (const [, init] of fetchFn.mock.calls) {
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ accept: 'application/json' });
    }
  });
});

describe('IndodaxPublicRest — precision, errors and safety', () => {
  it('parses prices and volumes without floating point loss', async () => {
    const body = '[{"Time":1793610000,"Open":0.000000123456789012345,"High":295787979.176530001,"Low":0.000000123456789012345,"Close":1,"Volume":"295787979.17653000123"}]';
    const client = clientWith(routedFetch({ '/tradingview/history_v2': { body } }));
    const [c] = await client.getCandles('qnt_idr', '15', new Date(0), new Date());
    expect(c!.open.toFixed()).toBe('0.000000123456789012345');
    expect(c!.high.toFixed()).toBe('295787979.176530001');
    expect(c!.volume.toFixed()).toBe('295787979.17653000123');
  });

  it('treats an HTTP 200 error body as an error and does not retry it', async () => {
    const fetchFn = routedFetch({ '/api/ticker/notapairidr': { body: fixture('error-invalid-pair.json') } });
    const client = clientWith(fetchFn, { retries: 3, baseDelayMs: 0 });
    await expect(client.getTicker('notapair_idr')).rejects.toMatchObject({ name: 'IndodaxApiError', code: 'invalid_pair' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list for an unknown OHLC symbol (as Indodax does)', async () => {
    const client = clientWith(routedFetch({ '/tradingview/history_v2': { body: '[]' } }));
    await expect(client.getCandles('notapair_idr', '15', new Date(0), new Date())).resolves.toEqual([]);
  });

  it('retries 5xx with exponential backoff, then succeeds', async () => {
    let calls = 0;
    const fetchFn = routedFetch({
      '/api/ticker/qntidr': () => (++calls < 3 ? { body: 'busy', status: 503 } : { body: fixture('ticker-qntidr.json') }),
    });
    const delays: number[] = [];
    const client = new IndodaxPublicRest(BASE, {
      fetchFn,
      retry: { retries: 3, baseDelayMs: 1000, sleep: async (ms) => void delays.push(ms) },
    });
    await expect(client.getTicker('qnt_idr')).resolves.toBeDefined();
    expect(delays).toEqual([1000, 2000]);
  });

  it('retries network failures and gives up after the configured retries', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const client = clientWith(fetchFn, { retries: 2, baseDelayMs: 0 });
    await expect(client.getTicker('qnt_idr')).rejects.toMatchObject({ retryable: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed pair ids before any request is made', async () => {
    const fetchFn = mockFetch({});
    const client = clientWith(fetchFn);
    await expect(client.getTicker('qnt_idr/../../tapi')).rejects.toThrow('Format pair tidak valid');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses any path outside the documented public endpoints', async () => {
    const fetchFn = mockFetch({});
    const client = clientWith(fetchFn) as unknown as { get(path: string, schema: unknown): Promise<unknown> };
    await expect(client.get('/tapi', {})).rejects.toThrow('Path tidak diizinkan');
    await expect(client.get('/api/ticker_all/../tapi', {})).rejects.toThrow('Path tidak diizinkan');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
