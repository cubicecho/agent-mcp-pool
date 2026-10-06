import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ElicitRequestParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResultCacheOptions } from "./result-cache.ts";
import type { TransportFactory } from "./transport.ts";
import type { HookOutcome, McpServerConfig, ToolsCache } from "./types.ts";

/**
 * What a pool and its methods are told: the constructor's options and each call's.
 *
 * Apart from `pool.ts` so that what runs on the pool's behalf — the hook runner — can be typed
 * against these without importing the class that imports it.
 */

/**
 * Where the pool's own progress goes.
 *
 * Named so a consumer wiring its own logger in has something to type the adapter against —
 * `McpPoolOptions["log"]` is optional, so it had to unwrap the `undefined` first.
 */
export interface PoolLog {
  info?: (message: string) => void;
  error?: (message: string) => void;
}

/** How a pool is built: where its rows come from, how patient it is, and what it may spawn. */
export interface McpPoolOptions {
  /**
   * Where the configured servers come from when `sync()` is called with nothing.
   *
   * The seam that used to be an `import { db }`. The pool has no opinion about where rows live —
   * a Drizzle select, a parsed config file, a constant array in a test — it only needs to be able
   * to ask again after a write.
   */
  load?: () => Promise<McpServerConfig[]>;
  /** How this process introduces itself to the servers it connects to. */
  clientName?: string;
  /**
   * The version reported beside `clientName` in the handshake. Defaults to this package's own.
   *
   * `clientInfo` is the whole of what a dialled server learns about its caller, and the pool
   * used to fill half of it in with a constant `0.1.0` — a version of nothing, indistinguishable
   * from a real one. Set it with `clientName`: a name that is the consumer's beside a version
   * that is the pool's still tells the server something untrue.
   */
  clientVersion?: string;
  /** Where the pool's own progress goes. Defaults to the console; pass `{}` to silence it. */
  log?: PoolLog;
  /** How long a failed server is left alone before it is dialled again. Defaults to 5s. */
  crashBackoffMs?: number;
  /**
   * Which of this process's environment variables a stdio child inherits. Defaults to all of
   * them; `MINIMAL_CHILD_ENV` is a sensible allowlist to narrow to.
   */
  childEnv?: readonly string[];
  /**
   * What every http server is reached with. Defaults to `keepAliveFetch()`, which keeps an idle
   * connection for 30s so a tool call after a pause does not open a new one.
   *
   * Pass `keepAliveFetch(ms)` for another idle time, or a `fetch` of your own for a proxy.
   * `probe()` uses it too.
   */
  fetch?: FetchLike;
  /**
   * How long a server gets to connect: `initialize` and every page of `tools/list` together.
   *
   * The SDK already applies its own 60s default, so this is not about an unbounded hang — it is
   * about how long a boot is willing to stall. One budget for the whole connect rather than one
   * per request, since page size is the server's choice and a per-request number would multiply
   * by a page count nobody knows in advance. `sync` connects servers in parallel, but one wedged
   * server still holds the whole reconcile open for the full timeout.
   *
   * The pool-wide default. `McpServerConfig.connectTimeoutMs` overrides it for one server, which
   * is where a `uvx` package that downloads itself on first run belongs.
   */
  connectTimeoutMs?: number;
  /**
   * How long `probe()` waits, when a probe should not wait as long as a boot.
   *
   * Defaults to `connectTimeoutMs`, because a probe exists to dial the way the pool does. Set it
   * when the two have different audiences: a reconcile of thirty servers can afford to be
   * patient, and a person who pressed "Test connection" cannot. A probed row's own
   * `connectTimeoutMs` outranks both — see `McpPool.probe`.
   */
  probeTimeoutMs?: number;
  /**
   * How long one `call()` gets before it is abandoned.
   *
   * Absent leaves the SDK's own 60s, which is what this existed to improve on everywhere else and
   * was unreachable here: `connectTimeoutMs` is worked out to three levels of precedence and then
   * a tool call took whatever the SDK felt like. For an agent loop it is the number that matters
   * most — a wedged tool holds up the turn, and the turn is what a person is waiting on.
   *
   * The pool-wide default. `McpServerConfig.callTimeoutMs` overrides it for one server, which is
   * where a search that legitimately takes a minute belongs.
   */
  callTimeoutMs?: number;
  /**
   * Repair a model's arguments against the tool's own schema before sending them, and refuse
   * what cannot be repaired as `invalid-arguments`. On by default.
   *
   * Local models send `"5"` for a number, `"true"` for a boolean, an object as a JSON string, and
   * `""` for a parameter they meant to omit; a strict server refuses every one, and the model
   * reads its stack trace. See `coerceArguments` for exactly what is repaired. Off sends the
   * arguments exactly as given. `McpServerConfig.coerceArguments` overrides this for one server,
   * and `CallOptions.coerce` for one call.
   */
  coerceArguments?: boolean;
  /**
   * The most characters one `call()` returns, head and tail kept around a marker. Unset is no cap.
   *
   * A tool that reads a file or a page can return more than a local model's whole window, and a
   * server does not know how small the reader is. Applied to the text a call returns and to a
   * `tool-error`'s message; see `truncateText` for the cut. `McpServerConfig.maxResultChars`
   * overrides it for one server and `CallOptions.maxResultChars` for one call.
   */
  maxResultChars?: number;
  /**
   * The most characters a tool's description may take in `tools()`. Unset is no cap.
   *
   * OpenAI refuses a function description past 1024 characters, and a server is free to send
   * several thousand — a whole usage guide, sometimes the tool's own examples. The refusal is of
   * the request rather than of that one tool, so one verbose server costs the model every other
   * server's tools as well.
   *
   * Counted over the description the model is sent, `[Label] ` prefix included, since that is what
   * the API measures. `state()`, `catalog()` and `describe()` still report the server's own text
   * in full: this is a wire limit, not an opinion about what a tool should say for itself.
   */
  maxDescriptionChars?: number;
  /**
   * Answers a server that asks the user for input mid-call: MCP's `elicitation/create`.
   *
   * Absent, the pool declares no elicitation capability, so a well-behaved server does not ask and
   * one that asks anyway is refused by the SDK. Present, every connection declares it and routes
   * each request here with the id of the server that sent it. Resolve with `accept` and the
   * `content`, or `decline` or `cancel`. A listener that throws is logged and answered `cancel`,
   * so a broken prompt does not fail the server's tool with a protocol error.
   *
   * A person answering takes time, and the call that caused the request is still on its clock:
   * set `callTimeoutMs` for that server with the wait in mind.
   *
   * @param serverId The config id of the server asking.
   * @param params The request: `message`, and `requestedSchema` for a form or `url` for a link.
   * @param extra `signal` aborts when the server gives up on the request.
   * @returns The user's answer.
   */
  onElicit?: (
    serverId: string,
    params: ElicitRequestParams,
    extra: { signal: AbortSignal },
  ) => ElicitResult | Promise<ElicitResult>;
  /**
   * Which elicitation modes `onElicit` can handle. Defaults to `["form"]`.
   *
   * `form` asks for fields against a flat schema; `url` asks the user to open a link, for a flow
   * such as an OAuth consent the client should not see. Declare `url` only when the host can open
   * one, since a server takes the declaration as a promise.
   */
  elicitationModes?: ("form" | "url")[];
  /**
   * Register servers without connecting them; connect on first use instead.
   *
   * Off by default: for an agent loop, spawning a child per run costs more than the run. A
   * gateway has the opposite pressure — dozens of servers, most idle most of the time.
   *
   * An unconnected server sits at `idle`. `call()` and `client()` connect it; `tools()` and
   * `catalog()` do not, so they report nothing for it until something has.
   */
  lazy?: boolean;
  /**
   * Close a connected server after this long without a call, leaving it able to reconnect.
   *
   * Absent means never. Reset on every use. A reap is a success path, not a crash: the server
   * returns to `idle` rather than `error`, no backoff applies, and the next use reconnects
   * immediately. `McpServerConfig.idleTimeoutMs` overrides it for one server.
   */
  idleTimeoutMs?: number;
  /**
   * List a server's tools when it connects, so the pool can offer them to a model. On by default.
   *
   * Off is for the other shape of consumer: a gateway proxying `tools/list` straight through from
   * the client that asked, which never reads `tools()`, `catalog()` or `call()`. For that one the
   * drain is pure cost — an extra round trip per page on the first request that spawns a server,
   * a second copy of every tool held for nobody, and one more thing that can fail on a server it
   * could otherwise still have proxied `resources/read` to.
   *
   * Off means the index is empty for ever, so `tools()`, `catalog()` and `state().tools` are
   * empty and `call()` refuses every name. `client()` is unaffected, and so is `probe()` — a
   * probe exists to report what a config offers.
   */
  indexTools?: boolean;
  /**
   * Where each server's tool list is kept between processes, so a lazy pool can offer a server's
   * tools before anything has connected it — see `ToolsCache`.
   *
   * Read when a row is registered without being dialled, and written after a connect or a re-list
   * whose tools differ from what is cached. Within one process nothing needs it: a reaped or
   * stopped server keeps its last-known list either way.
   */
  toolsCache?: ToolsCache;
  /**
   * Answer a repeated call from memory instead of asking the server again. Off unless given;
   * `{}` turns it on with the defaults — see `ResultCacheOptions`.
   *
   * A local model often makes the same read twice in a turn, and each is a round trip and the
   * same tokens of answer. Only for a tool that says repeating it is safe — `readOnlyHint` or
   * `idempotentHint` — on a row that says its annotations are to be believed
   * (`trustAnnotations`), because a cache that swallows a second `send_email` is worse than none.
   *
   * Keyed on the tool and its arguments after coercion, key order aside. Never holds a failure.
   * A server's answers go when its connection closes for any reason, when its tool list changes,
   * and when any call that is not read-only reaches it — what was read before a write is not what
   * would be read after it.
   */
  resultCache?: ResultCacheOptions;
  /**
   * How many estimated tokens of tool definitions `tools()` hands out before it says so in
   * `log.info`. Default 3000; `0` never says anything.
   *
   * A local runtime's default context is a few thousand tokens — Ollama's `num_ctx` is 4096 — and
   * one that is overrun truncates without a word, so thirty real schemas are gone before the
   * system prompt and nothing anywhere reports it. Said once, and again only for a larger set
   * than the last one reported. `CatalogServer.tools[].tokens` is the number per tool, for a
   * consumer that wants to be strict rather than told.
   */
  toolsTokenWarning?: number;
  /**
   * Builds each connection's transport instead of `createTransport`.
   *
   * For a test that wants a server without a child — `memoryTransport` from
   * `@cubicecho/agent-mcp-pool/testing` — or a consumer with a transport the pool does not know.
   * `probe()` uses it too, so a "Test connection" button dials the way the pool does.
   */
  createTransport?: TransportFactory;
}

