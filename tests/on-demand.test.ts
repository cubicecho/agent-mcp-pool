import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test, vi } from "vitest";
import { connectionFingerprint } from "../src/fingerprint.ts";
import type { McpPool } from "../src/pool.ts";
import { ECHO_TOOLS, echoServer, makePool, memoryRow } from "../src/testing/index.ts";
import type { CachedTools, PoolEvent, ToolsCache } from "../src/types.ts";

let pool: McpPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

const tool = (name: string, description = `does ${name}`): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

/** A `toolsCache` over a map, counting what the pool asked of it. */
function memoryCache(seed: Record<string, CachedTools> = {}) {
  const held = new Map(Object.entries(seed));
  const saves: string[] = [];
  const cache: ToolsCache = {
    load: (id) => held.get(id),
    save: (id, tools) => {
      saves.push(id);
      held.set(id, tools);
    },
  };
  return { cache, held, saves };
}

/** Builders for in-memory servers that count how often each was started. */
function counted(tools: Record<string, Tool[]>) {
  const started: Record<string, number> = {};
  const servers = Object.fromEntries(
    Object.keys(tools).map((name) => [
      name,
      () => {
        started[name] = (started[name] ?? 0) + 1;
        return echoServer({ tools: tools[name] });
      },
    ]),
  );
  return { servers, started, tools };
}

const names = (from: McpPool) => from.tools().map((definition) => definition.function.name);
const cachedFor = (id: string, tools: Tool[]): CachedTools => ({
  connection: connectionFingerprint(memoryRow(id)),
  tools,
});

test("a lazy pool offers a cold server's cached tools, and a call to one starts it", async () => {
  const { servers, started } = counted({ echo: ECHO_TOOLS });
  const { cache } = memoryCache({ echo: cachedFor("echo", ECHO_TOOLS) });
  pool = makePool({ servers, lazy: true, toolsCache: cache });

  await pool.sync([memoryRow("echo")]);

  // Everything a model needs to ask for the tool, with no child behind it.
  expect(started).toEqual({});
  expect(names(pool)).toContain("echo__ping");
  expect(pool.catalog()).toMatchObject([{ id: "echo", stale: true }]);
  expect(pool.state()).toMatchObject([{ status: "idle", stale: true }]);
  expect(pool.describe("echo__ping")).toMatchObject({ serverId: "echo", name: "ping" });
  expect(started).toEqual({});

  expect(await pool.call("echo__ping", {})).toBe("ping({})");

  expect(started).toEqual({ echo: 1 });
  expect(pool.state()[0]?.stale).toBeUndefined();
  expect(pool.catalog()[0]?.stale).toBeUndefined();
});

test("a list cached over another connection is not this row's", async () => {
  const { servers } = counted({ echo: ECHO_TOOLS });
  const { cache } = memoryCache({
    echo: { connection: connectionFingerprint(memoryRow("elsewhere")), tools: ECHO_TOOLS },
  });
  pool = makePool({ servers, lazy: true, toolsCache: cache });

  await pool.sync([memoryRow("echo")]);

  expect(pool.tools()).toEqual([]);
  expect(pool.state()).toMatchObject([{ status: "idle", tools: [] }]);
});

test("a connect saves what the server listed, once per list", async () => {
  const { servers } = counted({ echo: ECHO_TOOLS });
  const { cache, held, saves } = memoryCache();
  pool = makePool({ servers, toolsCache: cache });

  await pool.sync([memoryRow("echo")]);
  await vi.waitFor(() => expect(saves).toEqual(["echo"]));
  expect(held.get("echo")).toEqual(cachedFor("echo", ECHO_TOOLS));

  // The same list over the same connection is already what the store holds.
  await pool.reconnect("echo", [memoryRow("echo")]);
  await pool.stop("echo");
  await pool.call("echo__ping", {});
  expect(saves).toEqual(["echo"]);
});

test("what one pool saved is what the next one starts with", async () => {
  const { servers, started } = counted({ echo: ECHO_TOOLS });
  const { cache, saves } = memoryCache();
  const first = makePool({ servers, toolsCache: cache });
  await first.sync([memoryRow("echo")]);
  await vi.waitFor(() => expect(saves).toEqual(["echo"]));
  const offered = names(first);
  await first.shutdown();

  pool = makePool({ servers, lazy: true, toolsCache: cache });
  await pool.sync([memoryRow("echo")]);

  expect(names(pool)).toEqual(offered);
  expect(started).toEqual({ echo: 1 });
});

