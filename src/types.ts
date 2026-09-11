import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

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
  // streamable http
  url: string;
  headers: Record<string, string> | null;
  /**
   * This server's tools the model is not offered, by the server's own names.
   *
   * For a tool that is for the host rather than the model — a memory server's `remember`, run by
   * a hook after every turn, is one the model calling as well would only file twice. Left out of
   * `tools()` and `catalog()`, and refused by `call()` exactly as a tool that does not exist is,
   * unless the caller says `hidden: true` — which hooks do. Read at call time, so an edit applies
   * without a reconnect.
   */
  hiddenTools?: string[] | null;
  /**
   * Tool calls this server wants made at points in a session — see `ToolHook` and
   * `McpPool.runHooks`. Run by the consumer, never by the pool on its own: only the consumer knows
   * when a turn starts. Read at the time they run, like `hiddenTools`.
   */
  hooks?: ToolHook[] | null;
}

/**
 * A point in a session a hook can be bound to. Named after Claude Code's hooks of the same shape,
 * so a server's documented config reads the same on every host:
 *
 * - `sessionStart` — before the first turn of a session (SessionStart).
 * - `beforeTurn` — before each turn's request is sent (UserPromptSubmit).
 * - `afterTurn` — once a turn has its reply (Stop).
 * - `beforeCompact` — before old messages are summarised away (PreCompact).
 * - `sessionEnd` — when a run that ends, ends (SessionEnd). A chat that never ends never sends it.
 * - `sessionDelete` — when the host deletes a session's record.
 */
export type HookEvent =
  | "sessionStart"
  | "beforeTurn"
  | "afterTurn"
  | "beforeCompact"
  | "sessionEnd"
  | "sessionDelete";

/**
 * One message of a session as a hook is handed it. The shape a memory server's `remember` takes,
 * so a template can pass a turn straight through.
 */
export interface HookMessage {
  speaker: string;
  text: string;
  /** Stable across retries, so a server that dedups on it files a re-sent turn once. */
  uuid: string;
}

/**
 * One tool call a row wants made at a point in a session.
 *
 * Only reads and adds: a hook cannot stop a turn or change what the user said. What one returns
 * reaches the model only when `inject` is set, and only on the events that run before a request.
 */
export interface ToolHook {
  /** Stable within its row; what a failure notice and a UI name it by. */
  id: string;
  on: HookEvent;
  /** The server's own name for the tool — not the qualified one, which a rename changes. */
  tool: string;
  /**
   * The tool's arguments, as JSON, with `{{path}}` placeholders filled from the event's context —
   * see `expandArgs`. A path the context has no value for skips the hook.
   */
  args?: unknown;
  /** Hand what the tool returns to the model. `sessionStart` and `beforeTurn` only. */
  inject?: boolean;
  /** The most of this hook's output that is injected, in estimated tokens. 1000 if not set. */
  maxTokens?: number;
  /** How long the call gets. 3000 on the events that inject; the call's own timeout otherwise. */
  timeoutMs?: number;
  /** `false` keeps the hook on the row without running it. */
  enabled?: boolean;
}

/**
 * What a host knows at an event, for a hook's templates. Every field but `session` is optional
 * because no event carries all of them — `validateHooks` knows which carries which.
 */
export interface HookContext {
  session: { id: string };
  /** Which program is running the session — `min-agent`, `kanban` — for a server shared by several. */
  host?: string;
  /** ISO 8601. Filled in by `runHooks` when absent. */
  now?: string;
  /** The user's message this turn, or the session's opening one. */
  prompt?: string;
  /** The assistant's final text. */
  reply?: string;
  turn?: {
    /** Where this turn starts in the session's message list. */
    index: number;
    /** The turn's user and assistant text, tool traffic left out. */
    messages?: HookMessage[];
  };
  /** The messages about to be summarised away. */
  compacting?: HookMessage[];
  /** Message indexes of that range, `through` exclusive. */
  range?: { from: number; through: number };
  /** How a run ended. */
  status?: "ok" | "stopped" | "error";
  /** The host's own extras — a card id, a task step. Any `vars.*` path is accepted. */
  vars?: Record<string, unknown>;
}

/** What one hook did. `runHooks` returns one per hook it considered, in configuration order. */
export interface HookOutcome {
  serverId: string;
  /** The server's display name — what an injected block and a notice call it. */
  label: string;
  hookId: string;
  event: HookEvent;
  /** The call ran and the tool did not report an error. */
  ok: boolean;
  /** What the tool returned. Absent when it returned nothing, and when the call failed. */
  text?: string;
  /** Why it failed or was skipped. */
  error?: string;
  /** Set when the hook never ran — a placeholder with no value, or a signal already aborted. */
  skipped?: boolean;
  /** Wall time, dispatch to answer. */
  ms: number;
  inject: boolean;
  /** The hook's effective `maxTokens`. */
  maxTokens: number;
}

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
 * What it takes to reach a server — the connection half of a row, without its identity.
 *
 * `connectTimeoutMs` is in here because it is part of reaching the server rather than of naming
 * it: a row that needs two minutes to start needs them behind a "Test connection" button too, or
 * the probe reports a failure for a server that works.
 */
export type McpConnection = Pick<
  McpServerConfig,
  "transport" | "command" | "args" | "env" | "cwd" | "url" | "headers" | "connectTimeoutMs"
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
  /**
   * What this server offers, while it is connected. Empty under `indexTools: false`, which is the
   * honest answer: a consumer that opted out of indexing is not the one drawing a tool list.
   *
   * `hidden` is whether the row's `hiddenTools` keeps it from the model. Reported rather than
   * filtered out: the operator is the one who hid it, and the form they unhide it from needs it.
   */
  tools: { name: string; description: string; hidden: boolean }[];
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
