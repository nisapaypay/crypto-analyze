import type { z } from 'zod';
import { Dec } from '../../app/decimal.js';
import type { Candle, FetchMeta, OrderBook, PairInfo, Ticker, Timeframe, Trade } from '../../market/types.js';
import { parseLosslessJson } from './lossless-json.js';
import { toPathId, toSymbol } from './pair-id.js';
import { RateLimiter, withRetry, type RetryOptions } from './rate-limiter.js';
import {
  apiErrorSchema,
  depthSchema,
  ohlcSchema,
  pairsSchema,
  serverTimeSchema,
  tickerSchema,
  tradesSchema,
  type RawPair,
  type ServerTime,
} from './types.js';

/**
 * Indodax Public REST API adapter.
 * Docs: https://github.com/btcid/indodax-official-api-docs/blob/master/Public-RestAPI.md
 *
 * Public, unauthenticated GET endpoints only. This adapter must never send
 * credentials or call the Private/Trade API; requests outside the documented
 * public paths are rejected before they leave the process.
 */

export const INDODAX_CLIENT_DEFAULTS = {
  maxRequestsPerMinute: 120,
  maxConcurrent: 2,
  timeoutMs: 10_000,
  retry: { retries: 3, baseDelayMs: 1_000 },
} as const;

const ALLOWED_PATH =
  /^\/(api\/(server_time|pairs|(ticker|trades|depth)\/[a-z0-9]+)|tradingview\/history_v2\?[a-zA-Z0-9=&]+)$/;

export interface IndodaxClientOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Share one limiter between clients so the combined rate stays bounded. */
  limiter?: RateLimiter;
  retry?: RetryOptions;
  now?: () => Date;
}

export class IndodaxPublicRest {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly retry: RetryOptions;
  private readonly now: () => Date;

  constructor(
    private readonly baseUrl: string,
    options: IndodaxClientOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? INDODAX_CLIENT_DEFAULTS.timeoutMs;
    this.limiter =
      options.limiter ??
      new RateLimiter({
        maxRequests: INDODAX_CLIENT_DEFAULTS.maxRequestsPerMinute,
        windowMs: 60_000,
        maxConcurrent: INDODAX_CLIENT_DEFAULTS.maxConcurrent,
      });
    this.retry = options.retry ?? INDODAX_CLIENT_DEFAULTS.retry;
    this.now = options.now ?? (() => new Date());
  }

  async getServerTime(): Promise<ServerTime> {
    const { data } = await this.get('/api/server_time', serverTimeSchema);
    return { timezone: data.timezone, serverTime: new Date(Number(data.server_time)) };
  }

  async getPairs(): Promise<PairInfo[]> {
    const { data } = await this.get('/api/pairs', pairsSchema);
    return data.map(normalizePair);
  }

  async getTicker(tickerId: string): Promise<Ticker> {
    const { data, meta } = await this.get(`/api/ticker/${toPathId(tickerId)}`, tickerSchema);
    const t = data.ticker;
    const baseVolumeKey = Object.keys(t).find((k) => k.startsWith('vol_') && k !== 'vol_idr');
    const baseVolume = baseVolumeKey ? t[baseVolumeKey] : undefined;
    return {
      ...meta,
      pair: tickerId,
      last: new Dec(t.last),
      bid: new Dec(t.buy),
      ask: new Dec(t.sell),
      high24h: new Dec(t.high),
      low24h: new Dec(t.low),
      volumeBase24h: typeof baseVolume === 'string' || typeof baseVolume === 'number' ? new Dec(baseVolume) : null,
      volumeIdr24h: new Dec(t.vol_idr),
      serverTime: secondsToDate(t.server_time),
    };
  }

  async getOrderBook(tickerId: string): Promise<OrderBook> {
    const { data, meta } = await this.get(`/api/depth/${toPathId(tickerId)}`, depthSchema);
    const level = ([price, volume]: [string, string]) => ({ price: new Dec(price), volume: new Dec(volume) });
    return {
      ...meta,
      pair: tickerId,
      bids: data.buy.map(level).sort((a, b) => b.price.comparedTo(a.price)),
      asks: data.sell.map(level).sort((a, b) => a.price.comparedTo(b.price)),
    };
  }

