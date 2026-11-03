import { describe, expect, it } from 'vitest';
import { HealthService } from '../../../src/app/health/health-service.js';

describe('HealthService', () => {
  it('reports healthy, failing and timed-out components without throwing', async () => {
    const service = new HealthService(
      {
        Database: async () => undefined,
        Network: async () => {
          throw new Error('connect ECONNREFUSED');
        },
        Indodax: () => new Promise(() => undefined),
        Detail: async () => 'selisih jam 0s',
      },
      50,
    );

    const report = await service.check();

    expect(report).toEqual([
      expect.objectContaining({ name: 'Database', ok: true }),
      expect.objectContaining({ name: 'Network', ok: false, detail: 'connect ECONNREFUSED' }),
      expect.objectContaining({ name: 'Indodax', ok: false, detail: 'timeout setelah 50ms' }),
      expect.objectContaining({ name: 'Detail', ok: true, detail: 'selisih jam 0s' }),
    ]);
  });
});
