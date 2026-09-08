import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type OpenAI from "openai";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { McpPoolError } from "../src/errors.ts";
import { qualify, SEPARATOR } from "../src/naming.ts";
import { McpPool } from "../src/pool.ts";
import { probe } from "../src/probe.ts";
import { MINIMAL_CHILD_ENV } from "../src/transport.ts";
import type { McpServerConfig, McpServerPublicConfig, StdioServerConfig } from "../src/types.ts";
import { POOL_VERSION } from "../src/version.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pool-"));
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url));
const spawnLog = path.join(dir, "spawns.log");

/** The pid of every child the fixture has been started as, across every sync so far. */
const spawnedPids = (): number[] =>
  fs.existsSync(spawnLog)
    ? fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).map(Number)
    : [];

const spawned = () => spawnedPids().length;

/**
 * Which of these processes are still running, once they have had a moment to go.
 *
 * This is the only way to see the bug the overlapping-sync tests are about: a client the pool
 * dropped its handle to still has a live child on the end of it, and nothing the pool reports
 * mentions it. Signal 0 asks the kernel whether a pid exists without sending anything to it.
 */
async function stillAlive(pids: number[]): Promise<number[]> {
  const alive = () =>
    pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  for (let attempt = 0; attempt < 40 && alive().length > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return alive();
}

/** Waits for something the pool does off the back of a child exiting, rather than for a duration. */
async function until(done: () => boolean, what: string) {
  for (let attempt = 0; attempt < 100 && !done(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

const config = (over: Partial<StdioServerConfig> = {}): StdioServerConfig => ({
  id: "echo-1",
  slug: "echo",
  label: "Echo",
  enabled: true,
  transport: "stdio",
  command: process.execPath,
  args: [FIXTURE],
  env: { MCP_ECHO_SPAWN_LOG: spawnLog },
  ...over,
});

/** Silent: these tests spawn servers that fail on purpose, and say so on stderr. */
const makePool = (load?: () => Promise<McpServerConfig[]>, crashBackoffMs?: number) =>
  new McpPool({ load, clientName: "mcp-pool-test", log: {}, crashBackoffMs });

/** The qualified names in a set of definitions. A definition is a union; only the function arm
 * is used here. */
const names = (definitions: OpenAI.ChatCompletionTool[]) =>
  definitions.flatMap((t) => (t.type === "function" ? [t.function.name] : []));

/** The qualified names on offer. */
const toolNames = (pool: McpPool, servers?: string[]) => names(pool.tools({ servers }));

/** A row as `state()` reports it by default: everything except the credentials — which is one
 * field per transport arm, since a row only carries its own. */
const withoutSecrets = (row: McpServerConfig) => {
  if (row.transport === "stdio") {
    const { env, ...rest } = row;
    return rest;
  }
  const { headers, ...rest } = row;
  return rest;
};

/**
 * A reported row narrowed to the stdio arm, which every row these tests configure is.
 *
 * `McpServerPublicConfig` is a union now, so `config.args` is not a field on it until the
 * transport has been checked — the point of the union, and the cost of it at a call site that
 * already knows.
 */
function stdio(config?: McpServerPublicConfig) {
  if (config?.transport !== "stdio") throw new Error("expected a stdio row");
  return config;
}

/**
 * The pool's refusal itself rather than its message, since the message is deliberately the same
 * for two of them.
 */
async function refusal(work: Promise<unknown>): Promise<McpPoolError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof McpPoolError) return error;
    throw error;
  }
  throw new Error("expected the pool to refuse");
}

let pool = makePool();

afterEach(async () => {
  await pool.shutdown();
  pool = makePool();
  fs.rmSync(spawnLog, { force: true });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("connects a configured server and offers its tools qualified by slug", async () => {
  await pool.sync([config()]);

  expect(pool.state()).toMatchObject([{ slug: "echo", status: "ready", error: "" }]);
  expect(toolNames(pool)).toEqual(["echo__ping", "echo__echo", "echo__add"]);
  expect(await pool.call("echo__ping", {})).toBe("ping({})");
});

/**
 * `openai` stopped being a peer dependency: `ToolDefinition` is declared structurally, so a
 * consumer that never calls a model no longer installs 24 MB for a type that is erased anyway.
 * The annotation is the assertion — this fails at `npm run typecheck` if the two shapes drift.
 */
test("the definitions the pool hands back are still OpenAI's chat tools", async () => {
  await pool.sync([config()]);

  const definitions: OpenAI.ChatCompletionTool[] = pool.tools();
  expect(names(definitions)).toEqual(["echo__ping", "echo__echo", "echo__add"]);
});

test("an unchanged config is left alone rather than reconnected", async () => {
  await pool.sync([config()]);
  await pool.sync([config()]);

  // Restarting a stdio server costs a process spawn and drops whatever state it was holding.
  expect(spawned()).toBe(1);
});

test("overlapping syncs off the source reconnect an edited server once", async () => {
  // The seam under test: the pool asks its `load` for the rows rather than importing a database.
  let rows = [config()];
  pool = makePool(async () => rows);
  await pool.sync();

  // An edit the connection is actually made of, so the server has to be restarted for it.
  rows = [config({ args: [FIXTURE, "--restarted"] })];
  // Two callers arriving together is what a batch of writes through a GraphQL hook looks like.
  // Both read the source, both compared the edited row against the entry the other had not
  // replaced yet, and both reconnected — the second's entry overwriting the first, whose child
  // stayed up with nothing left holding a handle to close it. The pool reported one tidy server
  // throughout.
  await Promise.all([pool.sync(), pool.sync()]);

  expect(pool.state()).toMatchObject([{ slug: "echo", status: "ready" }]);
  expect(spawned()).toBe(2);

  const pids = spawnedPids();
  await pool.shutdown();
  expect(await stillAlive(pids)).toEqual([]);
});

/**
 * The other half of the differ: `sync` used to compare whole rows with `JSON.stringify`, so
 * correcting a typo in a label tore down a running server and everything it was holding.
 */
test("renaming a server keeps its child and re-labels its tools in place", async () => {
  let rows = [config()];
  pool = makePool(async () => rows);
  await pool.sync();
  const [first] = spawnedPids();

  rows = [config({ slug: "echo2", label: "Echo, renamed" })];
  await pool.sync();

  expect(spawned()).toBe(1);
  expect(await stillAlive([first as number])).toEqual([first]);
  // The name is derived from the slug at connect time, so it has to be rebuilt without one.
  expect(toolNames(pool)).toEqual(["echo2__ping", "echo2__echo", "echo2__add"]);
  expect(await pool.call("echo2__ping", {})).toBe("ping({})");
  expect(pool.state()).toMatchObject([{ label: "Echo, renamed", status: "ready" }]);
});

/**
 * `state()` is what an operator's list is drawn from, so its order is the list's order. It used
 * to be `entries` insertion order, which a reconcile's parallel connects and `reconnect`'s
 * delete-then-redial both scramble — so the list reshuffled itself under the operator and a
 * consumer that wanted it still kept its own ordered array and drove the screen from that.
 */
test("state() is in the configured order, not the order the servers connected in", async () => {
  const rows = ["a", "b", "c"].map((id) => config({ id, slug: id }));
  await pool.sync(rows);
  expect(pool.state().map((entry) => entry.id)).toEqual(["a", "b", "c"]);

  // A pure reorder: every row is unchanged, so the reconcile leaves all three children up and
  // touches nothing but the order. Nothing derived from a row could reconstruct this.
  await pool.sync([rows[2], rows[0], rows[1]] as McpServerConfig[]);
  expect(spawned()).toBe(3);
  expect(pool.state().map((entry) => entry.id)).toEqual(["c", "a", "b"]);

  // A new row at the front, which is where an operator adding a server to a positioned list puts
  // it. The entry is created by whichever callback reaches it first, not by where it belongs.
  await pool.sync([config({ id: "d", slug: "d" }), ...rows]);
  expect(pool.state().map((entry) => entry.id)).toEqual(["d", "a", "b", "c"]);
});

test("reconnecting a server leaves it where it was in the list", async () => {
  const rows = ["a", "b", "c"].map((id) => config({ id, slug: id }));
  await pool.sync(rows);

  // The redial drops the entry and makes it again, which used to send it to the bottom — so the
  // row an operator pressed "reconnect" on jumped out from under them.
  await pool.reconnect("a", rows);

  expect(pool.state().map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  expect(pool.state()[0]).toMatchObject({ status: "ready" });
});

/**
 * The pool holds every configured row already. Projecting them away made a consumer keep a
 * second map of the same rows to draw an edit form beside a connection status — and that copy
 * goes stale the moment anything reconciles without going through it, which is exactly what
 * `syncSoon()` and a `load`-driven `sync()` do.
 */
test("state() hands back the row a server was configured from", async () => {
  const row = config({ cwd: "/tmp", idleTimeoutMs: 0 });
  await pool.sync([row]);

  const [entry] = pool.state();
  expect(entry?.config).toEqual(withoutSecrets(row));
  // The identity fields stay alongside it: those are what the pool actually used.
  expect(entry).toMatchObject({ id: "echo-1", slug: "echo", label: "Echo", status: "ready" });
});

test("a renamed server reports the new row, not the one it connected under", async () => {
  let rows = [config()];
  pool = makePool(async () => rows);
  await pool.sync();

  rows = [config({ label: "Echo, renamed" })];
  await pool.sync();

  // `relabel` swaps the row in place without restarting the child; `state()` has to follow it.
  expect(pool.state()[0]?.config).toEqual(withoutSecrets(rows[0] as McpServerConfig));
});

test("a server the pool never dialled still reports its row", async () => {
  const row = config({ enabled: false });
  await pool.sync([row]);

  expect(pool.state()).toMatchObject([{ status: "disabled", config: withoutSecrets(row) }]);
});

/**
 * `state()` is documented as what a UI draws the edit form and the connection state from, and a
 * UI is a browser. For a real server `env` and `headers` are an API key and an
 * `Authorization: Bearer`, so the consumer that followed the README shipped its credentials to
 * the client — on a shape where every other field was safe to hand onward.
 */
test("state() leaves the credentials out of the row, unless they are asked for", async () => {
  // One row per arm, because a row carries one credential field and the other arm's is the one a
  // single-transport test would never have caught being reported.
  const child = config({
    env: { MCP_ECHO_SPAWN_LOG: spawnLog, OPENAI_API_KEY: "sk-SUPER-SECRET" },
  });
  const remote: McpServerConfig = {
    id: "remote-1",
    slug: "remote",
    label: "Remote",
    enabled: false,
    transport: "http",
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer TOKEN-SECRET" },
  };
  await pool.sync([child, remote]);

  const safe = pool.state();
  expect(safe[0]?.config).not.toHaveProperty("env");
  expect(safe[1]?.config).not.toHaveProperty("headers");
  // Whatever a consumer serialises of it, rather than the two fields alone.
  expect(JSON.stringify(safe)).not.toContain("SECRET");

  // The edit form rendered server-side is the one caller that legitimately needs them back.
  const full = pool.state({ secrets: true });
  expect(stdio(full[0]?.config).env).toEqual(child.env);
  expect(full[1]?.config).toHaveProperty("headers", remote.headers);
});

/**
 * The entry held the caller's own object, so `sameConnection` was asked whether a row differed
 * from itself and always answered no. A caller that parses its rows once and hands out the same
 * objects — a config file rather than a fresh `db.select()` — got a pool that never reconnected,
 * and a `state()` reporting an edit the running child knew nothing about.
 */
test("a row edited in place is a changed row, not one the pool is already running", async () => {
  const row = config();
  pool = makePool(async () => [row]);
  await pool.sync();

  row.args = [FIXTURE, "--edited"];
  await pool.sync();

  expect(spawned()).toBe(2);
  expect(stdio(pool.state()[0]?.config).args).toEqual([FIXTURE, "--edited"]);
});

test("the row state() reports is a copy, so editing it cannot reach the pool", async () => {
  const row = config();
  await pool.sync([row]);

  const [seen] = pool.state();
  if (seen) seen.config.label = "edited";
  stdio(seen?.config).args?.push("--edited");

  expect(pool.state()[0]?.config).toEqual(withoutSecrets(row));
  // Still the same connection as far as the pool is concerned, so nothing restarts.
  await pool.sync([row]);
  expect(spawned()).toBe(1);
});

/**
 * `ready` is not much to go on. A pid is what an operator reaches for to find a wedged child in
 * `ps` or to kill it, and a start time is how a server that is quietly crash-looping is spotted —
 * `status` reads `ready` either side of a restart. Neither is recoverable once the pool owns the
 * transport.
 */
test("state() describes the running child: its pid, and when it started", async () => {
  const before = Date.now();
  await pool.sync([config()]);

  const [entry] = pool.state();
  expect(entry?.pid).toBe(spawnedPids()[0]);
  expect(Date.parse(entry?.startedAt ?? "")).toBeGreaterThanOrEqual(before);
});

test("a pid does not outlive the child it named", async () => {
  pool = makePool(undefined, 60_000);
  await pool.sync([config()]);
  process.kill(spawnedPids()[0] as number, "SIGKILL");
  await until(() => pool.state()[0]?.status === "error", "the pool to notice the child died");

  // Pids are reused, so one kept past its process eventually names somebody else's.
  expect(pool.state()[0]?.pid).toBeUndefined();
  expect(pool.state()[0]?.startedAt).toBeUndefined();
});

test("overlapping syncs settle on the last config and orphan nothing", async () => {
  const first = pool.sync([config({ slug: "one" })]);
  const second = pool.sync([config({ slug: "two" })]);
  await Promise.all([first, second]);

  expect(pool.state().map((entry) => entry.slug)).toEqual(["two"]);
  expect(toolNames(pool)).toContain("two__ping");

  const pids = spawnedPids();
  await pool.shutdown();
  // Unserialised, the first sync finished connecting after the second had already replaced its
  // entry, so it stored its client on an object the pool no longer held — and `shutdown` had
  // nothing to close the child with.
  expect(await stillAlive(pids)).toEqual([]);
});

test("a disabled server holds its place without a connection", async () => {
  await pool.sync([config({ enabled: false })]);

  expect(pool.state()).toMatchObject([{ slug: "echo", status: "disabled", tools: [] }]);
  expect(pool.tools()).toEqual([]);
  expect(spawned()).toBe(0);
});

test("a server that cannot start is reported rather than thrown", async () => {
  await pool.sync([config({ command: path.join(dir, "does-not-exist") })]);

  const [entry] = pool.state();
  expect(entry.status).toBe("error");
  expect(entry.error).not.toBe("");
  expect(pool.tools()).toEqual([]);
});

test("flush pays off a debounced sync, so a reader sees its own write", async () => {
  let rows: McpServerConfig[] = [];
  pool = makePool(async () => rows);

  rows = [config()];
  pool.syncSoon();
  // The debounce is what a write hook leans on; without `flush` a read arriving in the same
  // millisecond — add a server, then ask its status — answers about the pool as it was.
  expect(pool.state()).toEqual([]);

  await pool.flush();
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "ready" }]);
});

/**
 * The half of the window `owed` cannot see. Once the timer has fired, `settle` clears the flag
 * and only then starts reconciling — so a reader arriving during the reconnect found `owed`
 * already false, and `flush` handed back a pool still spawning the server it had just been told
 * about. That is most of the wait, not a sliver of it.
 */
test("flush waits for a debounced sync that has already started", async () => {
  let rows: McpServerConfig[] = [];
  pool = makePool(async () => rows);

  rows = [config()];
  pool.syncSoon();
  // `connect` registers the entry before it dials, so a row at all means the reconcile is under
  // way and the debounce is spent — the state `owed` reports nothing about.
  await until(() => pool.state().length > 0, "the debounced sync to start");

  await pool.flush();
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "ready" }]);
  expect(spawned()).toBe(1);
});

