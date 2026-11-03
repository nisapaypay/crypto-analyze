import pg from 'pg';
import type { Logger } from '../app/logger/logger.js';

/** Arbitrary, fixed advisory-lock key for this application. */
export const INSTANCE_LOCK_KEY = 724_311_500_001n;

/**
 * Single-instance guarantee: a session-level PostgreSQL advisory lock held on
 * a dedicated connection for the whole process lifetime. PostgreSQL releases
 * it automatically when the connection dies (crash, kill -9, power loss), so a
 * restart can always reacquire it. A second instance cannot start the bot or
 * the scheduler (this also prevents Telegram 409 Conflict).
 */
export class InstanceLock {
  private client: pg.Client | null = null;
  private held = false;
  private lostHandlers: (() => void)[] = [];

  constructor(
    private readonly databaseUrl: string,
    private readonly logger: Logger,
    private readonly key: bigint = INSTANCE_LOCK_KEY,
  ) {}

  get isHeld(): boolean {
    return this.held;
  }

  onLost(handler: () => void): void {
    this.lostHandlers.push(handler);
  }

  async acquire(): Promise<boolean> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on('error', (err) => this.lose(err.message));
    client.on('end', () => this.lose('koneksi lock ditutup'));
    await client.connect();
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [this.key.toString()]);
    if (!rows[0]?.ok) {
      await client.end().catch(() => undefined);
      return false;
    }
    this.client = client;
    this.held = true;
    return true;
  }

  /** Cheap liveness check of the lock connection; false (and lost) if it is gone. */
  async verify(): Promise<boolean> {
    if (!this.client || !this.held) return false;
    try {
      await this.client.query('SELECT 1');
      return true;
    } catch (error) {
      this.lose(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    this.held = false;
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [this.key.toString()]);
    } catch {
      // Ending the session releases the lock anyway.
    }
    await client.end().catch(() => undefined);
  }

  private lose(reason: string): void {
    if (!this.held) return;
    this.held = false;
    this.client = null;
    this.logger.error({ reason }, 'Instance lock hilang: scheduler berhenti sampai lock didapat kembali');
    for (const h of this.lostHandlers) h();
  }
}
