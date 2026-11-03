import { z } from 'zod';

/**
 * Indodax private API credentials are intentionally absent from this schema:
 * the MVP uses the Public API only and must never read, require, or log them
 * (PRD §3.2, §15). tests/security/no-trading.test.ts enforces this.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_TIMEZONE: z.string().default('Asia/Jakarta'),

  TELEGRAM_BOT_TOKEN: z
    .string({ error: 'wajib diisi (token dari @BotFather)' })
    .regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'format token Telegram tidak valid'),
  TELEGRAM_ALLOWED_USER_ID: z.coerce
    .number({ error: 'wajib diisi (user ID Telegram numerik)' })
    .int('harus bilangan bulat')
    .positive('harus bilangan positif'),

  DATABASE_URL: z
    .string({ error: 'wajib diisi' })
    .regex(/^postgres(ql)?:\/\//, 'harus diawali postgresql://'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),

  INDODAX_PUBLIC_BASE_URL: z.url().default('https://indodax.com'),
});

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  logLevel: string;
  timezone: string;
  telegram: {
    botToken: string;
    allowedUserId: number;
  };
  databaseUrl: string;
  ai: {
    enabled: boolean;
    apiKey: string | undefined;
    model: string | undefined;
    disabledReason: string | undefined;
  };
  indodax: {
    publicBaseUrl: string;
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Konfigurasi environment tidak valid:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validate environment variables and build the typed application config.
 * Error messages name the offending variable but never include its value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(withoutBlankValues(env));
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const e = result.data;
  const missingAi = [
    e.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY',
    e.ANTHROPIC_MODEL ? null : 'ANTHROPIC_MODEL',
  ].filter((k): k is string => k !== null);

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    timezone: e.APP_TIMEZONE,
    telegram: {
      botToken: e.TELEGRAM_BOT_TOKEN,
      allowedUserId: e.TELEGRAM_ALLOWED_USER_ID,
    },
    databaseUrl: e.DATABASE_URL,
    ai: {
      enabled: missingAi.length === 0,
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.ANTHROPIC_MODEL,
      disabledReason: missingAi.length > 0 ? `${missingAi.join(' dan ')} kosong` : undefined,
    },
    indodax: {
      publicBaseUrl: e.INDODAX_PUBLIC_BASE_URL.replace(/\/+$/, ''),
    },
  };
}

/** Treat empty values from .env files (e.g. `ANTHROPIC_API_KEY=`) as "not set". */
function withoutBlankValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const entries = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value !== '');
  return Object.fromEntries(entries);
}

/** Secret values that must be scrubbed from every log line. */
export function collectSecrets(config: AppConfig): string[] {
  return [config.telegram.botToken, config.ai.apiKey, passwordFromUrl(config.databaseUrl)]
    .filter((s): s is string => typeof s === 'string' && s.length >= 4);
}

function passwordFromUrl(url: string): string | undefined {
  try {
    const password = new URL(url).password;
    return password ? decodeURIComponent(password) : undefined;
  } catch {
    return undefined;
  }
}