test("flush is a no-op when nothing is owed", async () => {
  await pool.sync([config()]);
  await pool.flush();

  expect(spawned()).toBe(1);
});

test("a removed server is closed and its tools stop being offered", async () => {
  await pool.sync([config()]);
  const pids = spawnedPids();
  await pool.sync([]);

  // Dropping the entry is not the same as ending the process: once the map no longer holds it,
  // nothing — not even `shutdown` — can reach the child to close it.
  expect(await stillAlive(pids)).toEqual([]);
  expect(pool.state()).toEqual([]);
  expect(pool.tools()).toEqual([]);
  await expect(pool.call("echo__ping", {})).rejects.toThrow(/no connected MCP server/);
});

/**
 * The scoping semantics the two forks had spelled differently: `kanban_server` passed an array
 * of ids and treated an empty one as "no tools at all"; `task_server` passed an optional set and
 * treated absence as "everything". Both are needed, so both are kept — and the distinction is
 * between *absent* and *empty*, which is exactly what an array alone could not express.
 */
test("an absent scope is every server; an empty scope is none of them", async () => {
  await pool.sync([config()]);

  expect(toolNames(pool)).toHaveLength(3);
  expect(toolNames(pool, ["echo-1"])).toHaveLength(3);
  expect(toolNames(pool, [])).toEqual([]);
  expect(pool.catalog([])).toEqual([]);
  expect(pool.catalog()).toHaveLength(1);
});

test("a call to a server outside the run's scope is refused as one that does not exist", async () => {
  await pool.sync([config()]);

  // Not "that server is not yours": a model told it exists but is off-limits asks again.
  await expect(pool.call("echo__ping", {}, [])).rejects.toThrow(/no connected MCP server/);
  expect(await pool.call("echo__ping", {}, ["echo-1"])).toBe("ping({})");
});

test("reconnect dials a server again that sync would have left alone", async () => {
  const rows = [config()];
  pool = makePool(async () => rows);
  await pool.sync();
  const [first] = spawnedPids();

  // Nothing about the row has changed — which is exactly the case `sync` refuses to act on.
  await pool.reconnect("echo-1");

  expect(spawned()).toBe(2);
  expect(await stillAlive([first as number])).toEqual([]);
  expect(toolNames(pool)).toEqual(["echo__ping", "echo__echo", "echo__add"]);
});

test("reconnecting a server that is not configured leaves the rest connected", async () => {
  await pool.sync([config()]);
  await pool.reconnect("nobody", [config()]);

  expect(spawned()).toBe(1);
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "ready" }]);
});

/**
 * `configs` is optional on both methods and used to fall back to `load`, so on a pool built
 * without one — the supported shape for a consumer that owns its own rows — an omitted argument
 * reconciled against `[]` and closed and forgot every server. Silently: it is the same code path
 * as a caller who really did drop every row, so there was no log line, no throw, and a `state()`
 * of `[]` that looks exactly like a pool nobody has synced yet.
 */
