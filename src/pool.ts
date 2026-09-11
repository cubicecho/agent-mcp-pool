import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { requestBudget } from "./budget.ts";
import { copyConfig, sameConnection, scope } from "./config.ts";
import { errorMessage, McpPoolError } from "./errors.ts";
import { DEFAULT_HOOK_MAX_TOKENS, expandArgs, INJECT_EVENTS, INJECT_TIMEOUT_MS } from "./hooks.ts";
import { listAllTools } from "./listing.ts";
import { couldQualify, labelOf, type PooledTool, pooledTool, qualify, slugOf } from "./naming.ts";
import { probe as probeConfig } from "./probe.ts";
import { resultText } from "./results.ts";
import { createTransport, readStderrTail } from "./transport.ts";
import type {
  CatalogServer,
  HookContext,
  HookEvent,
  HookOutcome,
  McpConnection,
  McpProbe,
  McpServerConfig,
  McpServerPublicConfig,
  McpServerState,
  McpStatus,
  ToolDefinition,
  ToolHook,
} from "./types.ts";
import { DEFAULT_CLIENT_NAME, POOL_VERSION } from "./version.ts";

/**
 * How long a failed server is left alone before anything dials it again.
 *
 * `syncSoon()` fires on every write to the server table, so without a floor a server that cannot
 * start is respawned once per keystroke in the admin UI.
 */
const CRASH_BACKOFF_MS = 5000;

interface Entry {
  config: McpServerConfig;
  client?: Client;
  status: McpStatus;
  error?: string;
  tools: PooledTool[];
  /**
   * Set while this entry is being torn down on purpose, so `onClose` can tell a shutdown we asked
   * for from a child that died on its own. Without it, `shutdown()` marks every server crashed on
   * the way out.
   */
  closing?: boolean;
  /** When this server last failed to start or dropped its connection. Drives the backoff. */
  failedAt?: number;
  /** The last of what this server's child wrote to stderr; usually why it would not start. */
  stderrTail?: () => string;
  /** Armed on each use when an idle timeout applies; disarmed whenever the client goes away. */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** The stdio child's pid, while there is one. Cleared with the client it describes. */
  pid?: number;
  /** When this connection became ready, as a `Date.now()` stamp. Cleared with the client. */
  startedAt?: number;
}

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

/** Whether a row keeps one of its tools from the model. */
const isHidden = (config: McpServerConfig, name: string) =>
  config.hiddenTools?.includes(name) ?? false;

/** `call()`'s third argument in either of the shapes it accepts. */
function callOptions(options?: Iterable<string> | CallOptions): CallOptions {
  if (options === undefined) return {};
  if (typeof (options as Iterable<string>)[Symbol.iterator] === "function") {
    return { servers: options as Iterable<string> };
  }
  return options as CallOptions;
}

/**
 * `work`, or a rejection when the time or the signal runs out first.
 *
 * The request's own timeout and signal are passed to the SDK as well, which is what stops the
 * server's work; this is what bounds everything before the request — waking a server that is down
 * — which the SDK's timer never sees.
 */
