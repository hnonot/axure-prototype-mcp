/**
 * Minimal leveled logger.
 *
 * The server speaks a protocol on stdout, so **all** diagnostics go to stderr. That is not
 * a style choice: a single stray `console.log` corrupts the JSON-RPC stream and the client
 * drops the connection, which is a miserable failure to debug.
 *
 * Every log line carries an optional correlation id so the several lines produced by one
 * tool call can be reassembled when something goes wrong.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogFields {
  /** Correlates the lines emitted while serving one tool call. */
  requestId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derives a logger that stamps every line with the same fields. */
  child(fields: LogFields): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Serializes fields without throwing on circular structures. */
function serialize(fields: LogFields | undefined): string {
  if (!fields) return '';
  try {
    return ` ${JSON.stringify(fields, (_key, value) => (value instanceof Error ? value.message : value))}`;
  } catch {
    return ' {"note":"fields were not serializable"}';
  }
}

/**
 * Create a logger writing to stderr.
 *
 * @param level - minimum level to emit.
 * @param base - fields merged into every line, e.g. the server name.
 */
export function createLogger(level: LogLevel = 'info', base: LogFields = {}): Logger {
  const threshold = RANK[level] ?? RANK.info;
  const write = (entryLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (RANK[entryLevel] < threshold) return;
    process.stderr.write(
      `[axure-mcp] ${entryLevel}: ${message}${serialize({ ...base, ...fields })}`.replace(/\n+(?=$)/, '') + '\n',
    );
  };

  const logger: Logger = {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
  return logger;
}

/** A logger that discards everything; useful in tests. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