test("sync with no configs on a pool with no load is refused rather than closing everything", async () => {
  await pool.sync([config()]);

  const error = await refusal(pool.sync());

  expect(error.code).toBe("no-configs");
  // The point of the refusal: the servers the caller never removed are still there.
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "ready" }]);
  expect(await pool.call("echo__ping", {})).toBe("ping({})");
});

/**
 * The easier of the two to hit, because `reconnect(id)` reads as complete on its own — `configs`
 * looks like optional context rather than the whole wanted set.
 */
test("reconnect with no configs on a pool with no load leaves the server it named alone", async () => {
  await pool.sync([config()]);

  const error = await refusal(pool.reconnect("echo-1"));

  expect(error.code).toBe("no-configs");
  // Refused before the teardown, or the caller would get the error *and* a stopped server.
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "ready" }]);
  expect(spawned()).toBe(1);
});

test("sync with an empty array still closes every server, since a caller said so", async () => {
  await pool.sync([config()]);
  const pids = spawnedPids();

  await pool.sync([]);

  expect(pool.state()).toEqual([]);
  expect(await stillAlive(pids)).toEqual([]);
});

/**
 * `reconnect` dropped the entry and let the reconcile rebuild it, and a lazy reconcile registers
 * an entry at `idle` and waits for a use — so on a lazy pool "reconnect this wedged server"
 * *stopped* it, and the caller found out on the next call that spawned one. The two pools now
 * mean the same thing by the method.
 */
test("reconnect dials a lazy server rather than leaving it registered and stopped", async () => {
  pool = lazyPool();
  await pool.sync([config()]);
  await pool.call("echo__ping", {});
  const [first] = spawnedPids();

  await pool.reconnect("echo-1", [config()]);

  expect(pool.state()).toMatchObject([{ status: "ready", error: "" }]);
  expect(spawned()).toBe(2);
  expect(await stillAlive([first as number])).toEqual([]);
  expect(toolNames(pool)).toContain("echo__ping");
});

/** Forcing the dial is for enabled servers; a disabled row is off for a reason `reconnect` does
 * not overrule. */
test("reconnect leaves a disabled server disabled rather than starting it", async () => {
  pool = lazyPool();
  await pool.sync([config({ enabled: false })]);
  await pool.reconnect("echo-1", [config({ enabled: false })]);

  expect(pool.state()).toMatchObject([{ status: "disabled" }]);
  expect(spawned()).toBe(0);
});

/**
 * The primitive under "stop this server", "restart this server" and "close the child before
 * deleting its row": one server's child closed, its row left registered. `shutdown()` is all of
 * them and forgets them, and `sync()` only closes what the configs dropped.
 */
test("stop closes one server's child and leaves the row able to come back", async () => {
  await pool.sync([config()]);
  const [first] = spawnedPids();

  await pool.stop("echo-1");

  // Where a reap leaves a server, reached by a person instead of a clock.
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "idle", error: "", tools: [] }]);
  expect(pool.tools()).toEqual([]);
  expect(await stillAlive([first as number])).toEqual([]);

  // A restart is a stop and then a use.
  expect(await pool.call("echo__ping", {})).toBe("ping({})");
  expect(spawned()).toBe(2);
  expect(pool.state()).toMatchObject([{ status: "ready" }]);
});

/**
 * The eager pool's half of it: `idle` already means "registered, nothing wrong, no child", and
 * `reconcile` steps over it — so an explicitly stopped server is not dialled again by the next
 * write to the server table.
 */
test("a stopped server stays stopped through a sync of an unchanged row", async () => {
  const rows = [config()];
  pool = makePool(async () => rows);
  await pool.sync();
  await pool.stop("echo-1");

  await pool.sync();

  expect(spawned()).toBe(1);
  expect(pool.state()).toMatchObject([{ status: "idle" }]);
});

/**
 * Stopping a server that has already failed is the operator half of the crash-loop story: an
 * explicit stop is not a failure, so nothing is left for the next use to wait out.
 */
test("stop clears the backoff standing in front of a failed server", async () => {
  // A backoff far longer than the test, so only clearing it can let the call through.
  pool = makePool(undefined, 60_000);
  await pool.sync([config()]);
  process.kill(spawnedPids()[0] as number, "SIGKILL");
  await until(() => pool.state()[0]?.status === "error", "the pool to notice the child died");

  await pool.stop("echo-1");
  expect(pool.state()).toMatchObject([{ status: "idle", error: "" }]);

  // Immediately: an explicit stop is not a failure, so there is nothing left to wait out.
  expect(await pool.call("echo__ping", {})).toBe("ping({})");
  expect(spawned()).toBe(2);
});

test("stopping a server the pool does not know is not an error", async () => {
  await pool.sync([config()]);
  await pool.stop("nobody");

  expect(pool.state()).toMatchObject([{ slug: "echo", status: "ready" }]);
});

/**
 * The pool had no `onclose` at all: a child that died left the entry `ready` with its tools still
 * in the index, so `state()` showed a healthy server and the model was handed tools whose process
 * was gone. The failure surfaced as a transport error inside a tool call instead.
 */
test("a child that dies on its own is reported as failed and stops offering tools", async () => {
  await pool.sync([config()]);
  const [child] = spawnedPids();

  process.kill(child as number, "SIGKILL");
  await until(() => pool.state()[0]?.status === "error", "the pool to notice the child died");

  expect(pool.state()).toMatchObject([{ slug: "echo", status: "error", tools: [] }]);
  expect(pool.tools()).toEqual([]);
  expect(pool.catalog()).toEqual([]);
});

test("shutting down is not mistaken for a crash", async () => {
  await pool.sync([config()]);
  await pool.shutdown();

  // `close` fires `onclose` exactly like a crash does; only the flag it sets tells them apart.
  expect(pool.state()).toEqual([]);
});

/**
 * The other half of the same bug: `sync` skipped any server whose row was unchanged, health
 * included, so one that died at 3am was passed over by every later sync and only a manual
 * `reconnect` brought it back.
 */
test("a later sync retries a crashed server, but not before the backoff", async () => {
  const rows = [config()];
  pool = makePool(async () => rows, 10_000);
  await pool.sync();
  const [child] = spawnedPids();

  process.kill(child as number, "SIGKILL");
  await until(() => pool.state()[0]?.status === "error", "the pool to notice the child died");

  await pool.sync();
  expect(spawned()).toBe(1);
  expect(pool.state()).toMatchObject([{ status: "error" }]);

  // Same again with no backoff to wait out, which is the 3am case once the timer has passed.
  await pool.shutdown();
  pool = makePool(async () => rows, 0);
  await pool.sync();
  const before = spawned();
  process.kill(spawnedPids().at(-1) as number, "SIGKILL");
  await until(() => pool.state()[0]?.status === "error", "the pool to notice the child died");

  await pool.sync();
  expect(spawned()).toBe(before + 1);
  expect(pool.state()).toMatchObject([{ status: "ready" }]);
  expect(toolNames(pool)).toContain("echo__ping");
});

test("a call to a tool whose server crashed brings the server back", async () => {
  pool = makePool(undefined, 0);
  await pool.sync([config()]);

  process.kill(spawnedPids()[0] as number, "SIGKILL");
  await until(() => pool.state()[0]?.status === "error", "the pool to notice the child died");

  // Not "no such tool": the tool exists, its server was merely down a moment ago.
  expect(await pool.call("echo__ping", {})).toBe("ping({})");
  expect(spawned()).toBe(2);
});

/**
 * `createTransport` spread the whole of `process.env` into every child, so an MCP server — which
 * is third-party code running as this user — was handed every database URL, API key and session
 * secret this process was started with. The inherit-everything default is kept for compatibility;
 * what matters is that narrowing it is possible and that it works.
 */
test("a stdio child inherits the whole environment by default, and only the allowlist when asked", async () => {
  const dump = path.join(dir, "env.json");
  process.env.MCP_POOL_TEST_SECRET = "sk-do-not-share";
  const inheriting = config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_ENV_DUMP: dump } });

  await pool.sync([inheriting]);
  const wide = JSON.parse(fs.readFileSync(dump, "utf8"));
  expect(wide.MCP_POOL_TEST_SECRET).toBe("sk-do-not-share");

  await pool.shutdown();
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, childEnv: MINIMAL_CHILD_ENV });
  await pool.sync([inheriting]);

  const narrow = JSON.parse(fs.readFileSync(dump, "utf8"));
  expect(narrow.MCP_POOL_TEST_SECRET).toBeUndefined();
  // The allowlist exists so a child can still find itself; a server that cannot resolve its own
  // interpreter is not a security win.
  expect(narrow.PATH).toBe(process.env.PATH);
  // Per-server env is applied on top of the policy either way, or nothing would have connected.
  expect(pool.state()).toMatchObject([{ status: "ready" }]);

  delete process.env.MCP_POOL_TEST_SECRET;
});

/**
 * The leak the startup tests all miss: those servers never start, and the SDK closes the
 * transport itself when `initialize` fails. This one starts. `connect` used to bind the client to
 * the entry only after `listTools` returned, so a server that answered the handshake and then
 * stopped answering left a child with nothing naming it — `close()` and `shutdown()` both reach a
 * child through `entry.client`, and there wasn't one.
 */
