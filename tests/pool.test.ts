import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect, test } from "vitest";
import { McpPool } from "../src/pool.ts";
import { MINIMAL_CHILD_ENV } from "../src/transport.ts";
import type { McpServerConfig } from "../src/types.ts";

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

const config = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: "echo-1",
  slug: "echo",
  label: "Echo",
  enabled: true,
  transport: "stdio",
  command: process.execPath,
  args: [FIXTURE],
  env: { MCP_ECHO_SPAWN_LOG: spawnLog },
  url: "",
  headers: null,
  ...over,
});

/** Silent: these tests spawn servers that fail on purpose, and say so on stderr. */
const makePool = (load?: () => Promise<McpServerConfig[]>, crashBackoffMs?: number) =>
  new McpPool({ load, clientName: "mcp-pool-test", log: {}, crashBackoffMs });

/** The qualified names on offer. A definition is a union; only the function arm is used here. */
const toolNames = (pool: McpPool, servers?: string[]) =>
  pool.tools(undefined, servers).flatMap((t) => (t.type === "function" ? [t.function.name] : []));

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
  expect(entry?.config).toEqual(row);
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
  expect(pool.state()[0]?.config).toEqual(rows[0]);
});

test("a server the pool never dialled still reports its row", async () => {
  const row = config({ enabled: false });
  await pool.sync([row]);

  expect(pool.state()).toMatchObject([{ status: "disabled", config: row }]);
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
  expect(pool.tools(["notes__ping"])[0]).toMatchObject({
    function: { description: "[notes] replies pong" },
  });
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

test("a probe reports a server that will not start, rather than throwing", async () => {
  const result = await pool.probe(
    config({ env: { MCP_ECHO_FAIL: "no module named mcp_server_git" } }),
  );

  expect(result.ok).toBe(false);
  expect(result.error).toContain("no module named mcp_server_git");
  expect(result.tools).toEqual([]);
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
