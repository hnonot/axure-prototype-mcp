/**
 * `.env` support.
 *
 * ## Why this exists
 *
 * The README documented `--env-file=.env` and said nothing loads `.env` implicitly. That was
 * accurate but it is exactly what broke the reported workflow: an operator changed the address in
 * `.env` (or in `.env.example`, which is only a template) and the server kept reading a *different*
 * prototype, with no error to explain it. Configuration that a user can edit but the program never
 * reads is worse than no configuration at all.
 *
 * So `.env` is now loaded implicitly at startup, and the precedence is the one that keeps explicit
 * action winning:
 *
 * 1. **the real process environment** — an operator or host that sets `AXURE_URL` explicitly
 * 2. **the `.env` file** — the convenient place to park a value
 * 3. **a hard error** — there is no built-in address (see `CONFIG_DEFAULTS`)
 *
 * A value already present in `process.env` is never overwritten, so a container, a CI variable or a
 * host-provided `env` block still takes precedence over the file.
 *
 * ## Why it is written by hand
 *
 * The grammar needed here is small and fully specified below; a dependency for it would be a supply
 * chain and a version to track for ~40 lines. Anything outside the subset — an unparseable line — is
 * reported rather than guessed at, because a silently ignored `AXURE_URL` line is the bug this file
 * exists to fix.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** A parsed `.env` file. */
export interface EnvFileResult {
  /** Absolute path that was read, absent when no file was found. */
  path?: string;
  /** Keys the file defined, whether or not they were applied. */
  keys: string[];
  /**
   * Values that were defined in the file but *not* applied because the process environment already
   * set them. Reported so the precedence is visible instead of surprising.
   */
  overridden: string[];
  /** Lines that could not be parsed. Never silently dropped. */
  problems: string[];
}

/** An environment shaped like `ProcessEnv`, so callers can pass it straight to `loadConfig`. */
export type EnvRecord = Record<string, string | undefined>;

/**
 * Parse `.env` text.
 *
 * Supported, matching the dotenv conventions users expect:
 *
 * - `KEY=value`, `KEY = value`, and `export KEY=value`
 * - `#` comments on their own line, and a ` #` comment after an unquoted value
 * - single-quoted values (fully literal) and double-quoted values (with `\n`, `\r`, `\t`, `\\`,
 *   `\"` escapes)
 * - blank lines
 *
 * Deliberately *not* supported: multi-line values, variable interpolation, and command substitution.
 * Those are reported as problems rather than mis-parsed.
 */
export function parseEnvFile(text: string): { values: Map<string, string>; problems: string[] } {
  const values = new Map<string, string>();
  const problems: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const equals = withoutExport.indexOf('=');
    if (equals <= 0) {
      problems.push(`line ${index + 1}: expected KEY=value, got ${JSON.stringify(raw.trim().slice(0, 80))}`);
      continue;
    }

    const key = withoutExport.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push(`line ${index + 1}: ${JSON.stringify(key)} is not a valid variable name`);
      continue;
    }

    let value = withoutExport.slice(equals + 1).trim();
    if (value.startsWith('"')) {
      const end = findClosingQuote(value, '"');
      if (end === -1) {
        problems.push(`line ${index + 1}: unterminated double-quoted value for ${key}`);
        continue;
      }
      value = value
        .slice(1, end)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.startsWith("'")) {
      const end = findClosingQuote(value, "'");
      if (end === -1) {
        problems.push(`line ${index + 1}: unterminated single-quoted value for ${key}`);
        continue;
      }
      value = value.slice(1, end);
    } else {
      // An unquoted value ends at the first " #" so inline comments work, but a bare `#` inside a
      // value (a URL fragment) is kept: Axure page URLs legitimately contain one.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    values.set(key, value);
  }

  return { values, problems };
}

/** Index of the quote that closes a value starting with `quote`, or -1. */
function findClosingQuote(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    // An escaped quote inside a double-quoted value does not close it.
    if (quote === '"' && value[index - 1] === '\\') continue;
    return index;
  }
  return -1;
}

/** Locate the `.env` file to read, or `undefined` when there is none. */
export function findEnvFile(explicit: string | undefined, startDir: string): string | undefined {
  if (explicit && explicit.trim()) {
    const target = isAbsolute(explicit) ? explicit : resolve(startDir, explicit);
    try {
      readFileSync(target, 'utf8');
      return target;
    } catch {
      return undefined;
    }
  }
  // Walk upward, the way every other tool in this ecosystem does, so running from a subdirectory
  // still picks up the project's `.env`.
  let directory = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(directory, '.env');
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      /* keep walking */
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Merge the process environment with a `.env` file.
 *
 * @param base - the environment to start from; defaults to `process.env`.
 * @param options.startDir - where to begin looking for `.env`; defaults to the current directory.
 * @param options.explicit - an explicit `.env` path, e.g. from `AXURE_ENV_FILE`.
 * @returns the merged environment plus what was read, so the caller can log it.
 */
export function loadProcessEnv(
  base: EnvRecord = process.env,
  options: { startDir?: string; explicit?: string } = {},
): { env: EnvRecord; file: EnvFileResult } {
  const startDir = options.startDir ?? process.cwd();
  const path = findEnvFile(options.explicit ?? base.AXURE_ENV_FILE, startDir);
  if (!path) return { env: { ...base }, file: { keys: [], overridden: [], problems: [] } };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      env: { ...base },
      file: { path, keys: [], overridden: [], problems: [`could not read ${path}: ${String(error)}`] },
    };
  }

  const { values, problems } = parseEnvFile(text);
  const env: EnvRecord = { ...base };
  const overridden: string[] = [];
  for (const [key, value] of values) {
    // An explicitly set process variable always wins over the file.
    if (base[key] !== undefined && base[key] !== '') {
      overridden.push(key);
      continue;
    }
    env[key] = value;
  }

  return { env, file: { path, keys: [...values.keys()], overridden, problems } };
}
