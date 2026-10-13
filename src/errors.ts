/**
 * Error taxonomy shared by every layer.
 *
 * Every failure the server can report has a **stable code**, and each code belongs to
 * exactly one category. That distinction is what keeps the layers honest:
 *
 * - `ConfigError`     — the operator must fix the environment; the server cannot start.
 * - `DomainError`     — the request was understood but cannot be satisfied (unknown page,
 *                       unknown widget, content too large). The caller should change its
 *                       arguments or narrow its request.
 * - `InfrastructureError` — the environment failed (no browser, navigation timeout, disk
 *                       write refused). Retrying or fixing the deployment may help.
 *
 * Codes are part of the public contract: they appear in tool results and in tests, so they
 * must not be renamed without a version bump.
 */

/** Stable, documented failure codes. */
export const ERROR_CODES = [
  'CONFIG_INVALID',
  'BROWSER_UNAVAILABLE',
  'NAVIGATION_FAILED',
  'NAVIGATION_BLOCKED',
  'NOT_AXURE_PROJECT',
  'NO_CONTENT_FRAME',
  'OPERATION_TIMEOUT',
  'RENDER_FAILED',
  'PAGE_NOT_FOUND',
  'WIDGET_NOT_FOUND',
  'SCREENSHOT_FAILED',
  'WRITE_FAILED',
  'INVALID_ARGUMENT',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Base class so callers can catch everything this server raises. */
export class AxureMcpError extends Error {
  readonly code: ErrorCode;
  /** Whether the caller can usefully retry the identical request. */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

/** The operator must fix the environment; thrown only during startup. */
export class ConfigError extends AxureMcpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CONFIG_INVALID', message, { ...options, retryable: false });
  }
}

/** The request was understood but cannot be satisfied as asked. */
export class DomainError extends AxureMcpError {
  /** Optional, actionable next step shown to the model. */
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(code, message, { ...options, retryable: false });
    this.hint = options?.hint;
  }
}

/** The environment failed. Some of these are worth retrying. */
export class InfrastructureError extends AxureMcpError {
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; retryable?: boolean; cause?: unknown }) {
    super(code, message, { ...options, retryable: options?.retryable ?? false });
    this.hint = options?.hint;
  }
}

/** A plain `Error` or thrown non-Error reduced to a readable message. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}
