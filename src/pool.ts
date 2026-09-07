import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import type OpenAI from "openai";
import { errorMessage } from "./errors.ts";
import { probe as probeConfig } from "./probe.ts";
import { createTransport, readStderrTail } from "./transport.ts";
import type {
  CatalogServer,
  McpConnection,
  McpProbe,
  McpServerConfig,
  McpServerState,
  McpStatus,
} from "./types.ts";

const SEPARATOR = "__";

/** OpenAI rejects a function name longer than this, so every qualified name has to fit. */
const NAME_LIMIT = 64;

/**
 * Hex characters of the disambiguating hash on a truncated name.
 *
 * Six is 24 bits: enough that a collision needs thousands of over-long names on one pool, short
 * enough that the readable prefix survives. It buys uniqueness with room a name that long has
 * already spent.
 */
const HASH_LENGTH = 6;

/**
 * How long a server that failed is left alone before anything dials it again.
 *
 * `syncSoon()` fires on every write to the server table, so without a floor a server that cannot
 * start is respawned once per keystroke in the admin UI.
 */
const CRASH_BACKOFF_MS = 5000;

/**
 * One tool of one connected server, in every shape anything asks for it.
 *
 * The OpenAI definition is built once here rather than per request: the agent loop rebuilds its
 * tool array on every iteration of every step, and the schema behind it cannot change without
 * the connection being torn down and made again.
 */
interface PooledTool {
  /** As the server named it — what `state()` reports and what a call is sent back under. */
  name: string;
  description: string;
  /**
   * The server's own JSON Schema for its arguments.
   *
   * Kept alongside the built definition so a rename can rebuild the model-facing half without
   * reconnecting to ask for the schemas again.
   */
  parameters: Record<string, unknown>;
  /** `<slug>__<name>`: what the model sees, and what it calls. */
  qualified: string;
  definition: OpenAI.ChatCompletionTool;
}

interface Entry {
  config: McpServerConfig;
  client?: Client;
  status: McpStatus;
  error?: string;
  tools: PooledTool[];
  /**
   * Set while this entry is being torn down on purpose, so `onClose` can tell a shutdown we
   * asked for from a child that died on its own. Without it, `shutdown()` marks every server
   * crashed on the way out.
   */
  closing?: boolean;
  /** When this server last failed to start or dropped its connection. Drives the backoff. */
  failedAt?: number;
  /** The last of what this server's child wrote to stderr; usually why it would not start. */
  stderrTail?: () => string;
  /** Armed on each use when an idle timeout applies; disarmed whenever the client goes away. */
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface McpPoolOptions {
  /**
   * Where the configured servers come from when `sync()` is called with nothing.
   *
   * This is the seam that used to be an `import { db }`. The pool has no opinion about where
   * rows live — a Drizzle select, a parsed config file, a constant array in a test — it only
   * needs to be able to ask again after a write.
   */
  load?: () => Promise<McpServerConfig[]>;
  /** How this process introduces itself to the servers it connects to. */
  clientName?: string;
  /** Where the pool's own progress goes. Defaults to the console; pass `{}` to silence it. */
  log?: { info?: (message: string) => void; error?: (message: string) => void };
  /** How long a failed server is left alone before it is dialled again. Defaults to 5s. */
  crashBackoffMs?: number;
  /**
   * Which of this process's environment variables a stdio child inherits. Defaults to all of
   * them; `MINIMAL_CHILD_ENV` is a sensible allowlist to narrow to.
   */
  childEnv?: readonly string[];
  /**
   * How long to wait for a server to answer `initialize` and `tools/list`.
   *
   * The SDK already applies its own 60s default, so this is not about an unbounded hang — it is
   * about how long a boot is willing to stall. `sync` connects servers in parallel, but one
   * wedged server still holds the whole reconcile open for the full timeout, and a minute is a
   * long time to keep an agent from starting over a server that is not coming back.
   */
  connectTimeoutMs?: number;
  /**
   * Register servers without connecting them; connect on first use instead.
   *
   * Off by default, because the eager default is right for an agent loop: spawning a child per
   * run costs more than the run. A gateway has the opposite pressure — dozens of installed
   * servers, most idle most of the time — and holding every child resident for the one that is
   * actually being used is the wrong trade.
   *
   * A registered but unconnected server sits at `idle`. `call()` and `client()` connect it;
   * `tools()` and `catalog()` do not, and so report nothing for it until something has. That
   * limitation is real and known: listing a cold server's tools without spawning it needs a
   * cached last-known tool list, which is its own change.
   */
  lazy?: boolean;
  /**
   * Close a connected server after this long without a call, leaving it able to reconnect.
   *
   * Absent means never, which is today's behaviour. Reset on every use. A reap is a success
   * path, not a crash: the server returns to `idle` rather than `error`, no backoff applies,
   * and the next use reconnects immediately. `McpServerConfig.idleTimeoutMs` overrides it for
   * one server.
   */
  idleTimeoutMs?: number;
}

/**
 * One MCP client per configured server, exposing their tools to an agent loop as
 * `<slug>__<tool name>`.
 *
 * Connections are long-lived and shared across runs: a stdio server is a child process, and
 * spawning one per run would cost more than the run. `sync()` reconciles the pool against the
 * configured servers and is called on boot and after every write to them.
 *
 * A class rather than a singleton, because a consumer with two independent sets of servers —
 * or a test that wants a pool it can throw away — should not have to reach around a module
 * global to get one. Consumers that want the singleton still make one and export it.
 */
export class McpPool {
  private entries = new Map<string, Entry>();
  /**
   * Qualified name -> the client that answers it. Only ever holds callable tools.
   *
   * `serverId` rides along so a run scoped to a few servers can be held to them by name: a
   * caller narrows what is *offered*, and `call` refuses the rest, since a model that
   * remembers a tool from a wider run would otherwise still reach it.
   */
  private index = new Map<string, { client: Client; tool: PooledTool; serverId: string }>();

