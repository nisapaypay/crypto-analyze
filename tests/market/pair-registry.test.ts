import { describe, expect, it, vi } from 'vitest';
import { cleanPairInput, toPathId, toSymbol } from '../../src/exchange/indodax/pair-id.js';
import { PairRegistry } from '../../src/market/pair-registry.js';
import { makePair } from '../helpers/market.js';

const pairs = [
  makePair(),
  makePair({ tickerId: 'doge_idr', pathId: 'dogeidr', symbol: 'DOGEIDR', baseAsset: 'doge' }),
  makePair({ tickerId: 'aero_idr', pathId: 'aeroidr', symbol: 'AEROIDR', baseAsset: 'aero', isMaintenance: true }),
  makePair({ tickerId: 'eth_usdt', pathId: 'ethusdt', symbol: 'ETHUSDT', baseAsset: 'eth', quoteAsset: 'usdt' }),
];

describe('pair id helpers', () => {
  it('converts between Indodax pair formats', () => {
    expect(toPathId('qnt_idr')).toBe('qntidr');
    expect(toSymbol('qnt_idr')).toBe('QNTIDR');
  });

  it('cleans user input and rejects anything unsafe', () => {
    expect(cleanPairInput(' QNT/IDR ')).toBe('qnt_idr');
    expect(cleanPairInput('qnt-idr')).toBe('qnt_idr');
    expect(cleanPairInput('Qnt')).toBe('qnt');
    for (const bad of ['', 'qnt idr', '../tapi', 'qnt_idr_x', 'a'.repeat(21), 'qnt;drop']) {
      expect(cleanPairInput(bad)).toBeNull();
    }
  });
});

describe('PairRegistry', () => {
  const source = { getPairs: vi.fn(async () => pairs) };

  it('resolves coin, ticker id, path id and display formats', async () => {
    const registry = new PairRegistry(source);
    for (const input of ['qnt', 'QNT/IDR', 'qnt_idr', 'qntidr']) {
      await expect(registry.resolve(input)).resolves.toMatchObject({ status: 'ok', pair: { tickerId: 'qnt_idr' } });
    }
  });

  it('reports invalid input, unknown pairs and non-IDR pairs', async () => {
    const registry = new PairRegistry(source);
    await expect(registry.resolve('../tapi')).resolves.toEqual({ status: 'invalid_input' });
    await expect(registry.resolve('nope')).resolves.toEqual({ status: 'not_found', input: 'nope' });
    await expect(registry.resolve('eth_usdt')).resolves.toMatchObject({ status: 'not_idr' });
  });

  it('caches /api/pairs within the TTL and refreshes after it', async () => {
    let clock = 0;
    const counting = { getPairs: vi.fn(async () => pairs) };
    const registry = new PairRegistry(counting, 1000, () => clock);
    await Promise.all([registry.all(), registry.all()]);
    await registry.get('qnt_idr');
    expect(counting.getPairs).toHaveBeenCalledTimes(1);
    clock = 1001;
    await registry.all();
    expect(counting.getPairs).toHaveBeenCalledTimes(2);
  });
});
