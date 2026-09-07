import { type CatalogServer, errorMessage } from "@cubicecho/agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type OpenAI from "openai";
import { createTransport } from "./transport.ts";
import type { McpServerConfig, McpServerState, McpStatus } from "./types.ts";

const SEPARATOR = "__";

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

  private readonly load?: () => Promise<McpServerConfig[]>;
  private readonly clientName: string;
  private readonly log: NonNullable<McpPoolOptions["log"]>;

  constructor({ load, clientName = "mcp-pool", log }: McpPoolOptions = {}) {
    this.load = load;
    this.clientName = clientName;
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
        // Reconnecting an unchanged server would restart its child process for nothing.
        if (existing && JSON.stringify(existing.config) === JSON.stringify(config)) return;
        if (existing) await this.close(existing);
        await this.connect(config);
      }),
    );
    this.reindex();
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

  private async connect(config: McpServerConfig) {
    const entry: Entry = { config, status: config.enabled ? "connecting" : "disabled", tools: [] };
    this.entries.set(config.id, entry);
    if (!config.enabled) return;

    try {
      const client = new Client({ name: this.clientName, version: "0.1.0" });
      await client.connect(createTransport(config));
      const { tools } = await client.listTools();

      const label = config.label || config.slug;
      entry.client = client;
      entry.status = "ready";
      entry.tools = tools.map((tool) => {
        const qualified = McpPool.qualify(config.slug, tool.name);
        const description = tool.description ?? "";
        return {
          name: tool.name,
          description,
          qualified,
          definition: {
            type: "function",
            function: {
              name: qualified,
              description: `[${label}] ${description}`.trim(),
              parameters: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
            },
          },
        };
      });
      this.log.info?.(`[mcp] ${config.slug}: ${entry.tools.length} tool(s)`);
    } catch (error) {
      entry.status = "error";
      entry.error = errorMessage(error);
      this.log.error?.(`[mcp] ${config.slug}: ${entry.error}`);
    }
  }

  private async close(entry: Entry) {
    try {
      await entry.client?.close();
    } catch {
      // a server that died on its own is already closed
    }
    entry.client = undefined;
  }

  /** The one place a tool's wire name is built, so `call` and `tools` agree. */
  private static qualify(slug: string, tool: string) {
    return `${slug}${SEPARATOR}${tool}`.slice(0, 64);
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

  /** Names and descriptions only — the cheap half, for the on-demand catalogue. */
  catalog(servers?: Iterable<string>): CatalogServer[] {
    const allowed = McpPool.scope(servers);
    const out: CatalogServer[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status !== "ready") continue;
      if (allowed && !allowed.has(entry.config.id)) continue;
      out.push({
        id: entry.config.id,
        label: entry.config.label || entry.config.slug,
        tools: entry.tools.map(({ qualified, description }) => ({
          name: qualified,
          description,
        })),
      });
    }
    return out;
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
    // Resolved by the whole qualified name rather than by splitting it: `qualify` truncates at
    // 64 characters, and the split of a truncated name names a tool its server never had.
    const found = this.index.get(qualifiedName);
    // A tool outside this run's scope is answered as one that does not exist, because to this
    // run it does not: saying "that server is not yours" would teach the model to ask again.
    if (!found || (allowed && !allowed.has(found.serverId))) {
      throw new Error(`no connected MCP server offers a tool called "${qualifiedName}"`);
    }

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

  state(): McpServerState[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.config.id,
      slug: entry.config.slug,
      label: entry.config.label,
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