test("a server that hangs on tools/list does not leave its child behind", async () => {
  // Generous on purpose. The budget has to outlast a cold `node` start under load, or the child
  // is killed before it has run a line and the test fails at the handshake — the one stage it is
  // not about. The hang never answers, so the timeout still expires either way.
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, connectTimeoutMs: 1000 });
  await pool.sync([config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_HANG_TOOLS: "1" } })]);

  // The pool's own account of it is right either way, which is why this went unnoticed.
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "error" }]);
  expect(spawned()).toBe(1);

  const pids = spawnedPids();
  await pool.shutdown();
  expect(await stillAlive(pids)).toEqual([]);
});

/**
 * A stdio server that cannot start says why on stderr and exits. That used to go to this
 * process's console, where no status page could quote it, leaving the operator with the SDK's
 * "MCP error -32000: Connection closed" and nothing else.
 */
test("a server that dies on startup is reported with what it wrote to stderr", async () => {
  await pool.sync([
    config({
      env: {
        MCP_ECHO_SPAWN_LOG: spawnLog,
        MCP_ECHO_FAIL: "ModuleNotFoundError: no module named mcp_server_git",
      },
    }),
  ]);

  const [entry] = pool.state();
  expect(entry.status).toBe("error");
  expect(entry.error).toContain("no module named mcp_server_git");
});

/**
 * `qualify` truncates at 64 characters for OpenAI's function-name limit, so a server whose slug
 * is long enough gives several of its tools the same name and the later one silently replaces the
 * earlier in the index. Pinned rather than fixed: the fix is a short hash suffix, which changes
 * wire names for every existing server and deserves to be its own change.
 */
test("tool names too long for the limit stay distinct instead of collapsing", async () => {
  const slug = "e".repeat(62); // 62 + "__" is already the whole budget
  await pool.sync([config({ slug })]);

  const [server] = pool.catalog();
  expect(server?.tools).toHaveLength(3);

  // Three tools, three names, none over the limit. Plain truncation gave all three `${slug}__`.
  const names = server?.tools.map((tool) => tool.name) ?? [];
  expect(new Set(names).size).toBe(3);
  for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
  expect(toolNames(pool).toSorted()).toEqual(names.toSorted());

  // And each one reaches its own tool rather than whichever survived the overwrite.
  const called = await Promise.all(names.map((name) => pool.call(name, {})));
  expect(called.map((result) => result.split("(")[0]).toSorted()).toEqual(["add", "echo", "ping"]);
});

/**
 * `slug` is optional so a consumer whose ids are already namespace-shaped can hand its rows over
 * as they are. Before this it had to map every row on the way into `sync` and `reconnect`, which
 * is the one thing the structural seam in `types.ts` says a consumer should not have to do.
 */
test("a row with no slug is namespaced by its id", async () => {
  await pool.sync([config({ id: "notes", slug: undefined })]);

  expect(toolNames(pool)).toEqual(["notes__ping", "notes__echo", "notes__add"]);
  expect(await pool.call("notes__ping", {})).toBe("ping({})");
  // Reported rather than left blank: a consumer that never set one still has to be able to see
  // what its tools ended up being called.
  expect(pool.state()).toMatchObject([{ id: "notes", slug: "notes", status: "ready" }]);
  expect(pool.catalog()).toMatchObject([{ id: "notes", label: "Echo" }]);
});

/** The label falls back through the slug to the id, so no row can be introduced as `[]`. */
test("a row with neither slug nor label is labelled by its id", async () => {
  await pool.sync([config({ id: "notes", slug: undefined, label: "" })]);

  expect(pool.catalog()).toMatchObject([{ id: "notes", label: "notes" }]);
  expect(pool.tools({ names: ["notes__ping"] })[0]).toMatchObject({
    function: { description: "[notes] replies pong" },
  });
});

/**
 * The fallback the model and the catalogue already applied, now applied on the operator page too.
 * A row with an empty label was introduced to the model as `[notes]` and listed as `notes`, and
 * `state()` — the one surface an operator reads — showed an empty name for it.
 */
test("state reports the label a server is actually known by", async () => {
  await pool.sync([config({ id: "notes", slug: undefined, label: "" })]);

  expect(pool.state()).toMatchObject([{ id: "notes", slug: "notes", label: "notes" }]);
  // The row itself is still handed back exactly as it was configured.
  expect(pool.state()[0]?.config.label).toBe("");
});

/**
 * On-demand loading is driven by a model naming the tools it wants, and a model can name one
 * twice. Two definitions under one function name is a request OpenAI rejects outright.
 */
test("a name asked for twice is offered once", async () => {
  await pool.sync([config()]);

  expect(toolNames(pool, undefined)).toHaveLength(3);
  expect(pool.tools({ names: ["echo__ping", "echo__ping", "echo__add"] })).toHaveLength(2);
  // Caller order, first mention winning.
  expect(names(pool.tools({ names: ["echo__add", "echo__ping", "echo__add"] }))).toEqual([
    "echo__add",
    "echo__ping",
  ]);
});

/** A log that keeps what it was told, for the tests that are about what the pool says. */
const capturing = () => {
  const lines: string[] = [];
  return { lines, log: { info: (line: string) => lines.push(line), error: () => {} } };
};

/**
 * Dropping the name is right — the model is simply not sent a tool, and its next call says so.
 * Saying nothing is not: a consumer holding names from before a rename watches its agent lose
 * tools one at a time with nothing in this log to explain it.
 */
test("a name no server offers is skipped, and said so", async () => {
  const { lines, log } = capturing();
  pool = new McpPool({ clientName: "mcp-pool-test", log });
  await pool.sync([config()]);

  expect(names(pool.tools({ names: ["echo__ping", "gone__tool"] }))).toEqual(["echo__ping"]);
  expect(lines.filter((line) => line.includes("no tool named"))).toEqual([
    "[mcp] no tool named gone__tool is offered",
  ]);
});

/**
 * The one miss that is not a miss. `tools()` deliberately does not connect a cold server, so a
 * lazy pool answers nothing for every name it has until something else starts one — and a line
 * per name would bury the real ones on the first turn of every run.
 */
test("a cold server's tools are not reported as names nothing offers", async () => {
  const { lines, log } = capturing();
  pool = new McpPool({ clientName: "mcp-pool-test", log, lazy: true });
  await pool.sync([config()]);

  expect(pool.tools({ names: ["echo__ping"] })).toEqual([]);
  expect(lines.filter((line) => line.includes("no tool named"))).toEqual([]);
  // And a name that server could not have built is still reported, cold pool or not.
  expect(pool.tools({ names: ["gone__tool"] })).toEqual([]);
  expect(lines.filter((line) => line.includes("no tool named"))).toHaveLength(1);
});

/**
 * `tools(names, servers)` took two collections of strings, so transposing them was not a type
 * error — and the answer to a swap is an empty array, which is also the correct answer for a run
 * scoped to servers that offer nothing. A consumer adopting the pool did exactly that: it
 * compiled, connected, and offered its model no tools at all, and only a test on the result
 * caught it. The annotations are the assertion — this fails at `npm run typecheck` if either
 * shape stops being rejected.
 */
test("the two collections cannot be transposed, because they are one named object now", async () => {
  await pool.sync([config()]);

  // The annotations are the assertion — `npm run typecheck` is where this test really runs, and
  // it fails if either shape is accepted again.
  // @ts-expect-error the old positional form: the names first, the run's scope second.
  pool.tools(["echo__ping"], ["echo-1"]);
  // @ts-expect-error and the transposition of it that started this.
  pool.tools(["echo-1"], ["echo__ping"]);

  expect(names(pool.tools({ names: ["echo__ping"], servers: ["echo-1"] }))).toEqual(["echo__ping"]);
});

/**
 * A scope is the caller's own decision, applied a moment ago. Reporting what it excluded as a
 * name nothing offers would turn every scoped run into a log of its own configuration.
 */
test("a name held back by the run's scope is not reported as missing", async () => {
  const { lines, log } = capturing();
  pool = new McpPool({ clientName: "mcp-pool-test", log });
  await pool.sync([config()]);

  expect(pool.tools({ names: ["echo__ping"], servers: ["someone-else"] })).toEqual([]);
  expect(lines.filter((line) => line.includes("no tool named"))).toEqual([]);
});

/**
 * The rename path reads the slug too, and reads it twice — once to notice the change and once to
 * rebuild the names. A default applied in only one of them leaves the model offered names the
 * index no longer holds.
 */
test("giving a slugless server a slug re-qualifies its tools without restarting it", async () => {
  let rows = [config({ id: "notes", slug: undefined })];
  pool = makePool(async () => rows);
  await pool.sync();
  const [first] = spawnedPids();

  rows = [config({ id: "notes", slug: "scratch" })];
  await pool.sync();

  expect(spawned()).toBe(1);
  expect(await stillAlive([first as number])).toEqual([first]);
  expect(toolNames(pool)).toEqual(["scratch__ping", "scratch__echo", "scratch__add"]);
  expect(await pool.call("scratch__ping", {})).toBe("ping({})");
});

/**
 * The pool already knows what this process calls itself, so a consumer with a "Test connection"
 * button should not have to say it again. Repeating it is the bug: a wrapper that passes a
 * different name gives a probe one identity and the pool another, and the mismatch is visible
 * only in a remote server's logs.
 */
