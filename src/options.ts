import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ElicitRequestParams,
  ElicitResult,
  LoggingLevel,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResultCacheOptions } from "./result-cache.ts";
import type { TransportFactory } from "./transport.ts";
import type { HookOutcome, McpServerConfig, ServerLogEntry, ToolsCache } from "./types.ts";

/**
 * What a pool and its methods are told: the constructor's options and each call's.
 *
 * Apart from `pool.ts` so that what runs on the pool's behalf — the hook runner — can be typed
 * against these without importing the class that imports it.
 */

/**
 * Answers one `elicitation/create`: `McpPoolOptions.onElicit` for the pool, `CallOptions.onElicit`
 * for one call.
 *
 * @param serverId The config id of the server asking.
 * @param params The request: `message`, and `requestedSchema` for a form or `url` for a link.
 * @param extra `signal` aborts when the server gives up on the request — and, for a call's own
 *   handler, when that call settles, its timeout and its signal included.
 * @returns The user's answer.
 */
export type ElicitHandler = (
  serverId: string,
  params: ElicitRequestParams,
  extra: { signal: AbortSignal },
) => ElicitResult | Promise<ElicitResult>;

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
   * The level every server that declares `logging` is set to on connect. Unset sends nothing,
   * leaving each server its own default. `McpServerConfig.logLevel` overrides it for one server.
   */
  logLevel?: LoggingLevel;
  /**
   * The most of a server's log messages one call's `onLog` hears. Defaults to 50.
   *
   * A server set to `debug` can say hundreds of things during one call, and each one a host turns
   * into a run event is a row someone has to scroll past to find the warning. Past the cap the
   * call hears one summary when it settles — how many, and the worst level among them — and the
   * messages themselves go to `onNotification` as though nobody had asked.
   */
  maxLogsPerCall?: number;
  /**
   * Answers a server that asks the user for input mid-call, where no call answers it itself:
   * MCP's `elicitation/create`.
   *
   * Present, every connection declares the capability, and a request lands here with the id of
   * the server that sent it — unless `CallOptions.onElicit` claims it first. Resolve with `accept`
   * and the `content`, or `decline` or `cancel`. A listener that throws is logged and answered
   * `cancel`, so a broken prompt does not fail the server's tool with a protocol error. With
   * neither this nor `elicitation`, nothing is declared, so a well-behaved server does not ask and
   * one that asks anyway is refused by the SDK.
   *
   * A person answering takes time, and the call that caused the request is still on its clock:
   * set `callTimeoutMs` for that server with the wait in mind.
   */
  onElicit?: ElicitHandler;
  /**
   * Declare the elicitation capability even with no pool-wide `onElicit`, for a host that answers
   * only per call, through `CallOptions.onElicit`.
   *
   * A request no call can be named for is then answered `decline`. Absent or `false`, the
   * capability is declared exactly when `onElicit` is set.
   */
  elicitation?: boolean;
  /**
   * Which elicitation modes the handlers can answer, pool-wide and per call. Defaults to
   * `["form"]`.
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
   * List a connected server's tools again once its list is older than this, on the next
   * `tools()`, `catalog()`, `search()` or `call()` that touches it. 15 minutes unless set; `0` is
   * never. `McpServerConfig.refreshMs` overrides it for one server.
   *
   * For a server that never sends `tools/list_changed`, whose tool added on upgrade is otherwise
   * invisible until a restart and whose removed one is offered until a call to it fails. Run on
   * use rather than on a timer, so a reaped or idle server is never woken to be asked, and in the
   * background, so the use that noticed is not held up. A list that comes back the same moves
   * nothing — no reindex, no save, no event — so a host's prompt cache holds.
   */
  refreshMs?: number;
  /**
   * Send a `ping` before a request on a connection that has heard nothing from its server for
   * this long, and redial where it goes unanswered. 5 minutes unless set; `0` is never.
   * `McpServerConfig.pingAfterMs` overrides it for one server.
   *
   * For a connection that has died without closing — an http session a proxy dropped, a stdio
   * child wedged but not exited — which would otherwise cost the next call its whole timeout and
   * a "timed out" for a server a redial brings straight back. On by default because it is cheap
   * where it is not needed: one round trip, only after a quiet stretch, and never while anything
   * is in flight on the connection, since a server busy answering is not a quiet one. Anything
   * the server answers counts as alive, an error included; only silence, or a closed pipe, fails.
   */
  pingAfterMs?: number;
  /** How long a liveness `ping` waits for its answer. 5 seconds unless set. */
  pingTimeoutMs?: number;
  /**
   * Replace a connection older than this, at the first moment nothing is in flight on it. Off
   * unless set. `McpServerConfig.maxConnectionAgeMs` overrides it for one server.
   *
   * For a stdio child that leaks memory over days, and an http session a gateway expires on a
   * clock of its own. Checked as a request is about to go out and as the last one in flight
   * settles, so a call is never cut off for it: one arriving at an old, quiet connection is sent
   * on the new one, and one arriving while others run goes out on the old one, which is replaced
   * once they are done.
   */
  maxConnectionAgeMs?: number;
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

