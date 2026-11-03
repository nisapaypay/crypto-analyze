import { z } from 'zod';

/**
 * Schemas for raw Indodax Public REST responses, as actually observed
 * (2026-11-02), which differ from the docs in places:
 *  - numbers arrive as JSON numbers or strings depending on endpoint/field;
 *    after lossless parsing both become strings, but both are accepted;
 *  - ticker/trade/OHLC times are Unix seconds, /api/server_time is ms;
 *  - an unknown pair still returns HTTP 200 with an `error` body.
 */

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s), 'bukan angka');

const integer = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^\d+$/.test(s), 'bukan bilangan bulat');

const flag = z.union([z.boolean(), z.number(), z.string()]).transform((v) => v === true || v === 1 || v === '1');

export const apiErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  error_code: z.string().optional(),
});

/** GET /api/server_time — `server_time` is in milliseconds. */
export const serverTimeSchema = z.object({
  timezone: z.string(),
  server_time: integer,
});

export interface ServerTime {
  timezone: string;
  serverTime: Date;
}

/** GET /api/pairs — only the fields this app uses; others are ignored. */
export const pairsSchema = z.array(
  z.object({
    id: z.string(),
    symbol: z.string(),
    ticker_id: z.string(),
    base_currency: z.string(),
    traded_currency: z.string(),
    description: z.string(),
    price_precision: numeric.optional(),
    quantity_increment: numeric.optional(),
    trade_min_base_currency: numeric.optional(),
    trade_min_traded_currency: numeric.optional(),
    trade_fee_percent_taker: numeric.optional(),
    trade_fee_percent_maker: numeric.optional(),
    is_maintenance: flag.optional(),
    is_market_suspended: flag.optional(),
  }),
);
export type RawPair = z.infer<typeof pairsSchema>[number];

/** GET /api/ticker/{id} — volume key is `vol_<traded currency>`. Times in seconds. */
export const tickerSchema = z.object({
  ticker: z
    .object({
      high: numeric,
      low: numeric,
      last: numeric,
      buy: numeric,
      sell: numeric,
      vol_idr: numeric,
      server_time: integer,
    })
    .catchall(z.unknown()),
});

/** GET /api/depth/{id} — [price, volume] pairs; live responses use strings. */
const depthLevel = z.tuple([numeric, numeric]);
export const depthSchema = z.object({
  buy: z.array(depthLevel),
  sell: z.array(depthLevel),
});

/** GET /api/trades/{id} — newest first, `date` in seconds, `tid` beyond 2^53. */
export const tradesSchema = z.array(
  z.object({
    tid: integer,
    date: integer,
    price: numeric,
    amount: numeric,
    type: z.enum(['buy', 'sell']),
  }),
);

/** GET /tradingview/history_v2 — ascending, `Time` in seconds, Volume in base units. */
export const ohlcSchema = z.array(
  z.object({
    Time: integer,
    Open: numeric,
    High: numeric,
    Low: numeric,
    Close: numeric,
    Volume: numeric,
  }),
);