test("the pool probes under its own name, rather than one the caller repeats", async () => {
  const dump = path.join(dir, "probe-client.json");
  const result = await pool.probe(config({ env: { MCP_ECHO_CLIENT_DUMP: dump } }));

  expect(result).toMatchObject({ ok: true, error: "" });
  expect(result.tools.map((tool) => tool.name)).toEqual(["ping", "echo", "add"]);
  // `makePool` names this pool `mcp-pool-test`; the probe is that name, not the default.
  expect(JSON.parse(fs.readFileSync(dump, "utf8")).name).toBe("mcp-pool-test-probe");
});

/**
 * The other half of `clientInfo`, which used to be the literal `0.1.0` on every connection this
 * package made. A server logging its callers, or gating a behaviour on a client version, has
 * nothing else to read — and a constant version of a name that is the consumer's is not a
 * missing value but a wrong one.
 */
test("the version a server is told is the consumer's, on a connection and on a probe", async () => {
  const dump = path.join(dir, "client-version.json");
  pool = new McpPool({ clientName: "mcp-pool-test", clientVersion: "4.2.0", log: {} });
  await pool.sync([config({ env: { MCP_ECHO_CLIENT_DUMP: dump } })]);

  expect(JSON.parse(fs.readFileSync(dump, "utf8"))).toMatchObject({
    name: "mcp-pool-test",
    version: "4.2.0",
  });

  // The probe binds the pair, not just the name: a probe under the pool's name and someone
  // else's version is the same mismatch, visible only in the dialled server's log.
  await pool.probe(config({ env: { MCP_ECHO_CLIENT_DUMP: dump } }));
  expect(JSON.parse(fs.readFileSync(dump, "utf8"))).toMatchObject({
    name: "mcp-pool-test-probe",
    version: "4.2.0",
  });
});

/**
 * `probe` is exported for a caller with no pool, and took a bare name. It still does — the
 * version rides along in one argument rather than a second string beside the first, since two
 * adjacent strings are two a caller can swap, and the swap is only ever visible to the server.
 */
test("the free probe takes a name or a whole identity, and never invents a version", async () => {
  const dump = path.join(dir, "free-probe.json");
  const target = config({ env: { MCP_ECHO_CLIENT_DUMP: dump } });

  expect(await probe(target)).toMatchObject({ ok: true });
  expect(JSON.parse(fs.readFileSync(dump, "utf8"))).toMatchObject({
    name: "agent-mcp-pool-probe",
    version: POOL_VERSION,
  });

  expect(await probe(target, { name: "my-gateway", version: "1.4.0" })).toMatchObject({ ok: true });
  expect(JSON.parse(fs.readFileSync(dump, "utf8"))).toMatchObject({
    name: "my-gateway-probe",
    version: "1.4.0",
  });
});

/**
 * The default has to be a real version of a real thing, or it is the bug again under a new
 * number. It is read from the manifest rather than written down beside it, so this also fails if
 * that read ever stops finding the manifest and falls back.
 */
test("a pool told no version introduces itself with this package's own", async () => {
  const dump = path.join(dir, "default-version.json");
  pool = new McpPool({ log: {} });
  await pool.sync([config({ env: { MCP_ECHO_CLIENT_DUMP: dump } })]);

  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(POOL_VERSION).toBe(manifest.version);
  expect(JSON.parse(fs.readFileSync(dump, "utf8"))).toMatchObject({
    name: "agent-mcp-pool",
    version: manifest.version,
  });
});

test("a probe reports a server that will not start, rather than throwing", async () => {
  const result = await pool.probe(
    config({ env: { MCP_ECHO_FAIL: "no module named mcp_server_git" } }),
  );

  expect(result.ok).toBe(false);
  expect(result.error).toContain("no module named mcp_server_git");
  expect(result.tools).toEqual([]);
});

/**
 * A probe is what a person is waiting on. It bound the pool's name and environment policy and
 * then dialled with no timeout at all, so a pool configured to give up on a wedged server in a
 * second sat on the SDK's sixty for the same server behind a "Test connection" button.
 */
/**
 * `tools/list` is paginated and the page size is the server's choice, so a server is free to
 * answer with one tool at a time. Everything past the first page used to be dropped silently, and
 * a dropped tool is worse than a short catalogue: it is missing from the index, so `call()`
 * refuses it as a tool that does not exist.
 */
test("a server that pages its tool list is read to the end of it", async () => {
  await pool.sync([config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_PAGE_SIZE: "1" } })]);

  expect(toolNames(pool)).toEqual(["echo__ping", "echo__echo", "echo__add"]);
  // The half that matters: a tool off the last page is callable, not merely listed.
  expect(await pool.call("echo__add", { a: 1, b: 2 })).toBe('add({"a":1,"b":2})');
});

test("a probe reads every page too, rather than under-reporting a paged server", async () => {
  const result = await pool.probe(config({ env: { MCP_ECHO_PAGE_SIZE: "2" } }));

  expect(result.ok).toBe(true);
  expect(result.tools.map((tool) => tool.name)).toEqual(["ping", "echo", "add"]);
});

test("a server that repeats its cursor is failed rather than paged forever", async () => {
  await pool.sync([config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_STUCK_CURSOR: "1" } })]);

  // A truncated list is a wrong answer that looks right; a server that cannot paginate is broken.
  expect(pool.state()).toMatchObject([{ status: "error" }]);
  expect(pool.state()[0]?.error).toContain("cursor");
  expect(await stillAlive(spawnedPids())).toEqual([]);
});

test("a probe gives up on the pool's schedule, not the SDK's", async () => {
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, connectTimeoutMs: 1000 });

  const started = Date.now();
  const result = await pool.probe(
    config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_HANG_TOOLS: "1" } }),
  );

  expect(result.ok).toBe(false);
  // The budget has to cover `tools/list` and not just the dial: this server answers `initialize`
  // and then stops, which is the shape of most of what a probe is asked about.
  expect(Date.now() - started).toBeLessThan(10_000);
  // Giving up is not enough on its own — the disposable client still owns a live child.
  expect(await stillAlive(spawnedPids())).toEqual([]);
});

/**
 * The two have different audiences. A reconcile of thirty servers at boot can afford to be
 * patient; a person who has just pressed a button cannot.
 */
test("probeTimeoutMs makes a probe more impatient than a boot", async () => {
  pool = new McpPool({
    clientName: "mcp-pool-test",
    log: {},
    connectTimeoutMs: 30_000,
    probeTimeoutMs: 1000,
  });

  const started = Date.now();
  const result = await pool.probe(
    config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_HANG_TOOLS: "1" } }),
  );

  expect(result.ok).toBe(false);
  // Thirty seconds if the probe had taken the boot's budget, sixty if it had taken the SDK's.
  expect(Date.now() - started).toBeLessThan(10_000);
});

/**
 * Connect cost belongs to the server, not to the pool: `uvx some-server@latest` on a cold cache
 * downloads a package before it says anything, and a local `node` child is up in milliseconds.
 * One pool-wide number has to be the maximum of those, which leaves the wedged fast server —
 * the case the option exists for — hanging for as long as the slow one legitimately needs.
 */
test("a row's connectTimeoutMs overrides the pool's", async () => {
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, connectTimeoutMs: 30_000 });
  await pool.sync([
    config({
      connectTimeoutMs: 1000,
      env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_HANG_TOOLS: "1" },
    }),
  ]);

  // Thirty seconds if the row had been ignored, and the sync would still be running.
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "error" }]);
  expect(await stillAlive(spawnedPids())).toEqual([]);
});

test("a row with no connectTimeoutMs still takes the pool's", async () => {
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, connectTimeoutMs: 1000 });
  // `null` is the same absence as an unset field — what a row loaded from a database column says.
  await pool.sync([
    config({
      connectTimeoutMs: null,
      env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_HANG_TOOLS: "1" },
    }),
  ]);

  expect(pool.state()).toMatchObject([{ slug: "echo", status: "error" }]);
});

/**
 * The point of putting it on the row rather than making the pool option mutable: a consumer whose
 * configuration is hand-editable resolves it per row at every reconcile, and the edit has to land
 * without bouncing a healthy child that is answering calls.
 */
test("an edited connect timeout applies to the next connect without restarting the child", async () => {
  await pool.sync([config()]);
  await pool.sync([config({ connectTimeoutMs: 5000 })]);

  expect(spawned()).toBe(1);
  expect(pool.state()).toMatchObject([{ status: "ready", config: { connectTimeoutMs: 5000 } }]);
});

/**
 * A probe is the same dial, so a row that needs two minutes to start needs them behind the "Test
 * connection" button too — otherwise the button reports a failure for a server that works.
 */
test("a probe takes the row's connect timeout over the pool's probe timeout", async () => {
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, probeTimeoutMs: 30_000 });

  const started = Date.now();
  const result = await pool.probe(
    config({
      connectTimeoutMs: 1000,
      env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_HANG_TOOLS: "1" },
    }),
  );

  expect(result.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await stillAlive(spawnedPids())).toEqual([]);
});

/**
 * `connectTimeoutMs` is sold as what a boot can afford to stall for, and it was handed to each
 * request separately — `initialize`, then a `tools/list` per page. Page size is the server's
 * choice, so the real ceiling was `timeout × (1 + pages)`: a ten-page server answering each page
 * just inside a 10s limit stalled a reconcile for a minute and a half, and nothing errored, so it
 * read as a slow pool rather than as a timeout that did not apply.
 */
