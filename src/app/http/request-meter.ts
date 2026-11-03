/**
 * Counts every outgoing HTTP attempt (retries included) per endpoint, for
 * /status and the soak-test report. Injected as `fetchFn` into the Indodax
 * client from the composition root, so the client itself is unchanged.
 */
export class RequestMeter {
  private stamps: { t: number; endpoint: string }[] = [];
  private total = 0;

  constructor(
    private readonly retentionMs = 2 * 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  wrap(fetchFn: typeof fetch): typeof fetch {
    return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      this.record(endpointOf(input));
      return fetchFn(input, init);
    }) as typeof fetch;
  }

  record(endpoint: string): void {
    const t = this.now();
    this.total++;
    this.stamps.push({ t, endpoint });
    const cutoff = t - this.retentionMs;
    if (this.stamps.length > 0 && this.stamps[0]!.t < cutoff) this.stamps = this.stamps.filter((s) => s.t >= cutoff);
  }

  get totalAttempts(): number {
    return this.total;
  }

  countSince(ms: number): number {
    const cutoff = this.now() - ms;
    return this.stamps.filter((s) => s.t >= cutoff).length;
  }

  /** Highest number of attempts inside any rolling 60 s window within the last `ms`. */
  peakPerMinute(ms = 3_600_000): number {
    const cutoff = this.now() - ms;
    const ts = this.stamps.filter((s) => s.t >= cutoff).map((s) => s.t);
    let peak = 0;
    for (let i = 0, j = 0; i < ts.length; i++) {
      while (ts[i]! - ts[j]! >= 60_000) j++;
      peak = Math.max(peak, i - j + 1);
    }
    return peak;
  }

  byEndpointSince(ms: number): Record<string, number> {
    const cutoff = this.now() - ms;
    const out: Record<string, number> = {};
    for (const s of this.stamps) if (s.t >= cutoff) out[s.endpoint] = (out[s.endpoint] ?? 0) + 1;
    return out;
  }
}

/** "/api/ticker/btcidr" → "/api/ticker"; history_v2 without its query. */
export function endpointOf(input: Parameters<typeof fetch>[0]): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const path = new URL(url).pathname;
    const m = /^\/api\/(ticker|trades|depth)\//.exec(path);
    return m ? `/api/${m[1]}` : path;
  } catch {
    return 'unknown';
  }
}