test("a stopped server stays in the catalogue as stale, and a call clears it", async () => {
  const { servers, started } = counted({ echo: ECHO_TOOLS });
  pool = makePool({ servers });
  await pool.sync([memoryRow("echo")]);
  const before = pool.catalog();

  await pool.stop("echo");

  expect(pool.catalog()).toEqual(before.map((server) => ({ ...server, stale: true })));
  expect(pool.state()).toMatchObject([{ status: "idle", stale: true }]);

  expect(await pool.call("echo__echo", { text: "hi" })).toContain("hi");
  expect(started).toEqual({ echo: 2 });
  expect(pool.catalog()).toEqual(before);
});

test("a call that would be refused does not start the cold server to refuse it", async () => {
  const { servers, started } = counted({ echo: ECHO_TOOLS, other: ECHO_TOOLS });
  const { cache } = memoryCache({
    echo: cachedFor("echo", ECHO_TOOLS),
    other: cachedFor("other", ECHO_TOOLS),
  });
  pool = makePool({ servers, lazy: true, toolsCache: cache });
  await pool.sync([memoryRow("echo", { hiddenTools: ["ping"] }), memoryRow("other")]);

  // Hidden from the model, and outside the run's scope: both known, neither owed a child.
  await expect(pool.call("echo__ping", {})).rejects.toMatchObject({ code: "unknown-tool" });
  await expect(pool.call("other__ping", {}, { servers: ["echo"] })).rejects.toMatchObject({
    code: "out-of-scope",
  });
  expect(started).toEqual({});

  // The host's own call to the hidden tool is still a use, and starts that server alone.
  expect(await pool.call("echo__ping", {}, { hidden: true })).toBe("ping({})");
  expect(started).toEqual({ echo: 1 });
});

test("a cold server that comes back offering something else says so", async () => {
  const { servers } = counted({ echo: [tool("kept"), tool("added")] });
  const { cache } = memoryCache({ echo: cachedFor("echo", [tool("kept"), tool("gone")]) });
  pool = makePool({ servers, lazy: true, toolsCache: cache });
  const events: PoolEvent[] = [];
  pool.onEvent((event) => events.push(event));
  await pool.sync([memoryRow("echo")]);
  expect(names(pool)).toEqual(["echo__kept", "echo__gone"]);

  // The last-known list was wrong about this one, which only the server could say.
  await expect(pool.call("echo__gone", {})).rejects.toMatchObject({ code: "unknown-tool" });

  expect(names(pool)).toEqual(["echo__kept", "echo__added"]);
  expect(events.filter((event) => event.type === "tools-changed")).toMatchObject([
    { serverId: "echo", tools: 2, added: ["added"], removed: ["gone"] },
  ]);
});

test("a server that crashed keeps no last-known list", async () => {
  const live: ReturnType<typeof echoServer>[] = [];
  pool = makePool({
    servers: {
      echo: () => {
        const server = echoServer();
        live.push(server);
        return server;
      },
    },
  });
  await pool.sync([memoryRow("echo")]);

  await live[0]?.close();

  await vi.waitFor(() => expect(pool?.state()[0]?.status).toBe("error"));
  expect(pool.state()).toMatchObject([{ tools: [] }]);
  expect(pool.state()[0]?.stale).toBeUndefined();
  expect(pool.catalog()).toEqual([]);
});

test("a cache that throws costs the catalogue and nothing else", async () => {
  const { servers } = counted({ echo: ECHO_TOOLS });
  const errors: string[] = [];
  pool = makePool({
    servers,
    lazy: true,
    log: { error: (message) => errors.push(message) },
    toolsCache: {
      load: async () => {
        throw new Error("store is down");
      },
      save: () => {
        throw new Error("store is read-only");
      },
    },
  });

  await pool.sync([memoryRow("echo")]);
  expect(pool.tools()).toEqual([]);
  expect(await pool.call("echo__ping", {})).toBe("ping({})");

  expect(errors.some((message) => message.includes("store is down"))).toBe(true);
  expect(errors.some((message) => message.includes("store is read-only"))).toBe(true);
});

test("a pool that does not index neither reads nor writes the cache", async () => {
  const { servers } = counted({ echo: ECHO_TOOLS });
  const { cache, saves } = memoryCache({ echo: cachedFor("echo", ECHO_TOOLS) });
  pool = makePool({ servers, indexTools: false, toolsCache: cache });

  await pool.sync([memoryRow("echo")]);

  expect(pool.state()).toMatchObject([{ status: "ready", tools: [] }]);
  expect(saves).toEqual([]);
});