test("a connect timeout bounds the whole connect, not each page of tools/list", async () => {
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, connectTimeoutMs: 600 });
  // Three pages at 300ms: every one of them answers inside the 600ms a per-request reading would
  // have given it, and together they cannot fit in the budget.
  await pool.sync([
    config({
      env: {
        MCP_ECHO_SPAWN_LOG: spawnLog,
        MCP_ECHO_PAGE_SIZE: "1",
        MCP_ECHO_PAGE_DELAY_MS: "300",
      },
    }),
  ]);

  // A short tool list is the wrong answer here: a tool missing from the index is one `call()`
  // refuses as a tool that does not exist, so an overrun has to fail as a timeout.
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "error" }]);
  expect(pool.state()[0]?.error).toMatch(/timed out/i);
  expect(toolNames(pool)).toEqual([]);
  expect(await stillAlive(spawnedPids())).toEqual([]);
});

test("a paginated server that fits inside the budget still connects", async () => {
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, connectTimeoutMs: 30_000 });
  await pool.sync([
    config({
      env: {
        MCP_ECHO_SPAWN_LOG: spawnLog,
        MCP_ECHO_PAGE_SIZE: "1",
        MCP_ECHO_PAGE_DELAY_MS: "50",
      },
    }),
  ]);

  // The deadline is spent down across the pages, so the walk must not start each one poorer than
  // it is: a budget subtracted twice would fail a server with time to spare.
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "ready" }]);
  expect(toolNames(pool)).toEqual(["echo__ping", "echo__echo", "echo__add"]);
});

test("a probe's timeout covers its whole walk too", async () => {
  const started = Date.now();
  const result = await probe(
    config({
      connectTimeoutMs: 600,
      env: {
        MCP_ECHO_SPAWN_LOG: spawnLog,
        MCP_ECHO_PAGE_SIZE: "1",
        MCP_ECHO_PAGE_DELAY_MS: "300",
      },
    }),
  );

  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/timed out/i);
  // The button is what a person is waiting on, so the multiplier is worse here than at boot.
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await stillAlive(spawnedPids())).toEqual([]);
});

/**
 * The free `probe` is the one a caller with no pool has, and it read only its own options — so
 * the field `McpConnection` was widened to carry was dropped by the very function the widening
 * was for, and a row that says it needs two minutes to start was failed at the SDK's sixty
 * seconds behind the button.
 */
test("the free probe takes the row's own connect timeout", async () => {
  const started = Date.now();
  const result = await probe(
    config({
      connectTimeoutMs: 1000,
      env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_HANG_TOOLS: "1" },
    }),
  );

  expect(result.ok).toBe(false);
  // Sixty seconds if the row had been ignored, which is the SDK's own default.
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await stillAlive(spawnedPids())).toEqual([]);
});

test("an explicit timeoutMs outranks the row's connect timeout", async () => {
  const started = Date.now();
  const result = await probe(
    config({
      connectTimeoutMs: 30_000,
      env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_HANG_TOOLS: "1" },
    }),
    undefined,
    { timeoutMs: 1000 },
  );

  expect(result.ok).toBe(false);
  // Thirty seconds if the row had won: an argument at the call site is about this one probe.
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("a ready server with no tools is kept out of the catalogue but not out of state", async () => {
  await pool.sync([
    config({ id: "empty", slug: "empty", env: { MCP_ECHO_NO_TOOLS: "1" } }),
    config({ id: "echo-1", slug: "echo" }),
  ]);

  // Listed empty, it is not inert: a catalogue holding one such entry is not an empty catalogue,
  // so a prompt builder that short-circuits on emptiness introduces a list of nothing instead.
  expect(pool.catalog().map((server) => server.id)).toEqual(["echo-1"]);
  expect(pool.catalog(["empty"])).toEqual([]);

  // The operator still wants to see it, and it is genuinely ready rather than broken.
  expect(pool.state()).toMatchObject([
    { slug: "empty", status: "ready", error: "", tools: [] },
    { slug: "echo", status: "ready" },
  ]);
});

test("a stdio server starts in the cwd its config names", async () => {
  const dump = path.join(dir, "cwd.txt");
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pool-cwd-"));
  await pool.sync([config({ cwd: elsewhere, env: { MCP_ECHO_CWD_DUMP: dump } })]);

  // A server that resolves a relative path — a filesystem root, a sqlite file — against its cwd
  // reaches different data depending on this, and had no way to say where it wanted to be.
  expect(fs.realpathSync(fs.readFileSync(dump, "utf8"))).toBe(fs.realpathSync(elsewhere));
  expect(fs.realpathSync(elsewhere)).not.toBe(fs.realpathSync(process.cwd()));
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

test("editing only the cwd restarts the server, since it is part of the connection", async () => {
  let rows = [config()];
  pool = makePool(async () => rows);
  await pool.sync();

  // A no-op sync first: an optional field absent on both rows must not read as a difference.
  await pool.sync();
  expect(spawned()).toBe(1);

  rows = [config({ cwd: dir })];
  await pool.sync();
  expect(spawned()).toBe(2);
});

test("notifications from a server reach a subscriber, tagged with which server sent them", async () => {
  const heard: [string, string][] = [];
  const stop = pool.onNotification((id, notification) =>
    heard.push([id, notification.method as string]),
  );

  await pool.sync([config({ env: { MCP_ECHO_NOTIFY: "a tool appeared" } })]);
  // The SDK handles none of these itself, so before the fallback handler they were dropped: a
  // server that gained a tool at runtime was invisible to anyone relaying the protocol onward.
  await until(() => heard.length > 0, "the list_changed notification");
  expect(heard).toEqual([["echo-1", "notifications/tools/list_changed"]]);

  stop();
  const before = heard.length;
  await pool.sync([config({ id: "second", slug: "two", env: { MCP_ECHO_NOTIFY: "again" } })]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(heard.length).toBe(before);
});

test("client() reaches protocol the agent surface cannot express", async () => {
  await pool.sync([config()]);
  const client = await pool.client("echo-1");

  // Resources, prompts, subscriptions and logging have no route through `tools`/`call` at all.
  const { resources } = await client.listResources();
  expect(resources.map((resource) => resource.uri)).toEqual(["echo://greeting"]);
  const read = await client.readResource({ uri: "echo://greeting" });
  expect(read.contents[0]).toMatchObject({ text: "hello from a resource" });
});

test("client() keeps a tool result that call() has to flatten away", async () => {
  await pool.sync([config()]);

  // The agent loop's own surface is unchanged and still right for it: a string is what goes back
  // into a message array. It is the only thing a string can be, though.
  expect(await pool.call("echo__echo", { image: true })).toBe("[image content]");

  const result = await (await pool.client("echo-1")).callTool({
    name: "echo",
    arguments: { image: true },
  });
  expect(result.content).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
});

/**
 * The blocks that carry text carry it somewhere other than `block.text`, and a flattening written
 * on the type alone reported an answer the server did send as one it did not.
 */
test("call() keeps the text and uris a server answers with", async () => {
  await pool.sync([config()]);

  expect(await pool.call("echo__echo", { resource: true })).toBe("hello from an embedded resource");
  expect(await pool.call("echo__echo", { link: true })).toBe(
    "[resource_link echo://greeting — greeting: a greeting to read]",
  );
  // "(no output)" is what this used to be: a server with an `outputSchema` answers with structure
  // and no content, and the answer is in `structuredContent`.
  expect(await pool.call("echo__echo", { structured: true })).toBe(
    '{"greeting":"hello","tools":3}',
  );
});

/**
 * `initialize` returns `instructions` and `capabilities` beside `serverInfo`, and the SDK client
 * caches both. Reaching them through `client()` means dialling: that door connects an idle server
 * by design, so under `lazy` or with reaping on, building a system prompt spawned children.
 */
test("state() reports the instructions and capabilities the handshake returned", async () => {
  await pool.sync([
    config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_INSTRUCTIONS: "resolve ids first" } }),
  ]);

  expect(pool.state()[0]).toMatchObject({
    status: "ready",
    instructions: "resolve ids first",
    // What a consumer needs to know whether `resources/list` on a `client()` is worth attempting.
    capabilities: { tools: {}, resources: {} },
  });
  // No second child: both are cached reads of the handshake the connect already made.
  expect(spawned()).toBe(1);
});

test("a server that sends no instructions reports none rather than an empty string", async () => {
  await pool.sync([config()]);

  expect(pool.state()[0]?.instructions).toBeUndefined();
  expect(pool.state()[0]?.capabilities).toMatchObject({ tools: {} });
});

test("both describe the connection, so they go when it does", async () => {
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, lazy: true });
  const row = config({ env: { MCP_ECHO_INSTRUCTIONS: "resolve ids first" } });
  await pool.sync([row]);

  // Registered and not dialled: there is no handshake to report, and reporting one from a
  // previous connection would name a server that is not running.
  expect(pool.state()[0]).toMatchObject({ status: "idle" });
  expect(pool.state()[0]?.instructions).toBeUndefined();
  expect(pool.state()[0]?.capabilities).toBeUndefined();

  await pool.call("echo__ping", {});
  expect(pool.state()[0]?.instructions).toBe("resolve ids first");

  await pool.stop("echo-1");
  expect(pool.state()[0]?.instructions).toBeUndefined();
});

/**
 * Unlike `tools`, these cost nothing to hold — and a consumer that turned indexing off is a
 * gateway proxying the protocol, which is exactly the one that needs to know what it may proxy.
 */