/**
 * What `tools()` takes: which tools to send, and which servers this run may reach.
 *
 * One object rather than two positional arguments because both are collections of strings, so
 * swapping them is not a type error — and the answer to a swap is an empty array, which is also
 * the correct answer for a run scoped to servers that offer nothing. A consumer adopting the pool
 * transposed them, compiled, connected, and offered its model no tools at all.
 */
export interface ToolsOptions {
  /**
   * Qualified names, in the caller's order. A name asked for twice is sent once; a name nothing
   * offers is skipped and logged. Omitted means every indexed tool — on-demand loading passes a
   * handful rather than every schema.
   */
  names?: string[];
  /**
   * The run's scope. Absent is every server, empty is none — the two must not collapse, since
   * "no servers linked" is a real state.
   */
  servers?: Iterable<string>;
}

/** What `search()` takes besides the query. */
export interface SearchOptions {
  /** The run's scope, read the way `catalog` reads it: absent is every server, empty is none. */
  servers?: Iterable<string>;
  /** The most tools to return, across every server. Default 10. */
  limit?: number;
}

/** What `state()` takes: whether the rows it reports come back with their credentials. */
export interface StateOptions {
  /**
   * Include each row's `env` and `headers`.
   *
   * Off by default, because the documented reason to want the row at all — a UI drawing the edit
   * form beside the connection state — sends what it is given to a browser, and for a real server
   * those two fields are an API key and an `Authorization: Bearer`. An edit form rendered
   * *server-side* is the case that legitimately needs them back: that one asks.
   */
  secrets?: boolean;
}

