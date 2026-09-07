/**
 * A configured MCP server, as this package needs it.
 *
 * Consumers store these rows differently — a Drizzle table, a zod-validated object — but the
 * fields are the same, so the type is declared here and satisfied structurally. Nothing here
 * imports a schema.
 */
export interface McpServerConfig {
  id: string;
  /**
   * Namespace for this server's tools: the model sees `<slug>__<tool name>`. Defaults to `id`,
   * since a consumer whose ids are already namespace-shaped has nothing else to put here.
   * `state()` reports the effective value either way.
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
   * Optional so consumers that predate it still satisfy the type. Several servers resolve a
   * relative path — a filesystem root, a sqlite file — against their cwd rather than an argument.
   */
  cwd?: string | null;
  /**
   * Close this server after this long without a call, overriding the pool's own timeout.
   *
   * `null` means "use the pool's". `0` disables reaping for this one server, which is what a
   * server too expensive to restart wants.
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
 * `idle` is registered-but-not-connected, and where an idle-reaped server goes — a success state:
 * nothing is wrong, there is simply no child right now. Distinct from `disabled` (switched off)
 * and `error` (tried, failed, waiting out a backoff), which an operator reads differently.
 */
export type McpStatus = "disabled" | "idle" | "connecting" | "ready" | "error";

/**
 * A row as `state()` reports it: everything except the credentials, unless they were asked for.
 *
 * `env` and `headers` are an API key and an `Authorization: Bearer` for a real server, and the
 * shortest way to draw an edit form beside a connection status is to send `state()` to a browser.
 * They are optional here rather than absent so `state({ secrets: true })` — the caller that is
 * genuinely rendering that form server-side — can hand back the whole row under one type.
 */
export type McpServerPublicConfig = Omit<McpServerConfig, "env" | "headers"> &
  Partial<Pick<McpServerConfig, "env" | "headers">>;

/** One connected server as an operator sees it. */
export interface McpServerState {
  id: string;
  /** The effective namespace — the row's `slug`, or its `id` when the row set none. */
  slug: string;
  /** The effective display name — the row's `label`, or its slug when the row set none. */
  label: string;
  /**
   * The row this server is configured from, minus its credentials — see `McpServerPublicConfig`.
   *
   * The pool is already holding it, and a UI drawing the edit form beside the connection state
   * would otherwise keep a second copy — one that goes stale the moment `syncSoon()` or a
   * `load`-driven `sync()` reconciles without it. A copy rather than the row itself: the pool's
   * record of what it dialled must not be editable from outside it.
   */
  config: McpServerPublicConfig;
  status: McpStatus;
  error: string;
  tools: { name: string; description: string }[];
  /**
   * The stdio child's pid. Absent over http, and while the server is not connected.
   *
   * What an operator reaches for to find a wedged child in `ps` or to `kill -9` it, and not
   * recoverable from anywhere else once the pool owns the transport.
   */
  pid?: number;
  /**
   * When this connection became ready, ISO 8601. Absent while the server is not connected.
   *
   * How a server that is quietly crash-looping is spotted: `status` reads `ready` either side of
   * a restart, and only the start time says the restart happened.
   */
  startedAt?: string;
}

/** What `probe` found: whether the config works, and what it offers if it does. */
export interface McpProbe {
  ok: boolean;
  error: string;
  tools: { name: string; description: string }[];
}

/**
 * One server's tools, without their JSON schemas — the cheap half of a tool definition.
 *
 * Mirrors `CatalogServer` in `@cubicecho/agent-core`, which its on-demand tool loading reads.
 * Declared rather than imported: three structural fields are not worth a dependency. Keep the two
 * in step.
 */
export interface CatalogServer {
  id: string;
  label: string;
  tools: { name: string; description: string }[];
}

/**
 * One tool as an OpenAI-compatible model is offered it — the function arm of OpenAI's
 * `ChatCompletionTool`, and assignable to it.
 *
 * Declared here rather than imported for the same reason as `CatalogServer`: the shape is a
 * literal and two fields, and TypeScript is structural. `openai` was a *required* peer for this
 * one type position, so a consumer that never calls a model — a gateway proxying MCP — installed
 * 24 MB to satisfy a type that is erased at compile time. A test typechecks the two together.
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** The tool's JSON Schema, as its server described it. */
    parameters?: Record<string, unknown>;
  };
}
