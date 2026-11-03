/**
 * Indodax identifies a pair in three formats:
 *   ticker_id "qnt_idr" — summaries, price increments; canonical in this app
 *   id        "qntidr"  — /api/ticker, /api/depth, /api/trades
 *   symbol    "QNTIDR"  — /tradingview/history_v2
 */

const TICKER_ID = /^[a-z0-9]+_[a-z0-9]+$/;

export function assertTickerId(tickerId: string): void {
  if (!TICKER_ID.test(tickerId)) {
    throw new Error(`Format pair tidak valid: "${tickerId}" (contoh: qnt_idr)`);
  }
}

export function toPathId(tickerId: string): string {
  assertTickerId(tickerId);
  return tickerId.replace('_', '');
}

export function toSymbol(tickerId: string): string {
  return toPathId(tickerId).toUpperCase();
}

/**
 * Normalize free-form user input ("qnt", "QNT/IDR", "qnt-idr", "qnt_idr",
 * "qntidr") to a lowercase token. Returns null for anything that is not a
 * plausible pair name, so arbitrary text never reaches an API path.
 */
export function cleanPairInput(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/[/-]/, '_');
  return /^[a-z0-9]{1,20}(_[a-z0-9]{1,10})?$/.test(s) ? s : null;
}

/** Ticker ids that a cleaned input may refer to, most specific first. */
export function candidateTickerIds(cleaned: string): { tickerId?: string; pathId?: string; coinTickerId?: string } {
  if (cleaned.includes('_')) return { tickerId: cleaned };
  return { pathId: cleaned, coinTickerId: `${cleaned}_idr` };
}
