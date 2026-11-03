import { describe, expect, it } from 'vitest';
import { ConfigError, collectSecrets, loadConfig } from '../../../src/app/config/env.js';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr';

const validEnv = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_ALLOWED_USER_ID: '987654321',
  DATABASE_URL: 'postgresql://app:dbpass123@localhost:5432/crypto_analyst',
};

function captureError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('loadConfig should have thrown');
}

describe('loadConfig', () => {
  it('loads a valid minimal environment with defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.telegram.allowedUserId).toBe(987654321);
    expect(config.timezone).toBe('Asia/Jakarta');
    expect(config.nodeEnv).toBe('development');
    expect(config.indodax.publicBaseUrl).toBe('https://indodax.com');
  });

  it('works with empty Indodax credentials and never exposes them', () => {
    const config = loadConfig({ ...validEnv, INDODAX_API_KEY: '', INDODAX_SECRET_KEY: '' });
    expect(JSON.stringify(config)).not.toMatch(/indodax_?(api|secret)/i);
  });

  it('ignores Indodax credentials even when filled in', () => {
    const config = loadConfig({ ...validEnv, INDODAX_API_KEY: 'filled-key', INDODAX_SECRET_KEY: 'filled-secret' });
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('filled-key');
    expect(serialized).not.toContain('filled-secret');
  });

  it('disables AI gracefully when Anthropic variables are empty', () => {
    const config = loadConfig({ ...validEnv, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' });
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.disabledReason).toBe('ANTHROPIC_API_KEY dan ANTHROPIC_MODEL kosong');
  });

  it('disables AI when only the model is missing', () => {
    const config = loadConfig({ ...validEnv, ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.disabledReason).toBe('ANTHROPIC_MODEL kosong');
  });

  it('enables AI when key and model are set', () => {
    const config = loadConfig({ ...validEnv, ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_MODEL: 'claude-test' });
    expect(config.ai.enabled).toBe(true);
    expect(config.ai.disabledReason).toBeUndefined();
  });

  it('reports every missing required variable by name', () => {
    const error = captureError({});
    const keys = error.issues.map((i) => i.split(':')[0]);
    expect(keys).toEqual(expect.arrayContaining(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_ID', 'DATABASE_URL']));
  });

  it('treats a blank allowed user id as missing, not as 0', () => {
    const error = captureError({ ...validEnv, TELEGRAM_ALLOWED_USER_ID: '  ' });
    expect(error.issues).toEqual([expect.stringMatching(/^TELEGRAM_ALLOWED_USER_ID: wajib diisi/)]);
  });

  it('rejects non-numeric user ids and malformed tokens', () => {
    const error = captureError({ ...validEnv, TELEGRAM_ALLOWED_USER_ID: 'abc', TELEGRAM_BOT_TOKEN: 'not-a-token' });
    expect(error.issues).toHaveLength(2);
  });

  it('never includes secret values in error messages', () => {
    const error = captureError({ ...validEnv, TELEGRAM_BOT_TOKEN: 'short:secret-value', DATABASE_URL: 'mysql://x' });
    expect(error.message).not.toContain('secret-value');
    expect(error.message).not.toContain('mysql://x');
  });
});

describe('collectSecrets', () => {
  it('collects bot token, AI key and database password', () => {
    const config = loadConfig({ ...validEnv, ANTHROPIC_API_KEY: 'sk-ant-secret' });
    expect(collectSecrets(config)).toEqual([TOKEN, 'sk-ant-secret', 'dbpass123']);
  });
});
