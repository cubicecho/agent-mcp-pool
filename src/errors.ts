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
 *
 * `no-configs` is the odd one out: not a refusal about a server, but about the call itself — a
 * reconcile with nothing to reconcile against, on a pool that has no `load` to ask.
 *
 * `tool-error` is not a refusal at all, which is why it was a plain `Error` for so long: the pool
 * made the call and the *server* said it failed. It is here because it is the one a caller most
 * needs to tell from the rest — a `backoff` or a `connect-failed` is worth retrying and a tool
 * that rejected its arguments is not — and leaving it outside the type meant matching on message
 * text, which is the whole thing this exists to stop.
 *
 * `invalid-arguments` is the pool refusing before the server sees the call: the arguments still
 * failed the tool's own schema after coercion. Its message is written for the model to correct.
 *
 * `timeout` is a call, or a hook's wait for one, that ran out of time. It was a plain `Error`
 * whose only mark was its wording, and it is the one failure a caller most wants to retry.
 */
export type McpPoolErrorCode =
  | "unknown-server"
  | "disabled"
  | "backoff"
  | "connect-failed"
  | "unknown-tool"
  | "out-of-scope"
  | "no-configs"
  | "tool-error"
  | "invalid-arguments"
  | "timeout";

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
  /** For `timeout`: the bound that ran out, in milliseconds. */
  timeoutMs?: number;
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
  readonly timeoutMs?: number;

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
    this.timeoutMs = options.timeoutMs;
  }
}

/**
 * The HTTP status a gateway answers each refusal with.
 *
 * Every consumer in front of an HTTP API wrote this table, and the copies disagreed at the edges.
 * A tool or server that does not exist is `404`, out of scope included, since to that caller it
 * does not exist; a failure on the far side of the pool is `502`; a backoff, which will clear on
 * its own, is `503`; a timeout `504`; arguments the model got wrong `400`; and a pool with nothing
 * to reconcile is the host's own misconfiguration, `500`.
 *
 * @param code An `McpPoolError`'s code.
 * @returns The status to answer with.
 */
export function httpStatusFor(code: McpPoolErrorCode): number {
  return HTTP_STATUS[code];
}

const HTTP_STATUS: Record<McpPoolErrorCode, number> = {
  "unknown-server": 404,
  disabled: 404,
  backoff: 503,
  "connect-failed": 502,
  "unknown-tool": 404,
  "out-of-scope": 404,
  "no-configs": 500,
  "tool-error": 502,
  "invalid-arguments": 400,
  timeout: 504,
};
