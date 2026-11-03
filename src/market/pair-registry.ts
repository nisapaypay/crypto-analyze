import { candidateTickerIds, cleanPairInput } from '../exchange/indodax/pair-id.js';
import type { PairInfo } from './types.js';

export type ResolveResult =
  | { status: 'ok'; pair: PairInfo }
  | { status: 'invalid_input' }
  | { status: 'not_found'; input: string }
  | { status: 'not_idr'; pair: PairInfo };

export interface PairSource {
  getPairs(): Promise<PairInfo[]>;
}

/** Cached view of /api/pairs (Cloudflare caches it for 60 s anyway). */
export class PairRegistry {
  private cache: { pairs: PairInfo[]; loadedAt: number } | null = null;
  private loading: Promise<PairInfo[]> | null = null;

  constructor(
    private readonly source: PairSource,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async all(): Promise<PairInfo[]> {
    if (this.cache && this.now() - this.cache.loadedAt < this.ttlMs) return this.cache.pairs;
    this.loading ??= this.source
      .getPairs()
      .then((pairs) => {
        this.cache = { pairs, loadedAt: this.now() };
        return pairs;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async get(tickerId: string): Promise<PairInfo | null> {
    return (await this.all()).find((p) => p.tickerId === tickerId) ?? null;
  }

  /** Resolve user input such as "qnt", "QNT/IDR" or "qntidr" to an IDR pair. */
  async resolve(input: string): Promise<ResolveResult> {
    const cleaned = cleanPairInput(input);
    if (!cleaned) return { status: 'invalid_input' };
    const { tickerId, pathId, coinTickerId } = candidateTickerIds(cleaned);
    const pairs = await this.all();
    const pair =
      pairs.find((p) => p.tickerId === tickerId) ??
      pairs.find((p) => p.pathId === pathId) ??
      pairs.find((p) => p.tickerId === coinTickerId);
    if (!pair) return { status: 'not_found', input: cleaned };
    if (pair.quoteAsset !== 'idr') return { status: 'not_idr', pair };
    return { status: 'ok', pair };
  }
}

export function isPairActive(pair: PairInfo): boolean {
  return !pair.isMaintenance && !pair.isSuspended;
}
