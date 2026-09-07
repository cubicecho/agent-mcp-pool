import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect, test } from "vitest";
import { McpPool } from "../src/pool.ts";
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
const makePool = (load?: () => Promise<McpServerConfig[]>) =>
  new McpPool({ load, clientName: "mcp-pool-test", log: {} });

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

  rows = [config({ label: "Echo, renamed" })];
  // Two callers arriving together is what a batch of writes through a GraphQL hook looks like.
  // Both read the source, both compared the edited row against the entry the other had not
  // replaced yet, and both reconnected — the second's entry overwriting the first, whose child
  // stayed up with nothing left holding a handle to close it. The pool reported one tidy server
  // throughout.
  await Promise.all([pool.sync(), pool.sync()]);

  expect(pool.state()).toMatchObject([{ label: "Echo, renamed", status: "ready" }]);
  expect(spawned()).toBe(2);

  const pids = spawnedPids();
  await pool.shutdown();
  expect(await stillAlive(pids)).toEqual([]);
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

test("flush is a no-op when nothing is owed", async () => {
  await pool.sync([config()]);
  await pool.flush();

  expect(spawned()).toBe(1);
});

test("a removed server is closed and its tools stop being offered", async () => {
  await pool.sync([config()]);
  await pool.sync([]);

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