test("indexTools: false keeps the tool index empty and still reports the handshake", async () => {
  pool = new McpPool({ clientName: "mcp-pool-test", log: {}, indexTools: false });
  await pool.sync([config({ env: { MCP_ECHO_INSTRUCTIONS: "resolve ids first" } })]);

  expect(pool.state()[0]).toMatchObject({
    tools: [],
    instructions: "resolve ids first",
    capabilities: { resources: {} },
  });
});

test("a probe reports the instructions a row's server sends, and none when it fails", async () => {
  const found = await pool.probe(config({ env: { MCP_ECHO_INSTRUCTIONS: "resolve ids first" } }));
  expect(found).toMatchObject({ ok: true, instructions: "resolve ids first" });

  // "Test connection" is where an operator finds out what a row offers, and a row that offers
  // nothing has no instructions to show either.
  const failed = await pool.probe(config({ env: { MCP_ECHO_FAIL: "no module named mcp" } }));
  expect(failed).toMatchObject({ ok: false, instructions: "" });
});

test("client() refuses a server that is disabled or not configured at all", async () => {
  await pool.sync([config({ enabled: false })]);

  // Off is not the same as unscoped: `call` answers an out-of-scope tool as one that does not
  // exist so a model stops asking, but a proxy asking for a server by id wants the reason.
  await expect(pool.client("echo-1")).rejects.toThrow(/disabled/);
  await expect(pool.client("nope")).rejects.toThrow(/no MCP server is configured/);
});

test("client() brings back a server that is merely down, the way call() does", async () => {
  const once = path.join(dir, "failed-once");
  pool = makePool(undefined, 0);
  await pool.sync([config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_FAIL_ONCE: once } })]);
  expect(pool.state()).toMatchObject([{ status: "error" }]);

  // Handing back a down server as if it were unconfigured would push a proxy into rebuilding the
  // pool over a child that only needed starting again.
  const { tools } = await (await pool.client("echo-1")).listTools();
  expect(tools).toHaveLength(3);
  expect(spawned()).toBe(2);
  fs.rmSync(once, { force: true });
});

test("client() reports a server that stays down, rather than one that is not configured", async () => {
  await pool.sync([config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_FAIL: "boom" } })]);

  // The stderr tail is the whole reason the pool keeps one: "boom" beats "connection closed".
  await expect(pool.client("echo-1")).rejects.toThrow(/is not connected: boom/);
});

test("client() says which of its refusals this is, rather than only what went wrong", async () => {
  await pool.sync([config({ enabled: false })]);

  expect((await refusal(pool.client("nope"))).code).toBe("unknown-server");
  expect((await refusal(pool.client("echo-1"))).code).toBe("disabled");
});

/**
 * The pair worth telling apart, and the two the message cannot: both read "is not connected", and
 * a caller in front of an HTTP API answers 502 to a dial that just failed and 503 — retry
 * shortly — to one it did not make because a failure 900ms ago is still inside its backoff.
 */
test("client() tells a backoff apart from a connect that failed on this call", async () => {
  const broken = config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_FAIL: "boom" } });
  pool = makePool(undefined, 60_000);
  await pool.sync([broken]);

  const held = await refusal(pool.client("echo-1"));
  expect(held.code).toBe("backoff");
  expect(held.retryAt).toBeGreaterThan(Date.now());
  expect(held.detail).toContain("boom");
  // The backoff is the point: nothing was dialled for this call.
  expect(spawned()).toBe(1);

  // No backoff to hold it off, so this one does dial, and does fail.
  await pool.shutdown();
  pool = makePool(undefined, 0);
  await pool.sync([broken]);
  const failed = await refusal(pool.client("echo-1"));
  expect(failed.code).toBe("connect-failed");
  expect(failed.retryAt).toBeUndefined();
  expect(failed.detail).toContain("boom");
});

test("a refused call says whether the tool is missing or merely out of this run's scope", async () => {
  await pool.sync([config()]);

  const missing = await refusal(pool.call("echo__nope", {}));
  const unscoped = await refusal(pool.call("echo__ping", {}, []));

  expect(missing.code).toBe("unknown-tool");
  expect(unscoped.code).toBe("out-of-scope");
  expect(unscoped.serverId).toBe("echo-1");
  // The model is told the same thing either way: a run must not learn that a server it was not
  // scoped to exists.
  expect(missing.message).toMatch(/no connected MCP server offers a tool called/);
  expect(unscoped.message).toMatch(/no connected MCP server offers a tool called/);
});

/** A pool with the lifecycle options under test; silent for the same reason `makePool` is. */
const lazyPool = (over: Partial<ConstructorParameters<typeof McpPool>[0]> = {}) =>
  new McpPool({ clientName: "mcp-pool-test", log: {}, lazy: true, ...over });

test("a lazy pool registers a server without starting it, and starts it on use", async () => {
  pool = lazyPool();
  await pool.sync([config()]);

  // The reconcile still happened — the entry is there and complete — only the child is deferred.
  expect(pool.state()).toMatchObject([{ slug: "echo", status: "idle", error: "", tools: [] }]);
  expect(spawned()).toBe(0);
  // The known limitation: nothing has listed a cold server's tools, so it offers none yet.
  expect(pool.tools()).toEqual([]);
  expect(pool.catalog()).toEqual([]);

  expect(await pool.call("echo__ping", {})).toBe("ping({})");
  expect(spawned()).toBe(1);
  expect(pool.state()).toMatchObject([{ status: "ready" }]);
  expect(toolNames(pool)).toContain("echo__ping");
});

/**
 * `wake` narrows which cold servers to start by testing each configured slug against the name it
 * was asked for. A default read only where names are *built* would leave a slugless server's own
 * name unclaimed by it, so the pool would wake every other server and still not find the tool.
 */
test("a cold server with no slug is woken by a name its id claims", async () => {
  pool = lazyPool();
  await pool.sync([config({ id: "notes", slug: undefined }), config({ id: "other" })]);

  expect(await pool.call("notes__ping", {})).toBe("ping({})");
  // The one that claims the name, and only that one.
  expect(spawned()).toBe(1);
});

/**
 * What a model inventing a tool name used to cost. `wake` had no way to rule a cold server out —
 * a slug long enough to be truncated out of its own names defeats the prefix test — so a name
 * nothing claimed woke *every* configured server, one after another, and then failed the call
 * anyway. Four servers here; a gateway with thirty pays thirty child processes for one typo.
 */
test("a name no server could have built starts nothing", async () => {
  pool = lazyPool();
  await pool.sync([
    config({ id: "alpha", slug: "alpha" }),
    config({ id: "beta", slug: "beta" }),
    config({ id: "gamma", slug: "gamma" }),
  ]);

  await expect(pool.call("totally__made_up", {})).rejects.toThrow(/no connected MCP server/);
  expect(spawned()).toBe(0);
  expect(pool.state()).toMatchObject([{ status: "idle" }, { status: "idle" }, { status: "idle" }]);
});

/**
 * The case the old wake-everything fallback existed for, now answered precisely. A slug this long
 * is cut into by `qualify`, so its tools' names do not start with `<slug>__` and no prefix test
 * can claim them — but `couldQualify` compares what survived the truncation.
 */
test("a cold server whose slug is truncated out of its own names is still woken", async () => {
  const slug = "s".repeat(60);
  pool = lazyPool();
  await pool.sync([config({ id: "long", slug }), config({ id: "other", slug: "other" })]);

  const name = qualify(slug, "ping");
  expect(name.startsWith(`${slug}${SEPARATOR}`)).toBe(false);

  expect(await pool.call(name, {})).toBe("ping({})");
  // The one that could have built it, and not the one that could not.
  expect(spawned()).toBe(1);
});

test("a second sync leaves an idle server idle rather than dialling it", async () => {
  pool = lazyPool();
  await pool.sync([config()]);
  await pool.sync([config()]);

  // Reconnecting a server nothing has asked for is exactly what lazy is for not doing.
  expect(spawned()).toBe(0);
  expect(pool.state()).toMatchObject([{ status: "idle" }]);
});

test("two calls arriving together on a cold server start one child", async () => {
  pool = lazyPool();
  await pool.sync([config()]);

  const both = await Promise.all([pool.call("echo__ping", {}), pool.call("echo__add", {})]);
  expect(both[0]).toBe("ping({})");
  // Without the queue, both callers find the server idle and both dial it; the second's entry
  // replaces the first's and the first child is left running with nothing holding it.
  expect(spawned()).toBe(1);
});

test("client() starts a cold server for a consumer that knows which one it wants", async () => {
  pool = lazyPool();
  await pool.sync([config()]);

  const { tools } = await (await pool.client("echo-1")).listTools();
  expect(tools).toHaveLength(3);
  expect(spawned()).toBe(1);
});

test("an unused server is closed, and the next call brings it back", async () => {
  // A backoff far longer than the test, to prove a reap is not treated as a crash.
  pool = lazyPool({ lazy: false, idleTimeoutMs: 50, crashBackoffMs: 60_000 });
  await pool.sync([config()]);
  const [first] = spawnedPids();

  await until(() => pool.state()[0]?.status === "idle", "the idle reap");
  expect(await stillAlive([first as number])).toEqual([]);
  // A success path: no error to explain, no failure time to wait out.
  expect(pool.state()).toMatchObject([{ status: "idle", error: "", tools: [] }]);
  expect(pool.tools()).toEqual([]);

  // Immediately, despite the minute-long backoff, because none applies to a server that is fine.
  expect(await pool.call("echo__ping", {})).toBe("ping({})");
  expect(spawned()).toBe(2);
});