/** What `prompts()` and `resources()` take. */
export interface ListingOptions {
  /**
   * The run's or caller's scope, read the way `tools` reads it: absent is every server, empty is
   * none.
   */
  servers?: Iterable<string>;
}

/** What a request addressed to one server's prompts or resources takes besides its arguments. */
export interface ServerRequestOptions {
  /**
   * The scope to hold the request to. A server outside it is refused as one that is not
   * configured, as `call()` refuses a tool outside it — a model handed a resource tool must not
   * learn that a server it was not given exists. Absent is every server.
   */
  servers?: Iterable<string>;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** What `readResource()` takes besides the uri. */
export interface ReadResourceOptions extends ServerRequestOptions {
  /**
   * The most characters of text to hand back, cut by `truncateText`. Absent, zero or negative is
   * no cap. Applied to what is returned, not to what the server sends: `resources/read` has no
   * way to ask for less.
   */
  maxChars?: number;
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

/** What `toolSafety()` and `readsOnly()` take beside the name. */
export interface SafetyOptions {
  /** The run's scope, read as `call()` reads it: a tool outside it is assumed the worst of. */
  servers?: Iterable<string>;
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
   * Answer with a `ToolAnswer` — `{ text, links }` — rather than text alone.
   *
   * `text` is what `call()` returns without this, under every rule that applies to it: the cap,
   * `"(no output)"`, the result cache. `links` is the result's `resource_link` blocks, for the host
   * to keep — what a run made — and not for the model, which already has their uris in `text`. An
   * `isError` result throws as it does without this: a call that failed made nothing. `raw`
   * outranks it, since the raw result carries the links already.
   */
  links?: boolean;
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
   * Answers the elicitations this call causes, ahead of `McpPoolOptions.onElicit`. The pool must
   * declare the capability for a server to ask at all: set `onElicit` or `elicitation` on it.
   *
   * Attributed by elimination, as `onLog` is: SDK 1.30 tells a client's request handler nothing
   * of which request a server→client request belongs to, so an elicitation is this call's when
   * this call is the only request the pool has in flight on that connection. With two in flight
   * it goes to the pool-wide handler, and with none of those it is declined. Under the
   * 2026-07-28 revision's multi round-trip requests the question comes back on the call itself;
   * the SDK speaks 2025-11-25 at newest, so that route is not taken yet.
   *
   * The call's timeout keeps running while a person answers; pass a longer `timeoutMs` for a
   * call that may wait on one. When the call settles first — the timeout, its `signal`, or the
   * server answering without waiting — the handler's signal aborts and the server is answered
   * `cancel`, whatever the handler later resolves with. A handler that throws is logged and
   * answered `cancel`.
   */
  onElicit?: ElicitHandler;
  /**
   * Hears what the server logs while this call is running: its `notifications/message`, at the
   * level the row's `logLevel` set.
   *
   * Attributed by elimination, not by id. The SDK hands a client's notification handler the
   * notification alone, and its transports drop which response stream carried it, so nothing
   * says which request a message belongs to; a message is this call's when this call is the
   * only request the pool has in flight on that connection. With two in flight — another call,
   * a hook, a `use()` — neither hears it, and it goes to `onNotification` as before. What the
   * server logs about something else while this is its only call is heard here too. Capped at
   * `McpPoolOptions.maxLogsPerCall`, with one summary entry for what the cap dropped; a message
   * relayed here is not also handed to `onNotification`. A listener that throws is logged.
   */
  onLog?: (entry: ServerLogEntry) => void;
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

/**
 * What `hookRunner` binds for the life of the runner: everything `runHooks` takes but the signal,
 * which belongs to each call.
 */
export type HookRunnerOptions = Omit<RunHooksOptions, "signal">;
