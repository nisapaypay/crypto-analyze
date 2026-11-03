import { systemNotification, type SystemEvent } from '../bot/messages/notifications.js';
import type { Candidate, DispatchResult } from './notifier.js';

export interface SystemState {
  consecutiveFailures: number;
  lastCause: string | null;
  clock: 'UNKNOWN' | 'VALID' | 'INVALID';
  skewMs: number | null;
  serverTimeTrusted: boolean;
  serverTimeReason: string | null;
}

export interface SystemAlertOptions {
  failuresThreshold: number;
  /** Server-time distrust must last this long before alerting (startup/wake re-sampling is normal). */
  serverTimeDebounceMs: number;
  timeZone: string;
}

/**
 * Operational alerts, one per incident (dedup key = incident start), with one
 * "back to normal" message. Polled from the heartbeat (no scheduler change).
 * SYSTEM messages are not trading notifications and may be sent 24/7.
 */
export class SystemAlerts {
  private failureIncident: Date | null = null;
  private clockIncident: Date | null = null;
  private serverSince: Date | null = null;
  private serverIncident: Date | null = null;

  constructor(
    private readonly dispatch: (c: Candidate) => Promise<DispatchResult>,
    private readonly opts: SystemAlertOptions,
  ) {}

  private send(e: SystemEvent, key: string, at: Date): Promise<DispatchResult> {
    return this.dispatch({ dedupKey: `system:${key}`, kind: 'SYSTEM', template: `system_${e.type.toLowerCase()}`, render: () => systemNotification(e, at, this.opts.timeZone) });
  }

  async observe(s: SystemState, now: Date): Promise<void> {
    if (s.consecutiveFailures >= this.opts.failuresThreshold && !this.failureIncident) {
      this.failureIncident = now;
      await this.send({ type: 'FAILURES', count: s.consecutiveFailures, lastCause: s.lastCause }, `failures:${now.toISOString()}`, now);
    } else if (s.consecutiveFailures === 0 && this.failureIncident) {
      await this.send({ type: 'FAILURES_RECOVERED' }, `failures-recovered:${this.failureIncident.toISOString()}`, now);
      this.failureIncident = null;
    }

    if (s.clock === 'INVALID' && !this.clockIncident) {
      this.clockIncident = now;
      await this.send({ type: 'CLOCK_INVALID', skewMs: s.skewMs }, `clock:${now.toISOString()}`, now);
    } else if (s.clock === 'VALID' && this.clockIncident) {
      await this.send({ type: 'CLOCK_VALID' }, `clock-valid:${this.clockIncident.toISOString()}`, now);
      this.clockIncident = null;
    }

    if (!s.serverTimeTrusted) {
      this.serverSince ??= now;
      if (!this.serverIncident && now.getTime() - this.serverSince.getTime() >= this.opts.serverTimeDebounceMs) {
        this.serverIncident = this.serverSince;
        await this.send({ type: 'SERVER_TIME_UNTRUSTED', reason: s.serverTimeReason ?? '-' }, `server-time:${this.serverSince.toISOString()}`, now);
      }
    } else {
      if (this.serverIncident) await this.send({ type: 'SERVER_TIME_TRUSTED' }, `server-time-trusted:${this.serverIncident.toISOString()}`, now);
      this.serverSince = null;
      this.serverIncident = null;
    }
  }

  /** One notice per process start when slots were missed while it was down. */
  restarted(instanceId: string, missedSlots: number, since: Date | null, now: Date): Promise<DispatchResult> | null {
    if (missedSlots <= 0) return null;
    return this.send({ type: 'RESTARTED', missedSlots, since }, `restart:${instanceId}`, now);
  }
}
