import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level: string;
  pretty?: boolean;
  /** Literal secret values scrubbed from every serialized log line. */
  secrets?: string[];
  destination?: DestinationStream;
}

const REDACT_PATHS = [
  'token',
  'botToken',
  'apiKey',
  'secret',
  'secretKey',
  'password',
  'authorization',
  '*.token',
  '*.botToken',
  '*.apiKey',
  '*.secret',
  '*.secretKey',
  '*.password',
  '*.authorization',
  'headers.authorization',
];

/**
 * Pino logger with two layers of protection: key-based redaction, plus a
 * final pass that scrubs known secret values wherever they appear (e.g. a
 * Telegram API URL containing the bot token inside an error message).
 */
export function createLogger(options: LoggerOptions): Logger {
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 4);
  const scrub = (line: string): string =>
    secrets.reduce((acc, secret) => acc.split(secret).join('[REDACTED]'), line);

  const pinoOptions = {
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    hooks: { streamWrite: scrub },
  };

  if (options.destination) {
    return pino(pinoOptions, options.destination);
  }
  if (options.pretty) {
    return pino({
      ...pinoOptions,
      transport: { target: 'pino-pretty', options: { translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', ignore: 'pid,hostname' } },
    });
  }
  return pino(pinoOptions);
}