test("use restarts the idle clock instead of letting it run out under load", async () => {
  pool = lazyPool({ lazy: false, idleTimeoutMs: 150 });
  await pool.sync([config()]);

  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await pool.call("echo__ping", {});
  }
  // Nearly a second and a half of steady use: reaping here would close a server mid-conversation.
  expect(pool.state()).toMatchObject([{ status: "ready" }]);
  expect(spawned()).toBe(1);
});

test("a server can opt out of reaping, or set its own timeout", async () => {
  pool = lazyPool({ lazy: false, idleTimeoutMs: 50 });
  // 0 rather than absent: absent means "use the pool's", which is what the other server does.
  await pool.sync([
    config({ id: "kept", slug: "kept", idleTimeoutMs: 0 }),
    config({ id: "reaped", slug: "reaped" }),
  ]);

  await until(
    () => pool.state().some((entry) => entry.slug === "reaped" && entry.status === "idle"),
    "the reap of the server that did not opt out",
  );
  expect(pool.state().find((entry) => entry.slug === "kept")).toMatchObject({ status: "ready" });
});

/**
 * The gateway's pool: it proxies `tools/list` straight through from the client that asked, so the
 * pool's own drain is a round trip per page for a list nobody reads.
 */
test("a pool that does not index tools connects without listing them", async () => {
  pool = lazyPool({ lazy: false, indexTools: true });
  await pool.sync([config()]);
  // What the default costs, for the contrast: one `tools/list` walk per connect, held per entry.
  expect(pool.state()).toMatchObject([{ status: "ready" }]);
  expect(pool.state()[0]?.tools).toHaveLength(3);
  await pool.shutdown();

  pool = lazyPool({ lazy: false, indexTools: false });
  await pool.sync([config()]);

  // Connected and usable — only the listing is gone.
  expect(pool.state()).toMatchObject([{ status: "ready", error: "", tools: [] }]);
  expect(pool.tools()).toEqual([]);
  expect(pool.catalog()).toEqual([]);

  // The half a proxying consumer actually uses, unaffected: the client lists its own tools when
  // the foreign client asks, with its own cursor.
  const { tools } = await (await pool.client("echo-1")).listTools();
  expect(tools.map((tool) => tool.name)).toContain("ping");
});

/**
 * The listing is work of its own, and it can fail on its own. A server that completes `initialize`
 * and then wedges on `tools/list` is one a gateway could still have proxied `resources/read` to,
 * and under the default it never reaches `ready` at all.
 */
test("a server that wedges on tools/list is still connected when nothing lists them", async () => {
  pool = lazyPool({ lazy: false, indexTools: false });
  await pool.sync([config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_HANG_TOOLS: "1" } })]);

  expect(pool.state()).toMatchObject([{ status: "ready", error: "" }]);
  const { resources } = await (await pool.client("echo-1")).listResources();
  expect(resources).toMatchObject([{ uri: "echo://greeting" }]);
});

/**
 * Under `lazy`, a name the index cannot answer wakes every server that could own it. With nothing
 * being indexed the index can never answer, so waking is a child process spawned to fail the same
 * call — the whole cost `lazy` exists to avoid, paid on every request.
 */
test("a call against an unindexed pool is refused without starting anything", async () => {
  pool = lazyPool({ indexTools: false });
  await pool.sync([config()]);

  const error = await pool.call("echo__ping", {}).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(McpPoolError);
  expect((error as McpPoolError).code).toBe("unknown-tool");
  expect(spawned()).toBe(0);
  expect(pool.state()).toMatchObject([{ status: "idle" }]);
});

/**
 * The wake path used to run before the scope check and without it: a run scoped to one server
 * that named another's tool spawned that server's child, drained its tool list, and only then
 * answered "no server offers that". The refusal was right and everything before it was not — a
 * process started for a run that may not reach it, and a latency difference that tells the caller
 * the server exists.
 */
test("a scoped call does not start a server the run cannot reach", async () => {
  pool = lazyPool();
  await pool.sync([config({ id: "alpha", slug: "alpha" }), config({ id: "beta", slug: "beta" })]);

  const refused = await refusal(pool.call("beta__ping", {}, ["alpha"]));

  // The same answer a run gets for a tool that does not exist, which to this run it does not.
  expect(refused.code).toBe("unknown-tool");
  expect(spawned()).toBe(0);
  expect(pool.state()).toMatchObject([
    { id: "alpha", status: "idle" },
    { id: "beta", status: "idle" },
  ]);
  expect(pool.state()[1]?.pid).toBeUndefined();
});

/**
 * `couldQualify` gated the cold servers and not the failed ones, so a crashed server was redialled
 * by traffic for any other server's tools — the one-child-per-configured-server cost that gate was
 * added to stop, paid on the other path.
 */
test("a name no server could have built does not redial a crashed one either", async () => {
  pool = makePool(undefined, 0);
  await pool.sync([config({ id: "alpha", slug: "alpha" }), config({ id: "beta", slug: "beta" })]);
  const beta = () => pool.state().find((entry) => entry.id === "beta");

  process.kill(beta()?.pid as number, "SIGKILL");
  await until(() => beta()?.status === "error", "the pool to notice beta died");
  const before = spawned();

  await expect(pool.call("totally__made_up", {})).rejects.toThrow(/no connected MCP server/);
  expect(spawned()).toBe(before);
  expect(beta()).toMatchObject({ status: "error" });

  // Its own tool still brings it back: the targeting is about which names wake it, not whether.
  expect(await pool.call("beta__ping", {})).toBe("ping({})");
  expect(spawned()).toBe(before + 1);
});

/**
 * The reap's queued work used to check only that the entry was still the current one and still
 * `ready` — both of which a call arriving after the timer fired leaves true. `clearTimeout` on a
 * fired timer cancels nothing, so the use could not call the reap off, and the client was closed
 * out from under a call in flight.
 *
 * Fake timers because the window is a microtask wide: firing the clock queues the reap, and the
 * `call` below runs its `touch` synchronously before the queue is reached.
 */
test("a call landing after the idle timer fired is answered, not closed under", async () => {
  vi.useFakeTimers();
  try {
    pool = lazyPool({ lazy: false, idleTimeoutMs: 1000 });
    await pool.sync([config()]);
    expect(pool.state()).toMatchObject([{ status: "ready" }]);

    // Fires the clock, which queues the reap; the call below runs its `touch` synchronously,
    // before the queue is reached. A tool the server takes a moment over, so the reap is still
    // deciding while the call is in flight — an instant one is answered out of the pipe even as
    // the client closes, which hides the bug rather than showing it gone.
    vi.advanceTimersByTime(1000);
    const answer = pool.call("echo__echo", { sleepMs: 200 });
    vi.useRealTimers();

    expect(await answer).toBe('echo({"sleepMs":200})');
    // The reap closes on the child's exit, which is after the call resolves — so the assertions
    // that matter wait for it rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pool.state()).toMatchObject([{ status: "ready", error: "" }]);
    expect(await pool.call("echo__ping", {})).toBe("ping({})");
    expect(spawned()).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

/**
 * The cursor set catches a server that repeats itself. One minting a fresh cursor every page
 * never repeats, and with no connect timeout set there was nothing else to stop the walk.
 */
test("a server that pages forever is failed rather than walked forever", async () => {
  await pool.sync([
    config({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_ENDLESS_CURSOR: "1" } }),
  ]);

  expect(pool.state()).toMatchObject([{ status: "error" }]);
  expect(pool.state()[0]?.error).toMatch(/more than \d+ pages/);
  expect(await stillAlive(spawnedPids())).toEqual([]);
});

/**
 * Both rows are literals on purpose: a literal is what excess-property checking applies to, so
 * this is a typecheck assertion as much as a runtime one. Flat, the http row had to carry
 * `command: ""`, `args: null`, `env: null` — three fields nothing reads and a command that reads
 * as configured rather than absent — and a stdio row could compile with no command at all.
 */
test("each arm of a row carries only its own transport's fields", async () => {
  await pool.sync([
    {
      id: "echo-1",
      slug: "echo",
      label: "Echo",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: { MCP_ECHO_SPAWN_LOG: spawnLog },
    },
    {
      id: "remote",
      slug: "remote",
      label: "Remote",
      enabled: true,
      transport: "http",
      // A port nothing listens on: this arm is here to be reconciled and dialled, not to answer.
      url: "http://127.0.0.1:1/mcp",
      connectTimeoutMs: 2000,
    },
  ]);

  expect(pool.state()).toMatchObject([
    { id: "echo-1", status: "ready", config: { transport: "stdio" } },
    { id: "remote", status: "error", config: { transport: "http" } },
  ]);
  expect(await pool.call("echo__ping", {})).toBe("ping({})");
});

test("a tool that fails is a refusal with a code, not a bare error", async () => {
  await pool.sync([config()]);

  const failed = await refusal(pool.call("echo__echo", { fail: true }));

  expect(failed.code).toBe("tool-error");
  // The message is what it was before the code existed, for anything reading only that.
  expect(failed.message).toBe("the tool failed on purpose");
  expect(failed.toolName).toBe("echo__echo");
  expect(failed.serverId).toBe("echo-1");
});
