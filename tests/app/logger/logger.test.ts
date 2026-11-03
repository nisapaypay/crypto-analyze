import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/app/logger/logger.js';

function captureLogger(secrets: string[] = []) {
  const lines: string[] = [];
  const logger = createLogger({ level: 'info', secrets, destination: { write: (s: string) => void lines.push(s) } });
  return { logger, output: () => lines.join('') };
}

describe('createLogger', () => {
  it('scrubs secret values that appear anywhere in the log line', () => {
    const token = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr';
    const { logger, output } = captureLogger([token]);
    logger.error({ err: new Error(`request to https://api.telegram.org/bot${token}/getMe failed`) }, `token=${token}`);
    expect(output()).not.toContain(token);
    expect(output()).toContain('[REDACTED]');
  });

  it('redacts well-known secret keys', () => {
    const { logger, output } = captureLogger();
    logger.info({ apiKey: 'k-123', config: { botToken: 'b-456', secret: 's-789' } }, 'config');
    expect(output()).not.toMatch(/k-123|b-456|s-789/);
  });

  it('leaves ordinary fields intact', () => {
    const { logger, output } = captureLogger(['topsecret']);
    logger.info({ pair: 'qnt_idr' }, 'scan');
    expect(JSON.parse(output())).toMatchObject({ pair: 'qnt_idr', msg: 'scan' });
  });
});
