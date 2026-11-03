import { describe, expect, it } from 'vitest';
import { formatDateTime, formatPair } from '../../src/bot/messages/format.js';

describe('formatDateTime', () => {
  it('formats in WIB regardless of host timezone', () => {
    expect(formatDateTime(new Date('2026-11-02T04:30:00Z'), 'Asia/Jakarta')).toBe('02 Nov 2026 — 11:30 WIB');
  });

  it('handles the day boundary in WIB', () => {
    expect(formatDateTime(new Date('2026-11-02T17:05:00Z'), 'Asia/Jakarta')).toBe('03 Nov 2026 — 00:05 WIB');
  });

  it('falls back to the IANA name for unlabeled timezones', () => {
    expect(formatDateTime(new Date('2026-11-02T04:30:00Z'), 'UTC')).toBe('02 Nov 2026 — 04:30 UTC');
  });
});

describe('formatPair', () => {
  it('converts ticker ids to display pairs', () => {
    expect(formatPair('qnt_idr')).toBe('QNT/IDR');
  });
});