/** What `describe()` takes beside the name. */
export interface DescribeOptions {
  /** The run's scope, read as `call()` reads it: a tool outside it is not described. */
  servers?: Iterable<string>;
  /** Describe a tool the row hides from the model. The host's own lookups only, as for `call()`. */
  hidden?: boolean;
}

/**
 * How one `call()` is made, beyond its name and arguments.
 *
 * An object since hooks needed more than the scope. The bare scope `call()` took before is still
 * accepted in the same position, so no existing caller changes.
 */
export interface CallOptions {
  /** The run's scope, read as `tools()` reads it. */
  servers?: Iterable<string>;
  /** Cancels the request; the call rejects with the SDK's abort error. */
  signal?: AbortSignal;
  /**
   * Whether to repair and check the arguments against the tool's schema, overriding the row's
   * `coerceArguments` and the pool's. False sends `input` exactly as given.
   */
  coerce?: boolean;
  /**
   * The most characters this call returns, overriding the row's `maxResultChars` and the pool's.
   * `0` is no cap for this call.
   */
  maxResultChars?: number;
  /**
   * Return the server's `CallToolResult` as it came, rather than text.
   *
   * For a consumer that wants the blocks themselves, an image to show or `structuredContent` to
   * read, without giving up the scope check `client()` skips. Scope, hiding, coercion and the
   * timeout still apply; no truncation does, and an `isError` result is returned, not thrown.
   */
  raw?: boolean;
  /**
   * `false` asks the server whatever `resultCache` holds, and stores what it says — a refresh.
   *
   * There is no `true` that means more than the default: what may be cached is decided by the
   * tool's annotations and the row's `trustAnnotations`, and a caller cannot vouch for a tool.
   */
  cache?: boolean;
  /** How long the request gets, overriding the row's `callTimeoutMs` and the pool's. */
  timeoutMs?: number;
  /**
   * Reach a tool the row's `hiddenTools` keeps from the model. For the host's own calls — hooks —
   * never for a name the model sent, which is the whole of what hiding is for.
   */
  hidden?: boolean;
}

/** What `runHooks` takes beyond the event and its context. */
export interface RunHooksOptions {
  /** The run's scope: only these servers' hooks run. Absent is every server, empty is none. */
  servers?: Iterable<string>;
  /**
   * Cancels every hook still running; each resolves promptly as a failed outcome. For the hooks
   * on a turn's path, pass the turn's own signal — a user who stopped the turn stopped its recall.
   */
  signal?: AbortSignal;
  /**
   * Told about each hook that failed or was skipped, as it settles. A hook's failure never fails
   * the turn, so this is the one place it is heard — a host that wants the user to see "recall
   * failed" wires it here.
   */
  onNotice?: (notice: string, outcome: HookOutcome) => void;
}
