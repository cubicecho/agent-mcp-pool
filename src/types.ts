import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

/**
 * Everything a configured server carries whichever way it is reached — its identity and its
 * clocks. Not exported on its own: a row is always one of the two arms below.
 */
interface McpServerBase {
  id: string;
  /**
   * Namespace for this server's tools: the model sees `<slug>__<tool name>`. Defaults to `id`,
   * since a consumer whose ids are already namespace-shaped has nothing else to put here.
   * `state()` reports the effective value either way.
   */
  slug?: string;
  label: string;
  enabled: boolean;
  /**
   * Close this server after this long without a call, overriding the pool's own timeout.
   *
   * `null` means "use the pool's". `0` disables reaping for this one server, which is what a
   * server too expensive to restart wants.
   */
  idleTimeoutMs?: number | null;
  /**
   * How long *this* server gets to connect — `initialize` and every page of `tools/list` together
   * — overriding the pool's.
   *
   * Connect cost is a property of the server rather than of the pool: a local `node` child is up
   * in milliseconds, and `uvx some-server@latest` on a cold cache resolves and downloads a package
   * before it says anything. One pool-wide number has to be the maximum of those, which leaves the
   * fast ones with no useful bound — the wedged child this exists to catch still hangs for as long
   * as the slow one legitimately needs.
   *
   * `null` means "use the pool's", and so does absent — which is what every row that predates this
   * field says. Re-read on every reconcile, so a consumer whose configuration is editable at
   * runtime does not need a restart to change it; it applies at the next connect, since an edited
   * timeout is no reason to bounce a running child. No special zero, unlike `idleTimeoutMs`: `0`
   * is a server given no time at all.
   */
  connectTimeoutMs?: number | null;
  /**
   * How long one `call()` against *this* server gets, overriding the pool's.
   *
   * The same argument as `connectTimeoutMs` and a different distribution: a filesystem read and a
   * deep-research server that thinks for ninety seconds cannot share a number either, and the one
   * that has to accommodate both leaves the fast server unbounded. `null` and absent both mean
   * "use the pool's"; read at call time, so an edit applies to the next call without a reconnect.
   */
  callTimeoutMs?: number | null;
}

/**
 * A server reached by spawning a child process and speaking MCP over its stdio.
 *
 * Everything but `command` is optional: a server with no arguments, no extra environment and no
 * particular working directory is the common row, and it should not have to write three nulls to
 * say so.
 */
export interface StdioServerConfig extends McpServerBase {
  transport: "stdio";
  command: string;
  args?: string[] | null;
  env?: Record<string, string> | null;
  /**
   * Working directory for the child. Absent means this process's own.
   *
   * Several servers resolve a relative path — a filesystem root, a sqlite file — against their cwd
   * rather than an argument.
   */
  cwd?: string | null;
}

/** A server reached over streamable HTTP, at a url this process does not own the lifetime of. */
export interface HttpServerConfig extends McpServerBase {
  transport: "http";
  url: string;
  headers?: Record<string, string> | null;
}

/**
 * A configured MCP server, as this package needs it.
 *
 * Consumers store these rows differently — a Drizzle table, a zod-validated object — but the
 * fields are the same, so the type is declared here and satisfied structurally. Nothing here
 * imports a schema.
 *
 * A union on `transport` rather than one flat row carrying both arms' fields. Flat, an http row
 * still had to write `command: ""`, `args: null`, `env: null` to typecheck — three fields nothing
 * would ever read, and a `command` that reads as configured rather than as absent. It also let a
 * stdio row compile with no `command` at all, which `createTransport` could only refuse at
 * runtime, one connect too late.
 */
export type McpServerConfig = StdioServerConfig | HttpServerConfig;

/**
 * How this process introduces itself in a handshake: the `clientInfo` of MCP's `initialize`.
 *
 * The only thing a dialled server learns about who is calling it, so it is what a server logs,
 * gates a behaviour on, or quotes back in a support channel. `version` is optional here and
 * required by the protocol: absent, this package reports its own.
 */
export interface ClientIdentity {
  name: string;
  version?: string;
}

/**
 * The connection half of one arm of a row — everything about reaching the server, none of what
 * names it.
 *
 * `T extends unknown` makes this distribute over the union rather than collapse it: a plain
 * `Pick` across both arms answers with one object type that has every field of both, which is the
 * shape this package moved away from.
 */
type ConnectionOf<T> = T extends unknown
  ? Pick<T, Extract<keyof T, "transport" | "command" | "args" | "env" | "cwd" | "url" | "headers">>
  : never;

/**
 * What it takes to reach a server — the connection half of a row, without its identity.
 *
 * `connectTimeoutMs` is in here because it is part of reaching the server rather than of naming
 * it: a row that needs two minutes to start needs them behind a "Test connection" button too, or
 * the probe reports a failure for a server that works.
 */
export type McpConnection = ConnectionOf<McpServerConfig> & Pick<McpServerBase, "connectTimeoutMs">;

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
export type McpServerPublicConfig = PublicRow<McpServerConfig>;

/**
 * One arm of a row with its credentials made optional.
 *
 * Distributed like `ConnectionOf`, and for the same reason — but `Omit` is the operator that
 * makes it necessary rather than merely tidy: `Omit` over a union collapses to the keys the arms
 * share, which would drop `command` and `url` both. The `Extract` is because neither arm has both
 * credential fields, and `Pick` refuses a key its argument does not have.
 */
type PublicRow<T> = T extends unknown
  ? Omit<T, "env" | "headers"> & Partial<Pick<T, Extract<keyof T, "env" | "headers">>>
  : never;

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
  /**
   * What this server offers, while it is connected. Empty under `indexTools: false`, which is the
   * honest answer: a consumer that opted out of indexing is not the one drawing a tool list.
   */
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
  /**
   * The server's own `instructions` from the handshake. Absent while it is not connected, and
   * where the server sent none.
   *
   * What the field is for is a system prompt — servers use it for what a tool description has no
   * room for ("resolve the library id before querying docs", "these are the roots I answer for").
   * Reported here rather than left to `client()`, which is the call path's own door and *dials* an
   * idle server: building a prompt must not spawn children, and it is synchronous where `client()`
   * is not. Captured at connect like `tools`, so this costs no round trip.
   */
  instructions?: string;
  /**
   * What the server declared it supports in the handshake. Absent while it is not connected.
   *
   * Reported even under `indexTools: false`, unlike `tools`: this is one field off a handshake the
   * pool made anyway, and the consumer that opted out of indexing — a gateway proxying the
   * protocol — is exactly the one that needs it. Without it there is no way to tell whether
   * `resources/list` or `prompts/list` on a `client()` is worth attempting, so the choice is an
   * error round trip per server per surface, or not offering the surface at all.
   */
  capabilities?: ServerCapabilities;
}

/** What `probe` found: whether the config works, and what it offers if it does. */
export interface McpProbe {
  ok: boolean;
  error: string;
  tools: { name: string; description: string }[];
  /**
   * The server's own `instructions` from the handshake, empty where it sent none or never got
   * that far.
   *
   * "Test connection" is where an operator finds out what a row actually offers, and a server's
   * instructions are the half of that a tool list does not show — a row worth saving is often the
   * one whose guidance says what its tools are for.
   */
  instructions: string;
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
