/**
 * A configured MCP server, as this package needs it.
 *
 * The three servers that consume this each store these rows differently — two as a Drizzle
 * `mcp_servers` table, one as a zod-validated config object — but the nine fields are the same
 * nine in all three, so the type is declared here and satisfied structurally. A consumer passes
 * its own rows straight in; nothing here imports a schema.
 */
export interface McpServerConfig {
  id: string;
  /**
   * Namespace for this server's tools: the model sees `<slug>__<tool name>`. Defaults to `id`.
   *
   * Optional because a consumer whose ids are already namespace-shaped has nothing else to put
   * here, and a `slug` column beside such an id is a second name on the operator's screen with
   * nothing to tell it from the first — and a way to make the two disagree. A consumer with a
   * real slug column keeps passing one; `state()` reports the effective value either way, so
   * neither has to work out what its tools ended up being called.
   */
  slug?: string;
  label: string;
  enabled: boolean;
  transport: "stdio" | "http";
  // stdio
  command: string;
  args: string[] | null;
  env: Record<string, string> | null;
  /**
   * Working directory for a stdio child. Absent means this process's own.
   *
   * Optional because the three consumers that predate it store no such column and must keep
   * satisfying this type. Several real servers resolve relative paths — a filesystem root, a
   * sqlite file — against their cwd rather than against an argument, and a gateway that installs
   * each server into its own directory has nowhere else to say so.
   */
  cwd?: string | null;
  /**
   * Close this server after this long without a call, overriding the pool's own timeout.
   *
   * Optional, and `null` is "use the pool's". `0` disables reaping for this one server, which is
   * what a server too expensive to restart wants.
   */
  idleTimeoutMs?: number | null;
  // streamable http
  url: string;
  headers: Record<string, string> | null;
}

/** What it takes to reach a server — the connection half of a row, without its identity. */
export type McpConnection = Pick<
  McpServerConfig,
  "transport" | "command" | "args" | "env" | "cwd" | "url" | "headers"
>;

/**
 * `idle` is a lazy pool's registered-but-not-connected, and also where an idle-reaped server
 * goes. It is a success state: nothing is wrong, there is simply no child right now, and the
 * next use starts one. Kept distinct from `disabled` (switched off, will not connect) and from
 * `error` (tried, failed, waiting out a backoff) because an operator reads all three differently.
 */
export type McpStatus = "disabled" | "idle" | "connecting" | "ready" | "error";

/** One connected server as an operator sees it. */
export interface McpServerState {
  id: string;
  /** The effective namespace — the row's `slug`, or its `id` when the row set none. */
  slug: string;
  label: string;
  /**
   * The row this server is configured from, exactly as it was passed in.
   *
   * The pool is already holding it, and a consumer whose UI draws the edit form and the
   * connection state as one row otherwise has to keep a second copy of rows the pool has —
   * a shadow that goes stale the moment anything reconciles without going through it, which
   * `syncSoon()` and a `load`-driven `sync()` both do.
   *
   * `id`, `slug` and `label` stay alongside it rather than being folded into it: those are the
   * *effective* values the pool actually used, and duplicating three derived fields inside one
   * object is not the same failure as keeping a second map that can disagree with this one.
   */
  config: McpServerConfig;
  status: McpStatus;
  error: string;
  tools: { name: string; description: string }[];
}

export interface McpProbe {
  ok: boolean;
  error: string;
  tools: { name: string; description: string }[];
}

/**
 * One server's tools, without their JSON schemas — the cheap half of a tool definition.
 *
 * This mirrors `CatalogServer` in `@cubicecho/agent-core`, which is what that package's
 * on-demand tool loading reads. It is declared here rather than imported because the shape is
 * three fields and TypeScript is structural: `catalog()`'s return value satisfies agent-core's
 * interface without this package depending on it. Keep the two in step.
 */
export interface CatalogServer {
  id: string;
  label: string;
  tools: { name: string; description: string }[];
}
