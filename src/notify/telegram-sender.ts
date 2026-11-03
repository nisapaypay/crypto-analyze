import { GrammyError } from 'grammy';

export type SendResult =
  | { ok: true; messageId: number; attempts: number }
  | { ok: false; error: string; attempts: number; rateLimited: boolean };

export interface TelegramApi {
  sendMessage(chatId: number, text: string, other?: Record<string, unknown>): Promise<{ message_id: number }>;
}

export interface SenderOptions {
  /** Retries after a 429 (Telegram certainly did not deliver the message). */
  retries429: number;
  /** A retry_after above this is not waited for. */
  maxRetryAfterMs: number;
  /** Minimum gap between two messages (Telegram: ~1 message/s per chat). */
  minIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sequential Telegram sender. At-most-once: only a 429 (Too Many Requests) is
 * retried — Telegram guarantees the message was not delivered and says how
 * long to wait. Any other error (network, timeout, 5xx, 400/403) is NOT
 * retried, because the message may already have arrived; the caller records it
 * as FAILED. Sends never block the scheduler: callers enqueue and move on.
 */
export class TelegramSender {
  private chain: Promise<unknown> = Promise.resolve();
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
    private readonly opts: SenderOptions,
  ) {
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
  }

  /** Queue a message; resolves when it was sent or definitively failed. */
  send(text: string): Promise<SendResult> {
    const run = this.chain.then(() => this.deliver(text));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Resolves when everything queued so far is done (tests, shutdown). */
  async idle(): Promise<void> {
    await this.chain;
  }

  private async deliver(text: string): Promise<SendResult> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.lastSentAt + this.opts.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        const m = await this.api.sendMessage(this.chatId, text, { link_preview_options: { is_disabled: true } });
        this.lastSentAt = this.now();
        return { ok: true, messageId: m.message_id, attempts: attempt };
      } catch (error) {
        this.lastSentAt = this.now();
        if (error instanceof GrammyError && error.error_code === 429) {
          const retryAfterMs = (error.parameters.retry_after ?? 5) * 1000;
          if (attempt > this.opts.retries429 || retryAfterMs > this.opts.maxRetryAfterMs) {
            return { ok: false, error: `Telegram 429: ${error.description}`, attempts: attempt, rateLimited: true };
          }
          await this.sleep(retryAfterMs);
          continue;
        }
        const message = error instanceof GrammyError ? `Telegram ${error.error_code}: ${error.description}` : error instanceof Error ? error.message : String(error);
        return { ok: false, error: message, attempts: attempt, rateLimited: false };
      }
    }
  }
}
