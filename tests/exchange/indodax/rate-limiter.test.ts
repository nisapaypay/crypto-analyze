import { describe, expect, it } from 'vitest';
import { RateLimiter, withRetry } from '../../../src/exchange/indodax/rate-limiter.js';
import { parseLosslessJson } from '../../../src/exchange/indodax/lossless-json.js';

describe('RateLimiter', () => {
  it('never starts more than maxRequests within the window', async () => {
    let clock = 0;
    const starts: number[] = [];
    const limiter = new RateLimiter({
      maxRequests: 3,
      windowMs: 1000,
      maxConcurrent: 10,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    await Promise.all(Array.from({ length: 7 }, () => limiter.schedule(async () => void starts.push(clock))));

    expect(starts).toEqual([0, 0, 0, 1000, 1000, 1000, 2000]);
    expect(limiter.requestCount).toBe(7);
  });

  it('caps concurrent requests', async () => {
    let active = 0;
    let peak = 0;
    const limiter = new RateLimiter({ maxRequests: 100, windowMs: 1000, maxConcurrent: 2 });
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter.schedule(task)));
    expect(peak).toBe(2);
  });

  it('releases the slot when a task fails', async () => {
    const limiter = new RateLimiter({ maxRequests: 100, windowMs: 1000, maxConcurrent: 1 });
    await expect(limiter.schedule(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.schedule(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('withRetry', () => {
  it('backs off exponentially (1s, 2s, 4s) for retryable errors', async () => {
    const delays: number[] = [];
    let calls = 0;
    const task = async () => {
      calls++;
      throw new Error('temporary');
    };
    await expect(
      withRetry(task, () => true, { retries: 3, baseDelayMs: 1000, sleep: async (ms) => void delays.push(ms) }),
    ).rejects.toThrow('temporary');
    expect(calls).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('permanent');
      }, () => false, { retries: 3, baseDelayMs: 0 }),
    ).rejects.toThrow('permanent');
    expect(calls).toBe(1);
  });
});

describe('parseLosslessJson', () => {
  it('keeps the exact source text of every number', () => {
    expect(parseLosslessJson('{"a":295787979.176530001,"b":[1e-8,144115188260077791],"c":"x","d":true}')).toEqual({
      a: '295787979.176530001',
      b: ['1e-8', '144115188260077791'],
      c: 'x',
      d: true,
    });
  });
});