  /** The 500 most recent trades, newest first. */
  async getTrades(tickerId: string): Promise<Trade[]> {
    const { data } = await this.get(`/api/trades/${toPathId(tickerId)}`, tradesSchema);
    return data.map((t) => ({
      tid: t.tid,
      time: secondsToDate(t.date),
      price: new Dec(t.price),
      amount: new Dec(t.amount),
      side: t.type,
    }));
  }

  /**
   * OHLC candles in ascending order. Indodax returns at most ~865 candles per
   * request (the most recent ones before `to`) and fills periods without
   * trades with flat zero-volume candles. The last candle may be unfinished.
   * An unknown symbol yields an empty array rather than an error.
   */
  async getCandles(tickerId: string, timeframe: Timeframe, from: Date, to: Date): Promise<Candle[]> {
    const query = `from=${toUnix(from)}&symbol=${toSymbol(tickerId)}&tf=${timeframe}&to=${toUnix(to)}`;
    const { data } = await this.get(`/tradingview/history_v2?${query}`, ohlcSchema);
    return data.map((c) => ({
      pair: tickerId,
      timeframe,
      openTime: secondsToDate(c.Time),
      open: new Dec(c.Open),
      high: new Dec(c.High),
      low: new Dec(c.Low),
      close: new Dec(c.Close),
      volume: new Dec(c.Volume),
    }));
  }

  private async get<S extends z.ZodType>(path: string, schema: S): Promise<{ data: z.output<S>; meta: FetchMeta }> {
    if (!ALLOWED_PATH.test(path)) {
      throw new IndodaxApiError(`Path tidak diizinkan untuk Public API: ${path}`);
    }
    return withRetry(
      () => this.limiter.schedule(() => this.fetchOnce(path, schema)),
      (error) => error instanceof IndodaxApiError && error.retryable,
      this.retry,
    );
  }

  private async fetchOnce<S extends z.ZodType>(path: string, schema: S): Promise<{ data: z.output<S>; meta: FetchMeta }> {
    const endpoint = path.split('?')[0];
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new IndodaxApiError(`Gagal menghubungi Indodax ${endpoint}: ${reason}`, { retryable: true });
    }
    const fetchedAt = this.now();

    if (!response.ok) {
      throw new IndodaxApiError(`Indodax ${endpoint} merespons HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    let body: unknown;
    try {
      body = parseLosslessJson(await response.text());
    } catch {
      throw new IndodaxApiError(`Respons Indodax ${endpoint} bukan JSON`, { retryable: true });
    }

    const apiError = apiErrorSchema.safeParse(body);
    if (apiError.success) {
      const { error, error_description } = apiError.data;
      throw new IndodaxApiError(`Indodax ${endpoint}: ${error_description ?? error}`, { code: error });
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new IndodaxApiError(`Format respons Indodax ${endpoint} tidak sesuai: ${parsed.error.message}`);
    }

    const age = response.headers.get('age');
    const cacheAgeSec = age !== null && /^\d+$/.test(age) ? Number(age) : null;
    return { data: parsed.data, meta: { fetchedAt, cacheAgeSec } };
  }
}

export class IndodaxApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'IndodaxApiError';
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

function normalizePair(p: RawPair): PairInfo {
  const dec = (v: string | undefined) => (v === undefined ? null : new Dec(v));
  return {
    tickerId: p.ticker_id,
    pathId: p.id,
    symbol: p.symbol,
    baseAsset: p.traded_currency.toLowerCase(),
    quoteAsset: p.base_currency.toLowerCase(),
    description: p.description,
    tickSize: dec(p.price_precision),
    quantityIncrement: dec(p.quantity_increment),
    minOrderIdr: dec(p.trade_min_base_currency),
    minOrderBase: dec(p.trade_min_traded_currency),
    takerFeePct: dec(p.trade_fee_percent_taker),
    makerFeePct: dec(p.trade_fee_percent_maker),
    isMaintenance: p.is_maintenance ?? false,
    isSuspended: p.is_market_suspended ?? false,
  };
}

function secondsToDate(seconds: string): Date {
  return new Date(Number(seconds) * 1000);
}

function toUnix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
