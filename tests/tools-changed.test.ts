import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test, vi } from "vitest";
import { toolsFingerprint } from "../src/fingerprint.ts";
import type { McpPool } from "../src/pool.ts";
import { canonicalJson } from "../src/shape.ts";
import { ECHO_TOOLS, echoServer, makePool, memoryRow } from "../src/testing/index.ts";
import type { PoolEvent } from "../src/types.ts";

let pool: McpPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

const schema = { type: "object" as const, properties: {} };
const tool = (name: string, over: Partial<Tool> = {}): Tool => ({
  name,
  description: `does ${name}`,
  inputSchema: schema,
  ...over,
});

/** An in-memory server whose tool list a test can replace, announcing it as a real one would. */
function changing(initial: Tool[] = ECHO_TOOLS) {
  // One array, edited in place: `echoServer` lists whatever it holds when it is asked.
  const tools = [...initial];
  let live: Server | undefined;
  return {
    build: () => {
      live = echoServer({ tools });
      return live;
    },
    server: () => live as Server,
    /** Replaces the list and sends `tools/list_changed`. */
    async set(next: Tool[]) {
      tools.splice(0, tools.length, ...next);
      await live?.sendToolListChanged();
    },
  };
}

/** A pool over one changing server and one that never changes, with every event kept. */
function watched(initial?: Tool[]) {
  const first = changing(initial);
  const events: PoolEvent[] = [];
  pool = makePool({ servers: { first: first.build, second: () => echoServer() } });
  pool.onEvent((event) => events.push(event));
  const changed = () => events.filter((event) => event.type === "tools-changed");
  return { pool, first, events, changed };
}

test("a tool the server gains after connecting is listed, offered and callable", async () => {
  const { pool, first, changed } = watched([tool("one")]);
  await pool.sync([memoryRow("first"), memoryRow("second")]);
  await expect(pool.call("first__two", {})).rejects.toMatchObject({ code: "unknown-tool" });

  await first.set([tool("one"), tool("two")]);
  await vi.waitFor(() => expect(changed()).toHaveLength(1));

  expect(await pool.call("first__two", {})).toBe("two({})");
  expect(pool.state()[0].tools.map((listed) => listed.name)).toEqual(["one", "two"]);
  expect(changed()[0]).toMatchObject({
    serverId: "first",
    tools: 2,
    added: ["two"],
    removed: [],
    after: pool.state()[0].toolsFingerprint,
  });
});

test("a tool the server drops is refused, and the event names it", async () => {
  const { pool, first, changed } = watched([tool("one"), tool("two")]);
  await pool.sync([memoryRow("first")]);
  const before = pool.state()[0].toolsFingerprint;

  await first.set([tool("two")]);
  await vi.waitFor(() => expect(changed()).toHaveLength(1));

  await expect(pool.call("first__one", {})).rejects.toMatchObject({ code: "unknown-tool" });
  expect(changed()[0]).toMatchObject({ before, added: [], removed: ["one"], tools: 1 });
  expect(pool.state()[0].toolsFingerprint).not.toBe(before);
});

test("a re-list keeps the server's place: configuration order, then the server's own", async () => {
  const { pool, first, changed } = watched([tool("one")]);
  await pool.sync([memoryRow("first"), memoryRow("second")]);
  const secondNames = pool.tools({ servers: ["second"] }).map((def) => def.function.name);

  await first.set([tool("zero"), tool("one")]);
  await vi.waitFor(() => expect(changed()).toHaveLength(1));

  expect(pool.tools().map((def) => def.function.name)).toEqual([
    "first__zero",
    "first__one",
    ...secondNames,
  ]);
  expect(pool.catalog().map((server) => server.id)).toEqual(["first", "second"]);
});

test("a change announced that changed nothing is not reported", async () => {
  const { pool, first, changed } = watched([tool("one"), tool("two")]);
  await pool.sync([memoryRow("first")]);
  const before = pool.state()[0].toolsFingerprint;

  // The same tools in another order: the list moves, the fingerprint does not.
  await first.set([tool("two"), tool("one")]);
  await first.set([tool("one"), tool("two"), tool("three")]);
  await vi.waitFor(() => expect(changed()).toHaveLength(1));

  expect(changed()[0]).toMatchObject({ before, added: ["three"] });
});

test("a re-list that fails leaves the tools the server had", async () => {
  const errors: string[] = [];
  const first = changing([tool("one")]);
  pool = makePool({
    servers: { first: first.build },
    log: { error: (message) => errors.push(message) },
  });
  await pool.sync([memoryRow("first")]);

  first.server().setRequestHandler(ListToolsRequestSchema, () => {
    throw new Error("not just now");
  });
  await first.set([]);
  await vi.waitFor(() => expect(errors.join("\n")).toMatch(/could not list its changed tools/));

  expect(await pool.call("first__one", {})).toBe("one({})");
  expect(pool.state()[0].status).toBe("ready");
});

test("a pool that does not index does not list on a change either", async () => {
  const first = changing([tool("one")]);
  const heard: string[] = [];
  pool = makePool({ servers: { first: first.build }, indexTools: false });
  pool.onNotification((_id, notification) => heard.push(notification.method));
  await pool.sync([memoryRow("first")]);
  const list = vi.fn(() => ({ tools: [] }));
  first.server().setRequestHandler(ListToolsRequestSchema, list);

  await first.set([tool("two")]);
  await vi.waitFor(() => expect(heard).toEqual(["notifications/tools/list_changed"]));
  await pool.flush();

  expect(list).not.toHaveBeenCalled();
  expect(pool.state()[0].toolsFingerprint).toBeUndefined();
});

test("state reports the fingerprint a probe of the same server does", async () => {
  const { pool } = watched();
  await pool.sync([memoryRow("first")]);
  const probed = await pool.probe(memoryRow("first"));

  expect(pool.state()[0].toolsFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(probed.toolsFingerprint).toBe(pool.state()[0].toolsFingerprint);
  expect((await pool.probe(memoryRow("missing"))).toolsFingerprint).toBe("");

  await pool.stop("first");
  expect(pool.state()[0].toolsFingerprint).toBeUndefined();
});

test("a fingerprint ignores order and moves with anything a model or a host is told", () => {
  const base = [
    tool("read", { inputSchema: { type: "object", properties: { path: { type: "string" } } } }),
    tool("write", { annotations: { destructiveHint: false } }),
  ];
  const print = toolsFingerprint(base);

  expect(toolsFingerprint([base[1], base[0]])).toBe(print);
  expect(
    toolsFingerprint([
      // The same schema with its keys the other way round.
      { ...base[0], inputSchema: { properties: { path: { type: "string" } }, type: "object" } },
      base[1],
    ]),
  ).toBe(print);
  // What the pool fills in for a server that sent neither.
  expect(toolsFingerprint([{ name: "bare" }])).toBe(
    toolsFingerprint([{ name: "bare", description: "", inputSchema: { type: "object" } }]),
  );
  // A display name is not what a model is told.
  expect(toolsFingerprint([{ ...base[0], title: "Read" } as Tool, base[1]])).toBe(print);

  expect(toolsFingerprint([{ ...base[0], description: "reads, and emails it" }, base[1]])).not.toBe(
    print,
  );
  expect(
    toolsFingerprint([base[0], { ...base[1], annotations: { destructiveHint: true } }]),
  ).not.toBe(print);
  expect(toolsFingerprint([base[0]])).not.toBe(print);
});

test("canonical JSON sorts keys at every depth and leaves arrays alone", () => {
  expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
    '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
  );
  expect(canonicalJson(undefined)).toBe("null");
});
