/** Tiny structured logger: no dependencies, one line per event, silent in tests. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  quiet?: boolean;
  scope?: string;
  /** Override the sink (tests collect lines here). */
  sink?: (line: string) => void;
}

function format(level: LogLevel, scope: string | undefined, message: string, meta?: Record<string, unknown>): string {
  const prefix = scope ? `[agil:${scope}]` : '[agil]';
  const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `${new Date().toISOString()} ${level.toUpperCase()} ${prefix} ${message}${suffix}`;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const quiet = options.quiet === true;
  const sink = options.sink ?? ((line: string) => console.log(line));
  const make = (scope: string | undefined): Logger => ({
    debug: (message, meta) => {
      if (!quiet) sink(format('debug', scope, message, meta));
    },
    info: (message, meta) => {
      if (!quiet) sink(format('info', scope, message, meta));
    },
    warn: (message, meta) => {
      if (!quiet) sink(format('warn', scope, message, meta));
    },
    error: (message, meta) => {
      if (!quiet) sink(format('error', scope, message, meta));
    },
    child: (childScope) => make(scope ? `${scope}:${childScope}` : childScope),
  });
  return make(options.scope);
}

/** Logger that discards everything (default for programmatic/test usage). */
export const silentLogger: Logger = createLogger({ quiet: true });