function bounded<T>(work: Promise<T>, ms?: number, signal?: AbortSignal): Promise<T> {
  if (ms === undefined && !signal) return work;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(() => reject(new Error("aborted")));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    if (ms !== undefined) {
      timer = setTimeout(() => finish(() => reject(new Error(`timed out after ${ms}ms`))), ms);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * One MCP client per configured server, exposing their tools to an agent loop as
 * `<slug>__<tool name>`.
 *
 * Connections are long-lived and shared across runs: a stdio server is a child process, and
 * spawning one per run would cost more than the run. `sync()` reconciles the pool against the
 * configured servers, on boot and after every write to them.
 *
 * A class rather than a singleton, so a consumer with two independent sets of servers — or a test
 * that wants a pool it can throw away — need not reach around a module global.
 */
export class McpPool {
  private entries = new Map<string, Entry>();
  /**
   * Qualified name -> the client that answers it. Only ever holds callable tools.
   *
   * `serverId` rides along so a run scoped to a few servers can be held to them by name: a caller
   * narrows what is offered, and `call` refuses the rest, since a model that remembers a tool
   * from a wider run would otherwise still reach it.
   */
  private index = new Map<string, { client: Client; tool: PooledTool; serverId: string }>();

  /** Everything currently subscribed to server→client notifications, across every server. */
  private listeners = new Set<(id: string, notification: Notification) => void>();
  private readonly lazy: boolean;
  private readonly idleTimeoutMs?: number;
  private readonly indexTools: boolean;

  private readonly load?: () => Promise<McpServerConfig[]>;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly log: PoolLog;
  private readonly crashBackoffMs: number;
  private readonly childEnv?: readonly string[];
  private readonly connectTimeoutMs?: number;
  private readonly probeTimeoutMs?: number;
  private readonly callTimeoutMs?: number;

  /**
   * @param options See `McpPoolOptions`. All optional: a pool with no `load` is one driven by
   *   `sync(configs)` instead.
   */
  constructor({
    load,
    clientName = DEFAULT_CLIENT_NAME,
    clientVersion = POOL_VERSION,
    log,
    crashBackoffMs = CRASH_BACKOFF_MS,
    childEnv,
    connectTimeoutMs,
    probeTimeoutMs,
    callTimeoutMs,
    lazy = false,
    idleTimeoutMs,
    indexTools = true,
  }: McpPoolOptions = {}) {
    this.load = load;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.crashBackoffMs = crashBackoffMs;
    this.childEnv = childEnv;
    this.connectTimeoutMs = connectTimeoutMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.callTimeoutMs = callTimeoutMs;
    this.lazy = lazy;
    this.idleTimeoutMs = idleTimeoutMs;
    this.indexTools = indexTools;
    this.log = log ?? {
      info: (message) => console.log(message),
      error: (message) => console.error(message),
    };
  }

  /**
   * Whatever the pool is already doing. Two callers interleaving in a reconcile both spawn a
   * child for the same entry, and the second overwrites the first — whose process is still
   * running with nothing left to close it. Chaining is enough; a sync is never on a hot path.
   */
  private running: Promise<void> = Promise.resolve();
  private pending?: ReturnType<typeof setTimeout>;
  /** A write has landed that the pool has not been reconciled for yet. */
  private owed = false;

  /**
   * Runs `work` after whatever is already queued. See `running`.
   *
   * @param work Runs once the queue reaches it.
   * @returns `work`'s own promise, rejection included — the copy that keeps the chain alive is a
   *   separate one.
   */
  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.running.then(work);
    // The chain has to outlive a failure, or every later reconcile inherits its rejection. The
    // caller still gets the error; this copy only keeps the queue moving.
    this.running = next.catch(() => {});
    return next;
  }

  /**
   * Reconciles the pool against `configs`, or against `options.load` when given nothing.
   *
   * @param configs The servers to reconcile against. Omitted, `load` is asked — and on a pool
   *   built without one, that is a `no-configs` refusal rather than an empty set. Reconciling
   *   against nothing closes every server, and doing it because an argument was left off is the
   *   most destructive thing this API could do by accident. `sync([])` still means exactly that,
   *   from a caller who said so.
   * @returns Resolves when the reconcile this call queued has finished. Rejects with an
   *   `McpPoolError` of code `no-configs` when there is nothing to reconcile against.
   */
  sync(configs?: McpServerConfig[]): Promise<void> {
    return this.queue(() => this.reconcile(configs));
  }

  /**
   * Refuses a reconcile that has nothing to reconcile against, before it closes anything.
   *
   * An omitted `configs` used to fall through to `[]` on a pool with no `load` — the supported
   * shape for a consumer that owns its own rows and always passes them. That is the same code
   * path as a caller who really did drop every row, so every server was closed and forgotten with
   * no log line and no throw, and the next `client(id)` answered `unknown-server` for a row nobody
   * had removed. A `state()` of `[]` looks exactly like a pool that was never synced, which is
   * what made it quiet enough to reach a consumer's test suite as a bug in the consumer.
   *
   * `sync([])` still means "close everything": that is a caller saying so. Only the case where
   * nobody said it is refused.
   *
   * @param configs What the caller passed, `undefined` included — the case this is about.
   */
  private requireConfigs(configs?: McpServerConfig[]) {
    if (configs !== undefined || this.load) return;
    throw new McpPoolError(
      "no-configs",
      "This pool has no load(), so sync() and reconnect() need the configs to reconcile against. Pass [] to close every server.",
    );
  }

  /**
   * Tears one server's connection down and dials it again, changed or not.
   *
   * `sync` leaves an unchanged row alone, so it is no use when a server has wedged. Dropping the
   * entry first leaves the reconcile no choice but to connect it afresh.
   *
   * Unconditional, `lazy` included. A lazy reconcile registers a new entry at `idle` and waits
   * for a use, so without forcing the dial this method was a *stop* on a lazy pool: a caller
   * restarting a wedged server got a stopped one and a `state()` reading `idle`, and found out
   * only on the next call that spawned it. That the meaning of "reconnect" turned on a
   * constructor flag set somewhere else is the half of that which was not defensible. `stop()`
   * is the method for the other reading.
   *
   * @param id The server to drop and redial. An id the pool does not know is not an error; the
   *   reconcile still runs.
   * @param configs Passed on to that reconcile, exactly as `sync` takes it — including the
   *   `no-configs` refusal when it is omitted on a pool with no `load`. This is the easier of the
   *   two to leave off, since `reconnect(id)` reads as complete on its own.
   */
  reconnect(id: string, configs?: McpServerConfig[]): Promise<void> {
    return this.queue(async () => {
      // Before the close, not inside the reconcile: refusing after the entry is already gone
      // would leave the caller with the one server they named torn down as well as the error.
      this.requireConfigs(configs);
      const existing = this.entries.get(id);
      if (existing) {
        await this.close(existing);
        this.entries.delete(id);
      }
      await this.reconcile(configs, id);
    });
  }

  /**
   * Closes one server's connection, leaving the row registered and able to reconnect.
   *
   * The reap path without the clock: the server lands at `idle` with no `error` and no
   * `failedAt`, so no backoff stands between it and the next use — the same situation a timer
   * arrives at, reached by a person instead. `shutdown()` is every server and forgets them,
   * `sync()` only closes what the configs dropped, and neither is what an operator killing one
   * misbehaving child wants.
   *
   * A stopped server stays stopped: `reconcile` leaves an `idle` entry alone whether or not the
   * pool is lazy, so a later `sync()` over an unchanged row will not dial it again. Bringing it
   * back is a use — `call()` or `client()` — or `reconnect()`, which does not wait to be asked.
   *
   * @param id The server to close. An id the pool does not know is not an error: a caller
   *   stopping a child before deleting its row should not have to check first.
   * @returns Resolves once that child is closed, after whatever was already queued.
   */
  stop(id: string): Promise<void> {
    return this.queue(async () => {
      const entry = this.entries.get(id);
      if (!entry) return;
      await this.close(entry);
      // A disabled server is already off, for a reason `idle` would lose. Everything else lands
      // where a reap leaves it, with the failure it may have been stopped over cleared.
      if (entry.status !== "disabled") entry.status = "idle";
      entry.error = undefined;
      entry.failedAt = undefined;
      // Cleared with the connection that listed them, as `onClose` and `reap` do: a stopped
      // server with tools still on it reads as one that could answer a call.
      entry.tools = [];
      this.reindex();
      this.log.info?.(`[mcp] ${slugOf(entry.config)}: stopped`);
    });
  }

  /**
   * Reconciles shortly after a write, rather than during it.
   *
   * A hook inside the mutation's transaction sees the table as it stood before the write it is
   * reacting to. Waiting also folds a batch of edits into one reconnect.
   *
   * For a pool with a `load` to go back to: without one there is no source to re-read, and the
   * debounced sync ends in the same `no-configs` refusal `sync()` gives, logged rather than
   * thrown since nobody is holding its promise.
   */
  syncSoon() {
    this.owed = true;
    clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.settle(), 50);
    // A reconcile the pool has not got to yet is not a reason for the process to stay up, any
    // more than a pending reap is. `flush()` is how a caller that does want to wait for it says so.
    this.pending.unref?.();
  }

  private async settle() {
    // Cleared before the await, so from here on `owed` says a reconcile is *owed*, not that one
    // has finished. `flush` has to ask the queue about the latter.
    this.owed = false;
    await this.sync().catch((error) =>
      this.log.error?.(`[mcp] sync failed: ${errorMessage(error)}`),
    );
  }

  /**
   * Pays off a debounced reconnect now, for a reader who would otherwise see the pool as it stood
   * before their own write — "add a server", then "show me its status", milliseconds apart.
   *
   * The debounce is left standing rather than disarmed: the timer may belong to someone else's
   * write whose transaction has not committed.
   *
   * @returns Resolves once any owed reconcile, and whatever else was queued, have finished. Never
   *   rejects — a failed sync is logged, not thrown here.
   */
  async flush() {
    if (this.owed) await this.settle();
    // A debounce that has already fired is not a debt any more, and `owed` stays false for the
    // whole of the reconcile it started — which is the wait, not the end of it. The queue knows
    // about both, and awaiting it never rejects: `queue` keeps the chain alive past a failure.
    await this.running;
  }

  /**
   * Brings the entry set in line with the configured servers: closes what is gone, connects what
   * is new or changed, and leaves a healthy unchanged server alone.
   *
   * @param configs The wanted set, or `load`'s answer when omitted.
   * @param dial One id to connect even under `lazy`, so `reconnect` really does redial the
   *   server it was named for rather than registering it and leaving it for the next use.
   */
  private async reconcile(configs?: McpServerConfig[], dial?: string) {
    this.requireConfigs(configs);
    const wanted = configs ?? (this.load ? await this.load() : []);
    const keep = new Set(wanted.map((config) => config.id));
    for (const [id, entry] of this.entries) {
      if (!keep.has(id)) {
        await this.close(entry);
        this.entries.delete(id);
      }
    }
    await Promise.all(
      wanted.map(async (config) => {
        const existing = this.entries.get(config.id);
        if (existing && sameConnection(existing.config, config)) {
          // Nothing about how to reach it moved, so the child stays up and a new name is applied
          // in place.
          this.relabel(existing, config);
          // Restarting a healthy server costs a process spawn for nothing. A failed one is what a
          // later sync should pick up — but not faster than the backoff.
          if (existing.status === "ready" || existing.status === "disabled") return;
          // Nothing is wrong with an idle server; not reconnecting it is what lazy is for.
          if (existing.status === "idle") return;
          if (!this.retryDue(existing)) return;
        }
        if (existing) await this.close(existing);
        await this.connect(config, config.id === dial);
      }),
    );
    this.order(wanted);
    this.reindex();
  }

  /**
   * Puts the entries back in the order they were configured in.
   *
   * `reconcile` connects under `Promise.all`, so without this an operator's list reshuffles every
   * boot by whichever child was quickest. Rebuilt rather than sorted: the order is the caller's
   * array, and nothing on a row can reconstruct it.
   *
   * @param wanted The configs in the caller's order. Entries it does not name keep their places.
   */
  private order(wanted: McpServerConfig[]) {
    const ordered = new Map<string, Entry>();
    for (const { id } of wanted) {
      const entry = this.entries.get(id);
      if (entry) ordered.set(id, entry);
    }
    // Anything `wanted` did not name keeps its place: this method decides order, and dropping an
    // entry here would close nothing and leak its child.
    for (const [id, entry] of this.entries) if (!ordered.has(id)) ordered.set(id, entry);
    this.entries = ordered;
  }

  /**
   * Takes a server's new name without touching its connection.
   *
   * `slug` and `label` are baked into every tool's wire name and description at connect time, so
   * once a rename no longer restarts the server the derived half has to be rebuilt here — or the
   * model keeps being offered the old names.
   *
   * @param entry The live entry, mutated in place.
   * @param config Its new row. Only the derived half — names, descriptions, idle clock — is read.
   */
  private relabel(entry: Entry, config: McpServerConfig) {
    const renamed = slugOf(entry.config) !== slugOf(config) || entry.config.label !== config.label;
    const reclocked = entry.config.idleTimeoutMs !== config.idleTimeoutMs;
    entry.config = copyConfig(config);
    // An edited idle timeout is no reason to restart the child, but the armed timer is still
    // running the old one, so re-arm rather than let it fire on a stale duration.
    if (reclocked) this.touch(entry);
    if (!renamed) return;
    entry.tools = entry.tools.map((tool) => pooledTool(config, tool));
  }

  /** Whether a failed server is enabled, down, and has waited out its backoff. */
  private retryDue(entry: Entry) {
    if (!entry.config.enabled || entry.status !== "error") return false;
    return entry.failedAt === undefined || Date.now() - entry.failedAt >= this.crashBackoffMs;
  }

  /**
   * Connects whatever might answer a name the index does not know: the cold servers whose slug
   * could have produced it, and the failed ones that are due another attempt.
   *
   * `couldQualify` decides which those are, and it is exact in the direction that matters: every
   * server that really owns the name is woken. A name none of them could have produced is a name
   * no server has, and starting them to find that out is what a model inventing a tool used to
   * cost — one child process per configured server, dialled one after another, before the call
   * failed anyway. It gates the failed servers too: a crashed one used to be redialled by traffic
   * for any other server's tools, which is the same cost paid on the other path.
   *
   * The run's scope gates both. `call` re-checks the scope *after* this, so without it a run
   * scoped to one server could spawn a child for another by naming its tool — the whole case that
   * check exists for, since a model that has seen a name once will call it again from memory.
   * Refusing after the child is up refuses nothing that matters.
   *
   * Deliberately not a `sync()`: this runs from `call`, where the pool must not go back to `load`
   * for rows — a pool driven by explicit `sync(configs)` has no `load` at all, and asking an
   * absent one would reconcile against an empty set and close every server it has.
   *
   * @param qualifiedName The `<slug>__<tool>` a call asked for and the index could not answer.
   * @param allowed The run's scope, already a set. `undefined` is every server — see `scope`.
   */
  private wake(qualifiedName: string, allowed?: ReadonlySet<string>): Promise<void> {
    return this.queue(async () => {
      // Read inside the queue, like `ensure` does: another caller may have connected these while
      // this one waited, and dialling one twice is the orphaned child the queue exists to prevent.
      const candidates = [...this.entries.values()].filter(
        (entry) =>
          (allowed === undefined || allowed.has(entry.config.id)) &&
          couldQualify(slugOf(entry.config), qualifiedName) &&
          (entry.status === "idle" || this.retryDue(entry)),
      );
      for (const entry of candidates) {
        await this.close(entry);
        await this.connect(entry.config, true);
      }
      if (candidates.length > 0) this.reindex();
    });
  }

  /** Rebuilt whenever the pool changes, so `call` resolves a name without scanning for it. */
  private reindex() {
    this.index.clear();
    for (const entry of this.entries.values()) {
      const { client } = entry;
      if (entry.status !== "ready" || !client) continue;
      for (const tool of entry.tools) {
        this.index.set(tool.qualified, { client, tool, serverId: entry.config.id });
      }
    }
  }

  /**
   * Registers a server as an entry and, unless the pool is lazy, dials it.
   *
   * @param row The row to connect, copied on the way in. A disabled one is registered at
   *   `disabled` and left there.
   * @param force Dial even under `lazy` — what a use does when it needs the child now.
   */
  private async connect(row: McpServerConfig, force = false) {
    // The pool's own copy from here on: an entry holding the caller's object is one the caller
    // can edit under it, and then `sameConnection` compares a row against itself.
    const config = copyConfig(row);
    const status = !config.enabled ? "disabled" : this.lazy && !force ? "idle" : "connecting";
    const entry: Entry = { config, status, tools: [] };
    this.entries.set(config.id, entry);
    // Registered but not dialled: a lazy pool still reconciles the entry set on `sync`, so
    // `state()` is complete and a later use has something to connect. Only the child is deferred.
    if (status !== "connecting") return;

    // Held outside the try so the catch can close it. Between `connect` resolving and
    // `entry.client` being set there is a live child that only this variable names.
    let client: Client | undefined;
    try {
      client = new Client({ name: this.clientName, version: this.clientVersion });
      // Before the connect, and per connection rather than once at construction: a server can
      // send `logging/message` or `tools/list_changed` during its own startup, and a handler
      // installed after `listTools` would have missed it.
      client.fallbackNotificationHandler = async (notification) => {
        this.notify(config.id, notification);
      };
      const transport = createTransport(config, { childEnv: this.childEnv });
      // Listening before the connect, because a server that dies during startup says whatever it
      // has to say then, and the connect only reports that the pipe closed.
      entry.stderrTail = readStderrTail(transport);
      // The row first, the pool's default behind it: connect cost belongs to the server, and a
      // `uvx` package that downloads itself on first run and a local `node` child cannot share one
      // number without the fast one losing its bound. Read here rather than held on the entry, so
      // an edit reaches the next connect without a restart.
      const timeoutMs = config.connectTimeoutMs ?? this.connectTimeoutMs;
      // One budget across the whole connect rather than one per request. The number a consumer
      // picks is what its boot can afford to stall for, and `initialize` plus a `tools/list` per
      // page spends it several times over otherwise — see `requestBudget`.
      const remaining = requestBudget(timeoutMs);
      await client.connect(transport, remaining());
      // Every page: a tool that landed on page two is missing from the index, and `call()` then
      // refuses it as a tool that does not exist. Skipped entirely when nothing is going to read
      // the index — see `indexTools`, where the walk is a round trip per page for nobody.
      const tools = this.indexTools ? await listAllTools(client, remaining()) : [];

      entry.client = client;
      entry.status = "ready";
      // Only reachable from inside this method — the transport is the pool's from here on, and an
      // operator with a wedged child has nothing else to find it in `ps` by.
      entry.pid = "pid" in transport ? (transport.pid ?? undefined) : undefined;
      entry.startedAt = Date.now();
      entry.tools = tools.map((tool) =>
        pooledTool(config, {
          name: tool.name,
          description: tool.description ?? "",
          parameters: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        }),
      );
      // Installed only once the server is up: a child that dies mid-handshake is reported by
      // `connect` rejecting, and `onClose` firing then would race the success path below.
      client.onclose = () => this.onClose(entry);
      // Started here rather than on first use, so a server connected eagerly and never asked for
      // anything is reaped like any other.
      this.touch(entry);
      this.log.info?.(
        this.indexTools
          ? `[mcp] ${slugOf(config)}: ${entry.tools.length} tool(s)`
          : `[mcp] ${slugOf(config)}: connected`,
      );
    } catch (error) {
      // The handshake got far enough to start a child and not far enough to hand it over. Nothing
      // else holds this client, so `close()` and `shutdown()` would never reach the process.
      await client?.close().catch(() => {});
      entry.status = "error";
      // What the child said on the way out: "ModuleNotFoundError: no module named mcp_server_git"
      // beats "MCP error -32000: Connection closed".
      entry.error = entry.stderrTail?.() || errorMessage(error);
      entry.failedAt = Date.now();
      this.log.error?.(`[mcp] ${slugOf(config)}: ${entry.error}`);
    }
  }

  /**
   * A connected server dropped its connection without being asked to.
   *
   * The pool used to have no idea: the entry stayed `ready`, `index` kept handing out its tools,
   * and the failure surfaced as a transport error inside a tool call. Marking it failed is also
   * what lets a later `sync` pick it back up.
   */
  private onClose(entry: Entry) {
    if (entry.closing) return;
    this.disarm(entry);
    this.forget(entry);
    entry.status = "error";
    entry.error = entry.stderrTail?.() || "the server closed the connection";
    entry.failedAt = Date.now();
    // Cleared rather than kept as a last-known list, so `state()` cannot read as a server that is
    // down but still has tools to offer.
    entry.tools = [];
    this.reindex();
    this.log.error?.(`[mcp] ${slugOf(entry.config)}: ${entry.error}`);
  }

  /**
   * Closes a server's client and stops its idle clock, without touching its status.
   *
   * @param entry Marked `closing` first, so the close does not read as a crash to `onClose`.
   */
  private async close(entry: Entry) {
    entry.closing = true;
    this.disarm(entry);
    try {
      await entry.client?.close();
    } catch {
      // a server that died on its own is already closed
    }
    this.forget(entry);
  }

  /**
   * Drops everything that only describes a live connection.
   *
   * The pid and the start time have to go with the client that made them, or `state()` names a
   * process that is gone — and a pid is reused, so a stale one names somebody else's.
   */
  private forget(entry: Entry) {
    entry.client = undefined;
    entry.pid = undefined;
    entry.startedAt = undefined;
  }

  /**
   * Tool definitions for the model. Pass `names` to get only those — on-demand loading sends a
   * handful of schemas instead of every one.
   *
   * `servers` is the run's scope, applied here as well as in `catalog` because a name can also
   * arrive from `load_tools`, where the model rather than the pool chose it.
   *
   * @param options `names` and `servers` — see `ToolsOptions`. Named rather than positional
   *   because the two are the same type and transposing them answers with an empty array.
   */
  tools({ names, servers }: ToolsOptions = {}): ToolDefinition[] {
    const allowed = scope(servers);
    const definitions: ToolDefinition[] = [];
    // A model asking for the same tool twice would otherwise be sent two definitions under one
    // function name, which OpenAI rejects — a bad request rather than a bad answer, and one that
    // reads as the caller's bug. Caller order is kept; the first mention wins.
    const seen = new Set<string>();
    for (const name of names ?? this.index.keys()) {
      const found = this.index.get(name);
      if (!found) {
        // Skipped either way — a name nothing offers is a tool the model is not sent, and its
        // next call says so plainly. Said out loud because the silent version is invisible to the
        // one caller it hurts: a consumer holding names from before a rename watches its agent
        // quietly lose tools, and nothing in this log ever mentioned it.
        if (!this.expected(name)) this.log.info?.(`[mcp] no tool named ${name} is offered`);
        continue;
      }
      if (allowed && !allowed.has(found.serverId)) continue;
      // Skipped silently even when asked for by name: to the model a hidden tool does not exist,
      // and "no tool named …" in the log would read as a rename that never happened.
      const owner = this.entries.get(found.serverId);
      if (owner && isHidden(owner.config, found.tool.name)) continue;
      if (seen.has(found.tool.qualified)) continue;
      seen.add(found.tool.qualified);
      definitions.push(found.tool.definition);
    }
    return definitions;
  }

  /**
   * Whether a name that missed the index might still turn up.
   *
   * A lazy pool's cold server has no tools indexed and `tools()` deliberately does not connect
   * one, so a name that server could own is early rather than missing; same for one still
   * shaking hands. Anything else means no server that is going to answer has this tool.
   *
   * Deliberately not `error`. The pool cannot tell a caller's stale name from a model's invented
   * one, and the second arrives through `load_tools` as a matter of course — a level that says
   * "something is wrong" would be wrong most of the time it fired.
   *
   * @param qualifiedName The name that missed.
   * @returns True while some idle or connecting server could still own it.
   */
  private expected(qualifiedName: string) {
    // Nothing is ever going to turn up: with no indexing, connecting a server puts no tool in the
    // index, so every name misses for good.
    if (!this.indexTools) return false;
    for (const entry of this.entries.values()) {
      if (entry.status !== "idle" && entry.status !== "connecting") continue;
      if (couldQualify(slugOf(entry.config), qualifiedName)) return true;
    }
    return false;
  }

  /**
   * Subscribe to notifications from any connected server. Returns an unsubscribe function.
   *
   * The SDK drops whatever it does not handle, so without this a `tools/list_changed`,
   * `resources/updated` or `logging/message` goes nowhere — and a consumer relaying the protocol
   * onward has no other way to see them. The id comes first because a listener hears from every
   * server at once and the notification does not say which one sent it.
   *
   * A subscription to the pool rather than to a connection, so it outlives both: a server that
   * reconnects keeps delivering to it, and `shutdown()` — which documents that the pool stays
   * usable — leaves it in place, so a consumer that subscribed once at boot is still subscribed
   * after a shutdown and a fresh `sync()`. Unsubscribing is this function's job and nothing
   * else's.
   *
   * @param listener Called with the sending server's id and the notification. Throwing is
   *   contained — the other listeners still run.
   * @returns Unsubscribes. Safe to call more than once.
   */
  onNotification(listener: (id: string, notification: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Hands one notification to every listener.
   *
   * A throwing listener is logged and stepped over rather than allowed to take the others with
   * it: this runs inside the SDK's handler, where a rejection becomes a protocol-level error on a
   * server that did nothing wrong.
   *
   * @param id The server it came from — the notification itself does not say.
   * @param notification Whatever the SDK did not handle.
   */
  private notify(id: string, notification: Notification) {
    for (const listener of this.listeners) {
      try {
        listener(id, notification);
      } catch (error) {
        this.log.error?.(`[mcp] ${id}: notification listener threw: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * The connected client for a server, connecting it if it is idle or merely down.
   *
   * The single door every use goes through, so lazy connect and the idle clock cannot disagree
   * about what counts as a use.
   *
   * @param entry The server wanted.
   * @returns The entry as it stands afterwards, re-read from the map — a reconnect replaces the
   *   object, so this is not always the one passed in.
   */
  private async ensure(entry: Entry): Promise<Entry> {
    if (entry.status === "idle" || this.retryDue(entry)) {
      await this.queue(async () => {
        // Re-read inside the queue: another caller may have connected this server while this one
        // waited, and dialling it twice is the orphaned child the queue exists to prevent.
        const current = this.entries.get(entry.config.id);
        if (!current || (current.status !== "idle" && !this.retryDue(current))) return;
        await this.close(current);
        await this.connect(current.config, true);
        this.reindex();
      });
    }
    const current = this.entries.get(entry.config.id) ?? entry;
    this.touch(current);
    return current;
  }

  /** Restarts this server's idle clock. Called on every use, which is what "idle" measures. */
  private touch(entry: Entry) {
    this.disarm(entry);
    const timeout = entry.config.idleTimeoutMs ?? this.idleTimeoutMs;
    if (!timeout || !entry.client) return;
    // The handle is passed to its own callback so `reap` can tell whether it is still the timer
    // the entry is waiting on — see `reap`. Safe to close over: the callback cannot run before
    // the assignment it reads.
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => this.reap(entry, timer), timeout);
    entry.idleTimer = timer;
    // A pool waiting to reap a server is not a reason for the process to stay up.
    timer.unref?.();
  }

  private disarm(entry: Entry) {
    if (entry.idleTimer === undefined) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  /**
   * Closes a server that has gone unused, leaving it able to come back.
   *
   * Deliberately not the crash path, though the index mutation is the same: no `error`, no
   * `failedAt`, so no backoff stands between this server and the next call that wants it. An
   * operator reading `state()` sees a server that is fine and simply not running.
   *
   * @param entry The server whose clock fired. Ignored if it has been replaced or is not `ready`.
   * @param timer The handle that fired, which is how a use that landed *after* it fired is seen
   *   here. `clearTimeout` on a fired timer does nothing, so a `touch` in the window between the
   *   fire and this queued work reaching the front cannot cancel it — it can only arm a new
   *   handle, which is what this compares against. Without it, a call arriving in that window has
   *   its client closed mid-flight and the model is handed a transport error from a server that
   *   was in use.
   */
  private reap(entry: Entry, timer: ReturnType<typeof setTimeout>) {
    void this.queue(async () => {
      const current = this.entries.get(entry.config.id);
      if (!current || current !== entry || current.idleTimer !== timer) return;
      if (current.status !== "ready") return;
      await this.close(current);
      current.status = "idle";
      current.tools = [];
      this.reindex();
      this.log.info?.(`[mcp] ${slugOf(current.config)}: idle, closed`);
    });
  }

  /**
   * Names and descriptions only — the cheap half, for the on-demand catalogue.
   *
   * A ready server offering no tools is dropped rather than listed empty, or a prompt builder
   * that short-circuits on an empty catalogue spends its preamble introducing a list of nothing.
   * `state()` still reports the server: the operator wants that row.
   *
   * @param servers The run's scope, read the same way `tools` reads it.
   * @returns One entry per ready server that has tools, in configuration order.
   */
  catalog(servers?: Iterable<string>): CatalogServer[] {
    const allowed = scope(servers);
    const out: CatalogServer[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status !== "ready") continue;
      if (allowed && !allowed.has(entry.config.id)) continue;
      // Before the emptiness check, so a server whose every tool is hidden drops out like one
      // that offers none.
      const offered = entry.tools.filter(({ name }) => !isHidden(entry.config, name));
      if (offered.length === 0) continue;
      out.push({
        id: entry.config.id,
        label: labelOf(entry.config),
        tools: offered.map(({ qualified, description }) => ({
          name: qualified,
          description,
        })),
      });
    }
    return out;
  }

  /**
   * The connected MCP client for one server, by config id.
   *
   * Only the last mile of this pool is shaped for an agent loop; a consumer proxying the protocol
   * wants `listResources`, `getPrompt` and the rest that a string was never going to carry. This
   * hands back the client so the connection half can be used on its own. A server that is merely
   * down is retried first, as `call()` does.
   *
   * **This bypasses the scope check `call()` makes, by construction.** That guard is against a
   * model calling a name it remembers; a caller reaching for the client is not driving a model.
   * A disabled server is still refused — it is off, not merely unscoped.
   *
   * @param id The config id, not the slug.
   * @returns The connected client.
   * @throws {McpPoolError} `unknown-server`, `disabled`, `backoff` when a recent failure is still
   *   inside it, or `connect-failed` — the last carrying the child's stderr as `detail`.
   */
  async client(id: string): Promise<Client> {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new McpPoolError("unknown-server", `no MCP server is configured with id "${id}"`, {
        serverId: id,
      });
    }
    const slug = slugOf(entry.config);
    if (!entry.config.enabled) {
      throw new McpPoolError("disabled", `the MCP server "${slug}" is disabled`, { serverId: id });
    }

    // Read before the dial, because afterwards the two are indistinguishable: a connect that
    // failed just now leaves exactly the state a backoff this call refused to break was already
    // in, and a caller in front of an HTTP API answers 502 to one and 503 to the other.
    const dialling = entry.status === "idle" || this.retryDue(entry);
    // The whole lazy path for a consumer that knows which server it wants: a cold entry is
    // dialled here, and a warm one has its idle clock restarted.
    const current = await this.ensure(entry);
    if (!current.client) {
      const message = `the MCP server "${slug}" is not connected${
        current.error ? `: ${current.error}` : ""
      }`;
      const backoff = !dialling && current.status === "error";
      throw new McpPoolError(backoff ? "backoff" : "connect-failed", message, {
        serverId: id,
        detail: current.error,
        retryAt: backoff ? (current.failedAt ?? 0) + this.crashBackoffMs : undefined,
      });
    }
    return current.client;
  }

  /**
   * Runs one tool call and returns text for a tool message.
   *
   * `servers` is checked again here rather than trusted from the definitions the caller was
   * given: a model that has seen a tool name once will call it again from memory, and a run must
   * not reach a server it was not scoped to however it learned the name.
   *
   * @param qualifiedName `<slug>__<tool>`, resolved whole rather than split on `__`.
   * @param input The tool's arguments. Null or undefined is sent as `{}`.
   * @param options `CallOptions`, or the run's scope on its own as before. A tool outside the
   *   scope is refused as one that does not exist, and so is a hidden one unless `hidden` is set.
   * @returns The result as text — see `resultText` for what each kind of content block flattens
   *   to, including a server that answers with `structuredContent` and no blocks at all — or
   *   `"(no output)"` when the server returned nothing whatsoever. A tool that answers with
   *   `isError` throws instead.
   * @throws {McpPoolError} `unknown-tool` (a hidden tool included), or `out-of-scope` for a tool
   *   this run may not reach. All carry the same message, so the model cannot tell them apart.
   */
  async call(
    qualifiedName: string,
    input: unknown,
    options?: Iterable<string> | CallOptions,
  ): Promise<string> {
    const { servers, signal, timeoutMs: ownTimeoutMs, hidden = false } = callOptions(options);
    const allowed = scope(servers);
    // Resolved by the whole qualified name rather than by splitting it: `qualify` shortens names
    // past 64 characters, and the split of a shortened name is a tool its server never had.
    let found = this.index.get(qualifiedName);
    // Waking a server can only help if connecting one would index something, so a pool that does
    // not index refuses here rather than spawning children that cannot answer either.
    if (!found && this.indexTools) {
      // A crashed server took its tools out of the index, and a lazy pool never put a cold
      // server's there at all. Telling the model a tool does not exist teaches it to stop asking,
      // so bring back whatever is owed a connection and look once more — inside the scope, since
      // the check below refuses a server this run may not reach and spawning it first refuses
      // nothing.
      await this.wake(qualifiedName, allowed);
      found = this.index.get(qualifiedName);
    }
    // A tool outside this run's scope is answered as one that does not exist, because to this run
    // it does not: "that server is not yours" would teach the model to ask again.
    const outOfScope = found !== undefined && allowed !== undefined && !allowed.has(found.serverId);
    const entry = found && this.entries.get(found.serverId);
    // A hidden tool is one the model was never offered, so a call to it is answered the way a
    // call to a tool that does not exist is — the model is not to learn it is there.
    const concealed =
      !hidden &&
      found !== undefined &&
      entry !== undefined &&
      isHidden(entry.config, found.tool.name);
    if (!found || outOfScope || concealed) {
      // One message for all of them, so a run cannot learn that a server it was not scoped to
      // exists. The code separates them for a caller that wants the refusals in its own log.
      throw new McpPoolError(
        outOfScope ? "out-of-scope" : "unknown-tool",
        `no connected MCP server offers a tool called "${qualifiedName}"`,
        { toolName: qualifiedName, serverId: found?.serverId },
      );
    }

    if (entry) this.touch(entry);

    // This call's own first — a hook's 3s on the path of a turn — then the row, then the pool's
    // default, then the SDK's own 60s behind that: the same order `connectTimeoutMs` is read in,
    // and read here rather than held on the entry for the same reason: an edited number applies to
    // the next call without bouncing the child. One request, so a plain timeout rather than a
    // `requestBudget`; budgets are for sequences.
    const timeoutMs = ownTimeoutMs ?? entry?.config.callTimeoutMs ?? this.callTimeoutMs;
    const result = await found.client.callTool(
      {
        name: found.tool.name,
        arguments: (input ?? {}) as Record<string, unknown>,
      },
      undefined,
      // Built only when there is something to say: a `timeout: undefined` handed to the SDK is
      // not the same as none, depending on how it reads the field. Deliberately without
      // `resetTimeoutOnProgress`: a long call that reports progress is still cut off at this
      // number. The alternative is a bound a server can hold open indefinitely by talking, which
      // is not a bound. A consumer that wants the other reading has `client()`.
      signal || timeoutMs != null
        ? {
            ...(signal ? { signal } : {}),
            ...(timeoutMs != null ? { timeout: timeoutMs } : {}),
          }
        : undefined,
    );

    const text = resultText(result);
    // The server ran the tool and the tool failed — not one of the pool's refusals, which is why
    // this was a plain `Error`. It carries a code anyway because a caller sorting failures cares
    // most about this line: nothing about retrying a rejected argument resembles retrying a
    // backoff. The message is what it always was.
    if (result.isError) {
      throw new McpPoolError("tool-error", text || "tool call failed", {
        toolName: qualifiedName,
        serverId: found.serverId,
      });
    }
    return text || "(no output)";
  }

  /**
   * Runs every hook bound to `event`, and hands back what each one did.
   *
   * Hooks come from the rows: each enabled server inside the scope contributes its enabled hooks
   * for this event, in configuration order. They run at once rather than in turn — they are
   * independent by construction, and on `beforeTurn` the user is waiting on the slowest of them.
   *
   * **Never rejects.** A hook is an addition to a session, never a condition of it: a memory
   * server that is down must cost a turn its recall, not the turn. A failed call, a timeout, an
   * abort and a placeholder with no value each come back as an outcome with `ok: false` and are
   * told to `onNotice`.
   *
   * Hooks may call tools the row hides from the model — that is most of what hiding is for.
   *
   * @param event Which point in the session this is.
   * @param context What the event carries, for the hooks' templates. `now` is filled in if absent.
   * @param options Scope, signal and the failure listener — see `RunHooksOptions`.
   * @returns One outcome per hook that was considered, in configuration order. Pair it with
   *   `contextBlocks` to get what the injecting ones returned into a request.
   */
  async runHooks(
    event: HookEvent,
    context: HookContext,
    options: RunHooksOptions = {},
  ): Promise<HookOutcome[]> {
    const allowed = scope(options.servers);
    const full: HookContext = { ...context, now: context.now ?? new Date().toISOString() };
    const running: Promise<HookOutcome>[] = [];
    for (const entry of this.entries.values()) {
      const row = entry.config;
      if (!row.enabled || (allowed && !allowed.has(row.id))) continue;
      for (const hook of row.hooks ?? []) {
        if (hook.on !== event || hook.enabled === false) continue;
        running.push(this.runHook(row, hook, full, options));
      }
    }
    return Promise.all(running);
  }

  /** One hook, start to outcome. Resolves on every path; `runHooks` relies on that. */
  private async runHook(
    row: McpServerConfig,
    hook: ToolHook,
    context: HookContext,
    { servers, signal, onNotice }: RunHooksOptions,
  ): Promise<HookOutcome> {
    const started = Date.now();
    const base = {
      serverId: row.id,
      label: labelOf(row),
      hookId: hook.id,
      event: hook.on,
      // Held to the events that can use it here as well as in `validateHooks`, since a row need
      // not have been through that: an `afterTurn` hook marked inject would otherwise be handed
      // to `contextBlocks` as though it had run in time.
      inject: Boolean(hook.inject) && INJECT_EVENTS.has(hook.on),
      maxTokens: hook.maxTokens ?? DEFAULT_HOOK_MAX_TOKENS,
    };
    const settle = (result: Pick<HookOutcome, "ok" | "text" | "error" | "skipped">) => {
      const outcome: HookOutcome = { ...base, ...result, ms: Date.now() - started };
      if (!outcome.ok) {
        const notice = `${base.label}: ${hook.on} hook "${hook.id}" ${
          outcome.skipped ? "skipped" : "failed"
        }: ${outcome.error}`;
        this.log.info?.(`[mcp] ${notice}`);
        onNotice?.(notice, outcome);
      }
      return outcome;
    };

    if (signal?.aborted)
      return settle({ ok: false, skipped: true, error: "aborted before it ran" });
    const { args, missing } = expandArgs(hook.args, context);
    if (missing.length > 0) {
      const paths = missing.map((path) => `{{${path}}}`).join(", ");
      return settle({ ok: false, skipped: true, error: `no value for ${paths}` });
    }

    // By the event rather than by `inject`: a `beforeTurn` hook that injects nothing still holds
    // up the turn it runs in front of.
    const timeoutMs =
      hook.timeoutMs ?? (INJECT_EVENTS.has(hook.on) ? INJECT_TIMEOUT_MS : undefined);
    try {
      const text = await bounded(
        this.call(qualify(slugOf(row), hook.tool), args, {
          servers,
          signal,
          timeoutMs,
          hidden: true,
        }),
        timeoutMs,
        signal,
      );
      // The pool's own placeholder for an empty result is for a model, which must be told
      // something; for a hook it is nothing to inject.
      return settle({ ok: true, text: text === "(no output)" ? undefined : text });
    } catch (error) {
      return settle({ ok: false, error: errorMessage(error) });
    }
  }

  /**
   * Tests a config that may not be saved yet, introducing itself the way this pool does.
   *
   * The free `probe` takes the client name and environment policy as arguments, so every "Test
   * connection" button wrote the same wrapper to bind them — and one that bound them differently
   * showed up only in a remote server's logs. `probe` stays exported for a caller with no pool.
   *
   * The patience is bound the same way: the row's own `connectTimeoutMs` if it has one, then
   * `probeTimeoutMs`, then the pool's `connectTimeoutMs`. A pool told to give up on a wedged
   * server in five seconds should not sit on the SDK's sixty for the same server behind a button,
   * and a row that says it needs two minutes to start should not be failed at five. So is the
   * version, for the same reason the name is: the two halves of `clientInfo` travel together.
   *
   * @param config The server to test. Nothing is stored and no entry is touched, so this is safe
   *   against a row that does not exist yet.
   */
  probe(config: McpConnection): Promise<McpProbe> {
    return probeConfig(
      config,
      { name: this.clientName, version: this.clientVersion },
      {
        childEnv: this.childEnv,
        // The row outranks both pool-wide numbers, `probeTimeoutMs` included: a server whose own
        // row says it needs two minutes to start needs them behind the button too, and a probe
        // that gives it five seconds reports a failure for a server that works.
        timeoutMs: config.connectTimeoutMs ?? this.probeTimeoutMs ?? this.connectTimeoutMs,
      },
    );
  }

  /**
   * Every configured server, in the order it was configured, with the row it came from.
   *
   * The row is handed back rather than projected away: a consumer drawing an edit form beside a
   * connection status would otherwise keep its own copy, and that copy is the one that goes stale.
   * Its credentials are not: `env` and `headers` are left out unless `secrets` asks for them,
   * because the shortest way to draw that line is to send this straight to a browser.
   *
   * @param options `secrets: true` puts each row's `env` and `headers` back — see `StateOptions`.
   * @returns One row per configured server, in configuration order — not in the order they
   *   happened to connect. Each `config` is a copy, so editing one cannot reach the pool.
   */
  state({ secrets = false }: StateOptions = {}): McpServerState[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.config.id,
      slug: slugOf(entry.config),
      label: labelOf(entry.config),
      config: this.reportedConfig(entry.config, secrets),
      status: entry.status,
      error: entry.error ?? "",
      tools: entry.tools.map(({ name, qualified, description }) => ({
        name,
        qualified,
        description,
        hidden: isHidden(entry.config, name),
      })),
      pid: entry.pid,
      startedAt:
        entry.startedAt === undefined ? undefined : new Date(entry.startedAt).toISOString(),
      // Read off the client rather than held on the entry: both are cached reads of the handshake
      // the SDK already made, and the client is what `forget()` clears — so they are absent while
      // the server is down for the same reason `pid` is, without a second thing to remember to
      // clear. Not gated on `indexTools`: these cost no round trip, and the consumer that turned
      // indexing off is the one proxying the protocol.
      instructions: entry.client?.getInstructions(),
      capabilities: entry.client?.getServerCapabilities(),
    }));
  }

  /**
   * A row as it goes out of `state()`: a copy, and without the credentials unless asked for.
   *
   * A copy because the pool's record of what it dialled is not the caller's to edit, and without
   * `env`/`headers` because the documented use for the row — a UI drawing the edit form beside
   * the connection state — is a browser, and those two fields are an API key and a bearer token.
   *
   * @param config The entry's own row.
   * @param secrets Whether the caller asked for the credentials back.
   */
  private reportedConfig(config: McpServerConfig, secrets: boolean): McpServerPublicConfig {
    const copy = copyConfig(config);
    if (secrets) return copy;
    // One credential field per arm, stripped by arm: a row carries only its own transport's
    // fields now, so there is no single destructure that names both.
    if (copy.transport === "stdio") {
      const { env, ...rest } = copy;
      return rest;
    }
    const { headers, ...rest } = copy;
    return rest;
  }

  /**
   * Closes every server and forgets them, after whatever is already queued.
   *
   * @returns Resolves once every child is closed. The pool stays usable: a later `sync()` builds
   *   it again from nothing.
   */
  async shutdown() {
    clearTimeout(this.pending);
    this.owed = false;
    // Queued like a sync, so a reconnect already under way finishes before its children are
    // closed — otherwise shutdown closes entries the sync is in the middle of replacing.
    await this.queue(async () => {
      await Promise.all([...this.entries.values()].map((entry) => this.close(entry)));
      this.entries.clear();
      this.index.clear();
    });
  }
}