  /** Everything currently subscribed to server→client notifications, across every server. */
  private listeners = new Set<(id: string, notification: Notification) => void>();
  private readonly lazy: boolean;
  private readonly idleTimeoutMs?: number;

  private readonly load?: () => Promise<McpServerConfig[]>;
  private readonly clientName: string;
  private readonly log: NonNullable<McpPoolOptions["log"]>;
  private readonly crashBackoffMs: number;
  private readonly childEnv?: readonly string[];
  private readonly connectTimeoutMs?: number;

  constructor({
    load,
    clientName = "agent-mcp-pool",
    log,
    crashBackoffMs = CRASH_BACKOFF_MS,
    childEnv,
    connectTimeoutMs,
    lazy = false,
    idleTimeoutMs,
  }: McpPoolOptions = {}) {
    this.load = load;
    this.clientName = clientName;
    this.crashBackoffMs = crashBackoffMs;
    this.childEnv = childEnv;
    this.connectTimeoutMs = connectTimeoutMs;
    this.lazy = lazy;
    this.idleTimeoutMs = idleTimeoutMs;
    this.log = log ?? {
      info: (message) => console.log(message),
      error: (message) => console.error(message),
    };
  }

  /**
   * Whatever the pool is already doing. Reconciling is a sequence of awaits over a map, and two
   * callers interleaving in it both see the same unchanged entry, both spawn a child for it, and
   * the second overwrites the first — whose process is still running with nothing left holding a
   * handle to close it. Chaining is enough: a sync is rare and never on a run's hot path.
   */
  private running: Promise<void> = Promise.resolve();
  private pending?: ReturnType<typeof setTimeout>;
  /** A write has landed that the pool has not been reconciled for yet. */
  private owed = false;

  /** Runs `work` after whatever is already queued. See `running`. */
  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.running.then(work);
    // The chain has to outlive a failure, or every later reconcile inherits its rejection. The
    // caller still gets the error; this copy exists only to keep the queue moving.
    this.running = next.catch(() => {});
    return next;
  }

  /** Reconciles the pool against `configs`, or against `options.load` when given nothing. */
  sync(configs?: McpServerConfig[]): Promise<void> {
    return this.queue(() => this.reconcile(configs));
  }

  /**
   * Tears one server's connection down and dials it again, changed or not.
   *
   * `sync` deliberately leaves an unchanged server alone, so it cannot be what an operator
   * presses when a server has wedged or its own backend went away — from the outside the row
   * is identical and nothing happens. This drops the entry first, so the reconcile that
   * follows has no choice but to connect it afresh.
   */
  reconnect(id: string, configs?: McpServerConfig[]): Promise<void> {
    return this.queue(async () => {
      const existing = this.entries.get(id);
      if (existing) {
        await this.close(existing);
        this.entries.delete(id);
      }
      await this.reconcile(configs);
    });
  }

