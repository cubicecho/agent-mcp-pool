/**
 * What went wrong, as a string.
 *
 * A `catch` binds `unknown` and every status here is a string, so this ternary was otherwise
 * repeated at each site. Copied from `@cubicecho/agent-core` rather than imported: it is one
 * expression, and depending on the framework for it would make this package need it.
 */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Which of the pool's refusals this is.
 *
 * `backoff` and `connect-failed` are the pair worth telling apart and the hardest to: both read
 * as "not connected", but the first means the pool did not dial — a recent failure is still
 * inside its backoff — and the second means it dialled just now and could not. A caller in front
 * of an HTTP API answers those differently, and only the pool knows which happened.
 *
 * `unknown-tool` and `out-of-scope` carry the same message on purpose: a run must not learn that
 * a server it was not scoped to exists. The code is for the caller's log, not for the model.
 */
export type McpPoolErrorCode =
  | "unknown-server"
  | "disabled"
  | "backoff"
  | "connect-failed"
  | "unknown-tool"
  | "out-of-scope";

/** What an `McpPoolError` carries beyond its message. */
export interface McpPoolErrorOptions {
  /** The server the refusal is about, where the pool knows which one that is. */
  serverId?: string;
  /** The qualified name a `call` asked for. */
  toolName?: string;
  /** The child's stderr, where there was any — usually the only real explanation. */
  detail?: string;
  /** For `backoff`: when the next attempt becomes due, as a `Date.now()` stamp. */
  retryAt?: number;
  cause?: unknown;
}

/**
 * A refusal from the pool, with a discriminant.
 *
 * Every one of these used to be a plain `Error`, so a caller could only tell "no such server"
 * from "in backoff" by matching on the message text — and the two that matter most, a backoff and
 * a connect that just failed, share their wording. Extends `Error` and keeps the same messages,
 * so anything reading `.message` is unaffected.
 */
export class McpPoolError extends Error {
  readonly code: McpPoolErrorCode;
  readonly serverId?: string;
  readonly toolName?: string;
  readonly detail?: string;
  readonly retryAt?: number;

  /**
   * @param code Which refusal this is.
   * @param message What a caller with nothing but `.message` sees. Unchanged from the plain
   *   `Error`s these replaced.
   * @param options See `McpPoolErrorOptions`. All of it is absent for refusals it cannot describe.
   */
  constructor(code: McpPoolErrorCode, message: string, options: McpPoolErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "McpPoolError";
    this.code = code;
    this.serverId = options.serverId;
    this.toolName = options.toolName;
    this.detail = options.detail;
    this.retryAt = options.retryAt;
  }
}
