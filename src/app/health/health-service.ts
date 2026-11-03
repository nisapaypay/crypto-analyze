/** A probe resolves (optionally with a detail string) when healthy and throws when not. */
export type HealthProbe = () => Promise<string | void>;

export interface ComponentHealth {
  name: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export class HealthService {
  constructor(
    private readonly probes: Record<string, HealthProbe>,
    private readonly timeoutMs = 5_000,
  ) {}

  /** Runs all probes in parallel; never throws. */
  async check(): Promise<ComponentHealth[]> {
    return Promise.all(
      Object.entries(this.probes).map(([name, probe]) => this.run(name, probe)),
    );
  }

  private async run(name: string, probe: HealthProbe): Promise<ComponentHealth> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const detail = await withTimeout(probe(), this.timeoutMs);
      return { name, ok: true, latencyMs: elapsed(), ...(detail ? { detail } : {}) };
    } catch (error) {
      return { name, ok: false, latencyMs: elapsed(), detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout setelah ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