  /**
   * Reconciles shortly after a write, rather than during it.
   *
   * A write hook that runs inside the mutation's transaction sees the table as it stood before
   * the write being reacted to. Waiting past the commit also folds a batch of edits into one
   * reconnect, which for a stdio server is a child process not spawned twice.
   */
  syncSoon() {
    this.owed = true;
    clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.settle(), 50);
  }

  private async settle() {
    this.owed = false;
    await this.sync().catch((error) =>
      this.log.error?.(`[mcp] sync failed: ${errorMessage(error)}`),
    );
  }

  /**
   * Pays off a debounced reconnect now, for a reader that would otherwise be shown the pool as
   * it stood before its own write.
   *
   * "Add a server" then "show me its status" is how an operator confirms that a server they
   * just added actually connected, and those two calls arrive milliseconds apart. The debounce
   * is left standing rather than disarmed: the timer may belong to someone else's write whose
   * transaction has not committed yet.
   */
  async flush() {
    if (this.owed) await this.settle();
  }

  private async reconcile(configs?: McpServerConfig[]) {
    const wanted = configs ?? (this.load ? await this.load() : []);
    for (const [id, entry] of this.entries) {
      if (!wanted.some((config) => config.id === id)) {
        await this.close(entry);
        this.entries.delete(id);
      }
    }
    await Promise.all(
      wanted.map(async (config) => {
        const existing = this.entries.get(config.id);
        if (existing && McpPool.sameConnection(existing.config, config)) {
          // Nothing about how to reach it moved, so the child stays up; a new name for it is
          // applied in place.
          this.relabel(existing, config);
          // Restarting a healthy server would cost a process spawn for nothing. A failed one is
          // exactly what a later sync should pick up — but not faster than the backoff.
          if (existing.status === "ready" || existing.status === "disabled") return;
          // Nothing is wrong with an idle server; reconnecting it is exactly what lazy is for
          // not doing. It waits for a use like any other.
          if (existing.status === "idle") return;
          if (!this.retryDue(existing)) return;
        }
        if (existing) await this.close(existing);
        await this.connect(config);
      }),
    );
    this.order(wanted);
    this.reindex();
  }

  /**
   * Puts the entries back in the order they were configured in.
   *
   * `connect` inserts each entry as it reaches it, and `reconcile` runs those under
   * `Promise.all` — so `entries` ends up in whichever order the servers finished connecting in,
   * and an operator's list reshuffles itself every boot according to which child was quickest.
   * `reconnect` does the same to one row, sending it to the bottom.
   *
   * Rebuilt rather than sorted, because the order is the caller's array and nothing derived from
   * a row can reconstruct it. Everything that iterates `entries` — `state`, `catalog`, `reindex`
   * and so `tools` — inherits it.
   */
  private order(wanted: McpServerConfig[]) {
    const ordered = new Map<string, Entry>();
    for (const { id } of wanted) {
      const entry = this.entries.get(id);
      if (entry) ordered.set(id, entry);
    }
    // Anything `wanted` did not name keeps its place rather than being dropped: this method
    // decides order, and losing an entry here would close nothing and leak its child.
    for (const [id, entry] of this.entries) if (!ordered.has(id)) ordered.set(id, entry);
    this.entries = ordered;
  }

  /**
   * Whether two rows describe the same live connection.
   *
   * Only the fields a child process is actually made of. This used to be a `JSON.stringify`
   * comparison of the whole row, which bounced a running server — dropping whatever state it
   * held — because someone corrected a typo in its label. `null` and empty are the same absence
   * here: a row moving between them has not changed how the server is reached.
   */
  private static sameConnection(a: McpServerConfig, b: McpServerConfig) {
    return (
      a.enabled === b.enabled &&
      a.transport === b.transport &&
      a.command === b.command &&
      a.url === b.url &&
      // Nullish-collapsed because the field is optional: a row that has never had one and a row
      // whose one was cleared reach the same child, and must not restart each other.
      (a.cwd ?? "") === (b.cwd ?? "") &&
      isDeepStrictEqual(a.args ?? [], b.args ?? []) &&
      isDeepStrictEqual(a.env ?? {}, b.env ?? {}) &&
      isDeepStrictEqual(a.headers ?? {}, b.headers ?? {})
    );
  }

  /**
   * Takes a server's new name without touching its connection.
   *
   * `slug` and `label` are baked into every tool's wire name and description at connect time, so
   * once a rename no longer restarts the server the derived half has to be rebuilt here — or the
   * model keeps being offered the old names.
   */
  private relabel(entry: Entry, config: McpServerConfig) {
    const renamed =
      McpPool.slugOf(entry.config) !== McpPool.slugOf(config) ||
      entry.config.label !== config.label;
    const reclocked = entry.config.idleTimeoutMs !== config.idleTimeoutMs;
    entry.config = config;
    // An edited idle timeout is not a reason to restart the child, but the armed timer is still
    // running the old one — so it is re-armed rather than left to fire on a stale duration.
    if (reclocked) this.touch(entry);
    if (!renamed) return;
    entry.tools = entry.tools.map((tool) => McpPool.pooledTool(config, tool));
  }

  /** Whether a failed server is enabled, down, and has waited out its backoff. */
  private retryDue(entry: Entry) {
    if (!entry.config.enabled || entry.status !== "error") return false;
    return entry.failedAt === undefined || Date.now() - entry.failedAt >= this.crashBackoffMs;
  }

  /**
   * Dials every failed server that is due another attempt, using the configs already held.
   *
   * Deliberately not a `sync()`: this runs from `call`, where the pool must not go back to
   * `load` for rows — a pool driven by explicit `sync(configs)` has no `load` at all, and asking
   * an absent one would reconcile against an empty set and close every server it has.
   */
  /**
   * Connects whatever might be able to answer a name the index does not know.
   *
   * Failed servers that are due a retry, plus — under `lazy` — the idle ones. Idle servers are
   * narrowed by testing each *known* slug against the name, which is not the same as splitting
   * an unknown name into slug and tool: `qualify` shortens long names, and the split of a
   * shortened name is a tool its server never had, but asking whether a name starts with a slug
   * this pool configured is always a fair question. A name no slug claims wakes everything,
   * because a slug long enough to be shortened away is the one case the prefix test misses.
   */
  private async wake(qualifiedName: string): Promise<void> {
    const idle = [...this.entries.values()].filter((entry) => entry.status === "idle");
    const claimed = idle.filter((entry) =>
      qualifiedName.startsWith(`${McpPool.slugOf(entry.config)}${SEPARATOR}`),
    );
    for (const entry of claimed.length > 0 ? claimed : idle) await this.ensure(entry);
    await this.retryFailed();
  }

  private retryFailed(): Promise<void> {
    return this.queue(async () => {
      const due = [...this.entries.values()].filter((entry) => this.retryDue(entry));
      for (const entry of due) {
        await this.close(entry);
        await this.connect(entry.config);
      }
      if (due.length > 0) this.reindex();
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

  private async connect(config: McpServerConfig, force = false) {
    const status = !config.enabled ? "disabled" : this.lazy && !force ? "idle" : "connecting";
    const entry: Entry = { config, status, tools: [] };
    this.entries.set(config.id, entry);
    // Registered but not dialled: a lazy pool still reconciles the entry set on `sync`, so
    // `state()` is complete and a later use has something to connect. Only the child is deferred.
    if (status !== "connecting") return;

    try {
      const client = new Client({ name: this.clientName, version: "0.1.0" });
      // Before the connect, and per connection rather than once at construction: a server can
      // send `logging/message` or `tools/list_changed` during its own startup, and a handler
      // installed after `listTools` would have missed it. Unlike `onclose` there is no race to
      // avoid here — a notification from a server that then dies is still one that was sent.
      client.fallbackNotificationHandler = async (notification) => {
        this.notify(config.id, notification);
      };
      const transport = createTransport(config, { childEnv: this.childEnv });
      // Listening before the connect, because a server that dies during startup says whatever
      // it has to say then and the connect only reports that the pipe closed.
      entry.stderrTail = readStderrTail(transport);
      const timeout =
        this.connectTimeoutMs === undefined ? undefined : { timeout: this.connectTimeoutMs };
      await client.connect(transport, timeout);
      const { tools } = await client.listTools(undefined, timeout);

      entry.client = client;
      entry.status = "ready";
      entry.tools = tools.map((tool) =>
        McpPool.pooledTool(config, {
          name: tool.name,
          description: tool.description ?? "",
          parameters: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        }),
      );
      // Installed only once the server is up: a child that dies mid-handshake is reported by
      // `connect` rejecting, and `onClose` firing then would race the success path below.
      client.onclose = () => this.onClose(entry);
      // Started here rather than on first use, so a server connected eagerly and then never
      // asked for anything is reaped like any other — otherwise the one child an idle timeout is
      // most obviously meant to collect is the one it never touches.
      this.touch(entry);
      this.log.info?.(`[mcp] ${McpPool.slugOf(config)}: ${entry.tools.length} tool(s)`);
    } catch (error) {
      entry.status = "error";
      // What the child said on the way out, when it managed to say anything: "ModuleNotFoundError:
      // no module named mcp_server_git" beats "MCP error -32000: Connection closed".
      entry.error = entry.stderrTail?.() || errorMessage(error);
      entry.failedAt = Date.now();
      this.log.error?.(`[mcp] ${McpPool.slugOf(config)}: ${entry.error}`);
    }
  }

  /**
   * A connected server dropped its connection without being asked to.
   *
   * The pool used to have no idea this had happened: the entry stayed `ready`, `index` kept
   * handing out its tools, and the model was offered tools whose child process was gone — the
   * failure arriving as a transport error inside a tool call rather than as a server that is
   * down. Marking it failed is also what lets a later `sync` pick it back up.
   */
  private onClose(entry: Entry) {
    if (entry.closing) return;
    this.disarm(entry);
    entry.client = undefined;
    entry.status = "error";
    entry.error = entry.stderrTail?.() || "the server closed the connection";
    entry.failedAt = Date.now();
    // Cleared rather than kept as a last-known list, so `state()` cannot read as a server that
    // is down but still has tools to offer.
    entry.tools = [];
    this.reindex();
    this.log.error?.(`[mcp] ${McpPool.slugOf(entry.config)}: ${entry.error}`);
  }

  /**
   * Everything about a tool that its server's name decides.
   *
   * One place, because `connect` builds these and `relabel` rebuilds them, and a model calling a
   * name the pool no longer indexes is the failure mode when the two drift.
   */
  private static pooledTool(
    config: McpServerConfig,
    tool: { name: string; description: string; parameters: Record<string, unknown> },
  ): PooledTool {
    const slug = McpPool.slugOf(config);
    const label = config.label || slug;
    const qualified = McpPool.qualify(slug, tool.name);
    return {
      ...tool,
      qualified,
      definition: {
        type: "function",
        function: {
          name: qualified,
          description: `[${label}] ${tool.description}`.trim(),
          parameters: tool.parameters,
        },
      },
    };
  }

  private async close(entry: Entry) {
    entry.closing = true;
    this.disarm(entry);
    try {
      await entry.client?.close();
    } catch {
      // a server that died on its own is already closed
    }
    entry.client = undefined;
  }

  /**
   * The namespace this server's tools live under: its `slug`, or its `id` when it has none.
   *
   * One place, because every read of the field has to agree — a `qualify` defaulting to the id
   * and a `wake` prefix test reading the raw field would build names one of them could not then
   * recognise. Empty falls back too, since an empty slug would qualify a tool as `__name`.
   */
  private static slugOf(config: McpServerConfig) {
    return config.slug || config.id;
  }

  /**
   * The one place a tool's wire name is built, so `call` and `tools` agree.
   *
   * 64 characters is OpenAI's hard limit on a function name. Plain truncation made two tools
   * whose qualified names shared a 64-character prefix collapse onto one key, and the second
   * silently replaced the first in the index — the model was then offered a name that dispatched
   * to the wrong tool. A long slug plus two verbosely-named tools is enough to reach it.
   *
   * So an over-long name keeps as much of itself as fits and gives up the tail to a hash of the
   * *whole* name, which is what tells the two apart. Names that already fit are returned
   * untouched, so this changes no wire name that was not already ambiguous.
   */
  private static qualify(slug: string, tool: string) {
    const full = `${slug}${SEPARATOR}${tool}`;
    if (full.length <= NAME_LIMIT) return full;
    const digest = createHash("sha256").update(full).digest("hex").slice(0, HASH_LENGTH);
    return `${full.slice(0, NAME_LIMIT - HASH_LENGTH - 1)}_${digest}`;
  }

  /**
   * A run's scope, as a set.
   *
   * `undefined` means every connected server; an *empty* scope means none of them, which is
   * what a caller wants for an agent with no servers linked to it. Those two must not collapse
   * into each other, so the distinction is carried rather than inferred from emptiness.
   */
  private static scope(servers?: Iterable<string>): ReadonlySet<string> | undefined {
    return servers === undefined ? undefined : new Set(servers);
  }

  /**
   * Tool definitions for the model. Pass `names` to get only those — on-demand loading sends
   * a handful of schemas instead of every one.
   *
   * `servers` is the run's scope. It is applied here as well as in `catalog` because a name can
   * also arrive from `load_tools`, where the model rather than the pool chose it.
   */
  tools(names?: string[], servers?: Iterable<string>): OpenAI.ChatCompletionTool[] {
    const allowed = McpPool.scope(servers);
    const entries = names ? names.map((name) => this.index.get(name)) : [...this.index.values()];
    const definitions: OpenAI.ChatCompletionTool[] = [];
    for (const found of entries) {
      if (!found || (allowed && !allowed.has(found.serverId))) continue;
      definitions.push(found.tool.definition);
    }
    return definitions;
  }

  /**
   * Subscribe to notifications from any connected server. Returns an unsubscribe function.
   *
   * The SDK drops whatever it does not handle itself, so without this a `tools/list_changed`, a
   * `resources/updated` or a `logging/message` goes nowhere. An agent loop rarely misses them —
   * the index is rebuilt on `sync()` regardless — but a consumer relaying the protocol onward has
   * no other way to see that a server added a tool at runtime, and a client that called
   * `resources/subscribe` waits forever for an update the pool swallowed.
   *
   * The server id comes first because a listener hears from every server at once and the
   * notification itself does not say which one it came from.
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
   * it: this runs inside the SDK's handler, where a rejection becomes a protocol-level error on
   * a server that did nothing wrong.
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
    entry.idleTimer = setTimeout(() => this.reap(entry), timeout);
    // A pool waiting to reap a server is not a reason for the process to stay up.
    entry.idleTimer.unref?.();
  }

  private disarm(entry: Entry) {
    if (entry.idleTimer === undefined) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  /**
   * Closes a server that has gone unused, leaving it able to come back.
   *
   * Deliberately not the crash path, though the index mutation is the same one: no `error`, no
   * `failedAt`, so no backoff stands between this server and the next call that wants it. An
   * operator reading `state()` sees a server that is fine and simply not running.
   */
  private reap(entry: Entry) {
    void this.queue(async () => {
      const current = this.entries.get(entry.config.id);
      if (!current || current !== entry || current.status !== "ready") return;
      await this.close(current);
      current.closing = false;
      current.status = "idle";
      current.tools = [];
      this.reindex();
      this.log.info?.(`[mcp] ${McpPool.slugOf(current.config)}: idle, closed`);
    });
  }

  /**
   * Names and descriptions only — the cheap half, for the on-demand catalogue.
   *
   * A ready server offering no tools is dropped rather than listed empty. It has nothing to say
   * to any consumer, `tools()` already returns nothing for it, and a catalogue holding only such
   * entries is not empty — so a prompt builder that short-circuits on an empty catalogue instead
   * spends its whole preamble introducing a list of nothing, and offers the model names that do
   * not exist. `state()` still reports the server: the operator wants that row.
   */
  catalog(servers?: Iterable<string>): CatalogServer[] {
    const allowed = McpPool.scope(servers);
    const out: CatalogServer[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status !== "ready" || entry.tools.length === 0) continue;
      if (allowed && !allowed.has(entry.config.id)) continue;
      out.push({
        id: entry.config.id,
        label: entry.config.label || McpPool.slugOf(entry.config),
        tools: entry.tools.map(({ qualified, description }) => ({
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
   * Everything this pool does is connection management — reconcile, the queue that stops two
   * syncs orphaning a child, crash detection with the stderr tail, backoff, retry-on-use — and
   * only the last mile is shaped for an agent loop. `tools()` returns OpenAI definitions and
   * `call()` returns a string because a string is what goes back into a message array; a
   * consumer proxying the protocol needs neither, and needs `listResources`, `readResource`,
   * `getPrompt`, `setLoggingLevel` and the rest that a string was never going to carry. This
   * hands back the client so the connection half can be used on its own.
   *
   * A server that is merely down is retried first, the same as `call()` does, rather than
   * reported as if it were not configured.
   *
   * **This bypasses the scope check `call()` makes, by construction.** That guard defends
   * against a *model* calling a name it remembers from an earlier run; a caller reaching for
   * the client is proxying a protocol rather than driving a model, and has no scope. A disabled
   * server is still refused — it is off, not merely unscoped.
   */
  async client(id: string): Promise<Client> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`no MCP server is configured with id "${id}"`);
    const slug = McpPool.slugOf(entry.config);
    if (!entry.config.enabled) throw new Error(`the MCP server "${slug}" is disabled`);

    // The whole lazy path for a consumer that knows which server it wants: a cold entry is
    // dialled here, and a warm one has its idle clock restarted.
    const current = await this.ensure(entry);
    if (!current.client) {
      throw new Error(
        `the MCP server "${slug}" is not connected${current.error ? `: ${current.error}` : ""}`,
      );
    }
    return current.client;
  }

  /**
   * Runs one tool call and returns text for a tool message.
   *
   * `servers` is checked again here rather than trusted from the definitions the caller was
   * given: a model that has seen a tool name once will call it again from memory, and a run
   * must not reach a server it was not scoped to however it learned the name.
   */
  async call(qualifiedName: string, input: unknown, servers?: Iterable<string>): Promise<string> {
    const allowed = McpPool.scope(servers);
    // Resolved by the whole qualified name rather than by splitting it: `qualify` shortens names
    // that pass 64 characters, and the split of a shortened name names a tool its server never had.
    let found = this.index.get(qualifiedName);
    if (!found) {
      // A crashed server took its tools out of the index with it, and a lazy pool never put a
      // cold server's tools there at all. Before telling the model the tool does not exist —
      // which is how you teach it to stop asking for a tool that is merely down — bring back
      // whatever is owed a connection and look once more.
      await this.wake(qualifiedName);
      found = this.index.get(qualifiedName);
    }
    // A tool outside this run's scope is answered as one that does not exist, because to this
    // run it does not: saying "that server is not yours" would teach the model to ask again.
    if (!found || (allowed && !allowed.has(found.serverId))) {
      throw new Error(`no connected MCP server offers a tool called "${qualifiedName}"`);
    }

    const entry = this.entries.get(found.serverId);
    if (entry) this.touch(entry);

    const result = await found.client.callTool({
      name: found.tool.name,
      arguments: (input ?? {}) as Record<string, unknown>,
    });

    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((block: { type?: string; text?: string }) =>
        block.type === "text" ? block.text : `[${block.type ?? "unknown"} content]`,
      )
      .join("\n")
      .trim();

    if (result.isError) throw new Error(text || "tool call failed");
    return text || "(no output)";
  }

  /**
   * Tests a config that may not be saved yet, introducing itself the way this pool does.
   *
   * The free `probe` takes the client name and the environment policy as arguments, so every
   * consumer with a "Test connection" button wrote the same wrapper to bind them — and one that
   * bound them differently got a probe introducing itself as one thing and a pool as another,
   * which shows up only in a remote server's logs. The pool has already been told both.
   *
   * `probe` stays exported for the case it was written for: a caller with a config and no pool
   * to hold it.
   */
  probe(config: McpConnection): Promise<McpProbe> {
    return probeConfig(config, this.clientName, { childEnv: this.childEnv });
  }

  /**
   * Every configured server, in the order it was configured, with the row it came from.
   *
   * The row is handed back rather than projected away because the pool is the only thing holding
   * both halves: a consumer drawing an edit form beside a connection status would otherwise keep
   * its own copy of the same rows, and that copy is the one that goes stale.
   */
  state(): McpServerState[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.config.id,
      slug: McpPool.slugOf(entry.config),
      label: entry.config.label,
      config: entry.config,
      status: entry.status,
      error: entry.error ?? "",
      tools: entry.tools.map(({ name, description }) => ({ name, description })),
    }));
  }

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
