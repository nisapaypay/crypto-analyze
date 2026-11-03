/**
 * Parse JSON while keeping every number as its exact source text.
 *
 * Indodax sends some prices/volumes as JSON numbers (e.g. OHLC), and a plain
 * `JSON.parse` would round values with more than ~15 significant digits before
 * our code ever sees them. Uses JSON.parse source text access (Node >= 21).
 */
export function parseLosslessJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && context?.source !== undefined ? context.source : value,
  );
}
