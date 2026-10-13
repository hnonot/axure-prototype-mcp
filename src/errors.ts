/** Error codes surfaced to the calling agent through `isError` tool results. */
export type AxureErrorCode =
  | 'INVALID_PAGE'
  | 'NAVIGATION_FAILED'
  | 'NOT_AXURE_PROJECT'
  | 'NO_CONTENT_FRAME'
  | 'WIDGET_NOT_FOUND'
  | 'RENDER_FAILED'
  | 'BROWSER_UNAVAILABLE';

/** A failure with a stable machine-readable code and an agent-actionable message. */
export class AxureError extends Error {
  readonly code: AxureErrorCode;
  readonly hint: string | undefined;

  constructor(code: AxureErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'AxureError';
    this.code = code;
    this.hint = hint;
  }
}

/** Build the deterministic text block returned for a failed tool call. */
export function formatError(error: unknown): string {
  if (error instanceof AxureError) {
    return [
      `error: ${error.code}`,
      `message: ${error.message}`,
      ...(error.hint ? [`hint: ${error.hint}`] : []),
    ].join('\n');
  }
  return `error: UNEXPECTED\nmessage: ${error instanceof Error ? error.message : String(error)}`;
}
