import {
  type CallToolResult,
  ListToolsRequestSchema,
  PingRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { McpPoolOptions } from "../src/options.ts";
import type { McpPool } from "../src/pool.ts";
import { ECHO_TOOLS, echoServer, makePool, memoryRow } from "../src/testing/index.ts";
import type { PoolEvent } from "../src/types.ts";

/**
 * Everything here is measured off `Date.now()`, and only the date is faked: the SDK's own request
 * timeouts and the in-memory transport still run on real timers, so a ping that hangs really does
 * time out.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
});

let pool: McpPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
  vi.useRealTimers();
});

const MINUTE = 60_000;
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/**
 * An in-memory server that counts what it is asked, whose tool list a test can edit without the
 * server saying so, and whose ping can be made to hang on chosen connections.
 *
 * @param hangPing Given the connection's number, from 1, whether its pings go unanswered.
 */
function counted(hangPing: (connection: number) => boolean = () => false) {
  const counts = { builds: 0, lists: 0, pings: 0 };
  const tools: Tool[] = [...ECHO_TOOLS];
  const build = () => {
    const connection = ++counts.builds;
    const server = echoServer({ tools });
    server.setRequestHandler(ListToolsRequestSchema, () => {
      counts.lists += 1;
      return { tools };
    });
    server.setRequestHandler(PingRequestSchema, () => {
      counts.pings += 1;
      return hangPing(connection) ? new Promise<never>(() => {}) : {};
    });
    return server;
  };
  return { counts, tools, build };
}

/** A pool over one counted server, `first`, with every event kept. */
function watched(server: ReturnType<typeof counted>, options: McpPoolOptions = {}) {
  const events: PoolEvent[] = [];
  pool = makePool({ servers: { first: server.build }, pingTimeoutMs: 50, ...options });
  pool.onEvent((event) => events.push(event));
  const of = <T extends PoolEvent["type"]>(type: T) =>
    events.filter((event): event is Extract<PoolEvent, { type: T }> => event.type === type);
  return { pool, events, of };
}

test("a tool added without a tools/list_changed is offered once the list is older than refreshMs", async () => {
  const server = counted();
  const { pool, of } = watched(server);
  await pool.sync([memoryRow("first")]);

  server.tools.push({ name: "fresh", inputSchema: { type: "object" } });
  later(14 * MINUTE);
  pool.tools();
  await pool.flush();
  expect(server.counts.lists).toBe(1);

  later(2 * MINUTE);
  // Answered from the list as it stood: the re-list runs behind the use that noticed.
  expect(pool.tools().map((def) => def.function.name)).not.toContain("first__fresh");
  await pool.flush();

  expect(server.counts.lists).toBe(2);
  expect(of("tools-changed")).toMatchObject([
    { serverId: "first", cause: "refresh", added: ["fresh"], removed: [] },
  ]);
  expect(await pool.call("first__fresh", {})).toBe("fresh({})");
});

test("a re-list that finds the same tools moves nothing", async () => {
  const server = counted();
  const { pool, of } = watched(server);
  await pool.sync([memoryRow("first")]);
  const before = pool.tools();

  later(16 * MINUTE);
  pool.catalog();
  await pool.flush();

  expect(server.counts.lists).toBe(2);
  expect(of("tools-changed")).toEqual([]);
  // The very definitions, not equal copies: an unchanged list is not reindexed.
  expect(pool.tools()).toEqual(before);
  pool.tools().forEach((definition, i) => {
    expect(definition).toBe(before[i]);
  });
});

test("a burst of uses past refreshMs lists the server once", async () => {
  const server = counted();
  const { pool } = watched(server);
  await pool.sync([memoryRow("first")]);

  later(16 * MINUTE);
  pool.tools();
  pool.catalog();
  await Promise.all([pool.call("first__ping", {}), pool.call("first__ping", {})]);
  await pool.flush();

  expect(server.counts.lists).toBe(2);
});

test("a refresh never wakes a server that is not connected", async () => {
  const server = counted();
  const { pool } = watched(server, { lazy: true });
  await pool.sync([memoryRow("first")]);

  later(60 * MINUTE);
  pool.tools();
  pool.catalog();
  pool.search("echo");
  await pool.flush();

  expect(server.counts.builds).toBe(0);
  expect(pool.state()[0].status).toBe("idle");
});

test("refreshMs on the row overrides the pool's, and 0 turns it off", async () => {
  const server = counted();
  const { pool } = watched(server, { refreshMs: MINUTE });
  await pool.sync([memoryRow("first", { refreshMs: 0 })]);

  later(60 * MINUTE);
  pool.tools();
  await pool.flush();
  expect(server.counts.lists).toBe(1);

  await pool.sync([memoryRow("first", { refreshMs: null })]);
  pool.tools();
  await pool.flush();
  expect(server.counts.lists).toBe(2);
});

test("a call on a connection that has heard nothing for pingAfterMs pings first", async () => {
  const server = counted();
  const { pool } = watched(server);
  await pool.sync([memoryRow("first")]);

  later(4 * MINUTE);
  expect(await pool.call("first__ping", {})).toBe("ping({})");
  expect(server.counts.pings).toBe(0);

  // The answer above was the server talking, so the quiet is measured from it.
  later(4 * MINUTE);
  await pool.call("first__ping", {});
  expect(server.counts.pings).toBe(0);

  later(6 * MINUTE);
  expect(await pool.call("first__ping", {})).toBe("ping({})");
  expect(server.counts.pings).toBe(1);
  expect(server.counts.builds).toBe(1);
});

test("a quiet connection that does not answer its ping is redialled, and the call goes to the new one", async () => {
  const server = counted((connection) => connection === 1);
  const { pool, of } = watched(server);
  await pool.sync([memoryRow("first")]);

  later(6 * MINUTE);
  const [first, second] = await Promise.all([
    pool.call("first__echo", { text: "hi" }),
    pool.call("first__ping", {}),
  ]);

  expect(first).toBe('echo({"text":"hi"})');
  expect(second).toBe("ping({})");
  // One ping for the two calls, and one redial.
  expect(server.counts.pings).toBe(1);
  expect(server.counts.builds).toBe(2);
  expect(of("ping-failed")).toMatchObject([{ serverId: "first", error: expect.any(String) }]);
  expect(of("close")).toMatchObject([{ serverId: "first", reason: "redial" }]);
  expect(of("connect")).toHaveLength(2);
  expect(pool.state()[0]).toMatchObject({ status: "ready", error: "" });
});

test("a server that answers a ping with an error is alive", async () => {
  const server = counted();
  pool = makePool({
    servers: {
      first: () => {
        const built = server.build();
        built.setRequestHandler(PingRequestSchema, () => {
          throw new Error("no pings here");
        });
        return built;
      },
    },
    pingTimeoutMs: 50,
  });
  await pool.sync([memoryRow("first")]);

  later(6 * MINUTE);
  expect(await pool.call("first__ping", {})).toBe("ping({})");
  expect(server.counts.builds).toBe(1);
});

test("a refresh on a quiet connection pings, and redials one that does not answer", async () => {
  const server = counted((connection) => connection === 1);
  const { pool, of } = watched(server);
  await pool.sync([memoryRow("first")]);
  server.tools.push({ name: "fresh", inputSchema: { type: "object" } });

  later(16 * MINUTE);
  pool.catalog();
  await vi.waitFor(() => expect(of("connect")).toHaveLength(2));
  await pool.flush();

  expect(of("ping-failed")).toHaveLength(1);
  // The redial listed the tools itself, and reports what moved as a reconnect.
  expect(of("tools-changed")).toMatchObject([{ cause: "reconnect", added: ["fresh"] }]);
  expect(await pool.call("first__fresh", {})).toBe("fresh({})");
});

test("pingAfterMs 0 on the row sends no ping however quiet the connection", async () => {
  const server = counted(() => true);
  const { pool } = watched(server);
  await pool.sync([memoryRow("first", { pingAfterMs: 0 })]);

  later(60 * MINUTE);
  expect(await pool.call("first__ping", {})).toBe("ping({})");
  expect(server.counts.pings).toBe(0);
});

test("a prompt listing goes through the same check as a call", async () => {
  const server = counted((connection) => connection === 1);
  const { pool, of } = watched(server);
  await pool.sync([memoryRow("first")]);

  later(6 * MINUTE);
  await expect(pool.use("first", (client) => client.listTools())).resolves.toMatchObject({
    tools: expect.any(Array),
  });
  expect(of("ping-failed")).toHaveLength(1);
  expect(server.counts.builds).toBe(2);
});

test("a connection past maxConnectionAgeMs is recycled before the next call, which it answers", async () => {
  const server = counted();
  const { pool, of } = watched(server, { maxConnectionAgeMs: 60 * MINUTE });
  await pool.sync([memoryRow("first")]);

  later(30 * MINUTE);
  await pool.call("first__ping", {});
  expect(server.counts.builds).toBe(1);

  later(31 * MINUTE);
  expect(await pool.call("first__echo", { text: "new" })).toBe('echo({"text":"new"})');

  expect(server.counts.builds).toBe(2);
  expect(of("close")).toMatchObject([{ serverId: "first", reason: "recycle" }]);
  // A fresh connection is a fresh clock.
  expect(pool.state()[0].startedAt).toBe(new Date(Date.now()).toISOString());
});

test("a connection that ages with calls in flight is recycled once they are done, not under them", async () => {
  const server = counted();
  const { pool, of } = watched(server, { maxConnectionAgeMs: 60 * MINUTE });
  await pool.sync([memoryRow("first")]);

  const slow = pool.call("first__echo", { sleepMs: 100 });
  later(61 * MINUTE);
  // Sent on the old connection: something is still in flight there, so this is not its moment.
  const alongside = pool.call("first__echo", { sleepMs: 50 });
  expect(await Promise.all([slow, alongside])).toEqual([
    'echo({"sleepMs":100})',
    'echo({"sleepMs":50})',
  ]);

  await vi.waitFor(() => expect(of("connect")).toHaveLength(2));
  expect(of("close")).toMatchObject([{ reason: "recycle" }]);
  expect(await pool.call("first__ping", {})).toBe("ping({})");
  expect(server.counts.builds).toBe(2);
});

test("maxConnectionAgeMs is off unless set", async () => {
  const server = counted();
  const { pool } = watched(server, { pingAfterMs: 0 });
  await pool.sync([memoryRow("first")]);

  later(30 * 24 * 60 * MINUTE);
  expect(await pool.call("first__ping", {})).toBe("ping({})");
  expect(server.counts.builds).toBe(1);
});

test("the row's maxConnectionAgeMs outranks the pool's", async () => {
  const server = counted();
  const { pool } = watched(server, { maxConnectionAgeMs: MINUTE });
  await pool.sync([memoryRow("first", { maxConnectionAgeMs: 0 })]);

  later(60 * MINUTE);
  const answer: CallToolResult = await pool.call("first__ping", {}, { raw: true });
  expect(answer.content).toEqual([{ type: "text", text: "ping({})" }]);
  expect(server.counts.builds).toBe(1);
});
