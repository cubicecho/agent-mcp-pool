import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test } from "vitest";
import type { McpPool } from "../src/pool.ts";
import { ResultCache } from "../src/result-cache.ts";
import { echoServer, makePool, memoryRow } from "../src/testing/index.ts";
import type { PoolEvent } from "../src/types.ts";

let pool: McpPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

const tool = (name: string, annotations?: Tool["annotations"]): Tool => ({
  name,
  description: `does ${name}`,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "integer" } },
  },
  ...(annotations ? { annotations } : {}),
});

/** A read-only tool, an idempotent write, and a tool that says nothing about itself. */
const TOOLS = [
  tool("read", { readOnlyHint: true }),
  tool("put", { idempotentHint: true }),
  tool("send"),
];

/**
 * A server that numbers its answers, so one that came from memory is told from one it gave: the
 * second `read` it is really asked for says `read#2`.
 */
function numbering(tools: Tool[] = TOOLS) {
  const asked: string[] = [];
  let live: Server | undefined;
  const build = () => {
    const server = echoServer({ tools });
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      asked.push(request.params.name);
      const text = `${request.params.name}#${asked.length}`;
      return {
        content: [{ type: "text", text }],
        isError: Boolean(request.params.arguments?.fail),
      };
    });
    live = server;
    return server;
  };
  return { build, asked, tools, server: () => live as Server };
}

/** A pool with a result cache over one numbering server whose row trusts its annotations. */
async function cached(options: Parameters<typeof makePool>[0] = {}, row = {}) {
  const server = numbering();
  const events: PoolEvent[] = [];
  pool = makePool({ servers: { notes: server.build }, resultCache: {}, ...options });
  pool.onEvent((event) => events.push(event));
  await pool.sync([memoryRow("notes", { trustAnnotations: true, ...row })]);
  const calls = () => events.filter((event) => event.type === "call");
  return { pool, ...server, calls };
}

test("a read made twice is asked of the server once, and the event says which was which", async () => {
  const { pool, asked, calls } = await cached();

  expect(await pool.call("notes__read", { path: "a" })).toBe("read#1");
  expect(await pool.call("notes__read", { path: "a" })).toBe("read#1");
  expect(await pool.call("notes__read", { path: "b" })).toBe("read#2");

  expect(asked).toEqual(["read", "read"]);
  expect(calls().map((event) => event.cached)).toEqual([undefined, true, undefined]);
  expect(calls()[1]).toMatchObject({ ok: true, serverId: "notes", toolName: "read", chars: 6 });
});

test("nothing is cached without the option, without the row's trust, or without the hint", async () => {
  const off = await cached({ resultCache: undefined });
  await off.pool.call("notes__read", {});
  await off.pool.call("notes__read", {});
  expect(off.asked).toHaveLength(2);
  await off.pool.shutdown();

  // The annotations are the server's word for it, and nobody has said to take it.
  const untrusted = await cached({}, { trustAnnotations: false });
  await untrusted.pool.call("notes__read", {});
  await untrusted.pool.call("notes__read", {});
  expect(untrusted.asked).toHaveLength(2);
  await untrusted.pool.shutdown();

  const unhinted = await cached();
  await unhinted.pool.call("notes__send", {});
  await unhinted.pool.call("notes__send", {});
  expect(unhinted.asked).toEqual(["send", "send"]);
  expect(unhinted.calls().some((event) => event.cached)).toBe(false);
});

test("two spellings of the same arguments are one entry", async () => {
  const { pool, asked } = await cached();

  await pool.call("notes__read", { path: "a", limit: 5 });
  // Another key order, and a number the model wrote as a string: the same call once coerced.
  expect(await pool.call("notes__read", { limit: "5", path: "a" })).toBe("read#1");
  expect(await pool.call("notes__read", { path: "a", limit: 6 })).toBe("read#2");

  expect(asked).toHaveLength(2);
});

test("a failure is never the cached answer", async () => {
  const { pool, asked } = await cached();

  await expect(pool.call("notes__read", { fail: true })).rejects.toMatchObject({
    code: "tool-error",
  });
  await expect(pool.call("notes__read", { fail: true })).rejects.toMatchObject({
    code: "tool-error",
  });

  expect(asked).toHaveLength(2);
});

test("cache: false asks the server and keeps what it says", async () => {
  const { pool, asked } = await cached();
  await pool.call("notes__read", {});

  expect(await pool.call("notes__read", {}, { cache: false })).toBe("read#2");
  // The refresh replaced the entry rather than going around it.
  expect(await pool.call("notes__read", {})).toBe("read#2");

  expect(asked).toHaveLength(2);
});

test("a raw call is neither answered from memory nor kept in it", async () => {
  const { pool, asked } = await cached();
  await pool.call("notes__read", {});

  expect(await pool.call("notes__read", {}, { raw: true })).toMatchObject({
    content: [{ type: "text", text: "read#2" }],
  });
  expect(await pool.call("notes__read", {})).toBe("read#1");

  expect(asked).toHaveLength(2);
});

test("a call that is not read-only clears what was read before it", async () => {
  const { pool, asked } = await cached();
  await pool.call("notes__read", {});

  await pool.call("notes__send", {});

  expect(await pool.call("notes__read", {})).toBe("read#3");
  expect(asked).toEqual(["read", "send", "read"]);
});

test("an idempotent write is made once, and still clears the reads", async () => {
  const { pool, asked } = await cached();
  await pool.call("notes__read", {});

  expect(await pool.call("notes__put", { path: "a" })).toBe("put#2");
  expect(await pool.call("notes__put", { path: "a" })).toBe("put#2");
  expect(await pool.call("notes__read", {})).toBe("read#3");
  // Another value written in between, so the first is no longer what the server holds.
  await pool.call("notes__put", { path: "b" });
  expect(await pool.call("notes__put", { path: "a" })).toBe("put#5");

  expect(asked).toEqual(["read", "put", "read", "put", "put"]);
});

test("a server's answers go with its connection", async () => {
  const { pool, asked } = await cached();
  await pool.call("notes__read", {});

  await pool.stop("notes");

  expect(await pool.call("notes__read", {})).toBe("read#2");
  expect(asked).toHaveLength(2);
});

test("a server's answers go when its tools change", async () => {
  const { pool, asked, tools, server, calls } = await cached();
  await pool.call("notes__read", {});

  // In place, as `echoServer` lists whatever the array holds when it is asked.
  tools.push(tool("extra"));
  await server().sendToolListChanged();
  await expect.poll(() => pool.describe("notes__extra")).toBeDefined();
  tools.pop();

  expect(await pool.call("notes__read", {})).toBe("read#2");
  expect(asked).toHaveLength(2);
  expect(calls().some((event) => event.cached)).toBe(false);
});

test("a hit is cut to the cap of the call that asked, not the one that stored it", async () => {
  const { pool } = await cached();

  const whole = await pool.call("notes__read", {});
  const cut = await pool.call("notes__read", {}, { maxResultChars: 3 });

  expect(whole).toBe("read#1");
  expect(cut).not.toBe(whole);
  expect(await pool.call("notes__read", {})).toBe("read#1");
});

test("a cached answer is still refused to a run that may not reach the tool", async () => {
  const { pool } = await cached({}, { hiddenTools: ["put"] });
  await pool.call("notes__read", {});
  await pool.call("notes__put", {}, { hidden: true });

  await expect(pool.call("notes__read", {}, { servers: [] })).rejects.toMatchObject({
    code: "out-of-scope",
  });
  await expect(pool.call("notes__put", {})).rejects.toMatchObject({ code: "unknown-tool" });
});

test("an answer ages out", async () => {
  const { pool, asked } = await cached({ resultCache: { ttlMs: 20 } });
  await pool.call("notes__read", {});
  expect(await pool.call("notes__read", {})).toBe("read#1");

  await new Promise((done) => setTimeout(done, 40));

  expect(await pool.call("notes__read", {})).toBe("read#2");
  expect(asked).toHaveLength(2);
});

test("the cache is bounded by age and by count, least recently used first", () => {
  let now = 0;
  const cache = new ResultCache({ ttlMs: 100, maxEntries: 2 }, () => now);
  cache.set("a", "one", "1");
  cache.set("a", "two", "2");
  // Used, so it is `two` that is oldest when a third arrives.
  expect(cache.get("one")).toBe("1");
  cache.set("b", "three", "3");
  expect(cache.get("two")).toBeUndefined();
  expect(cache.size).toBe(2);

  cache.clear("a");
  expect(cache.get("one")).toBeUndefined();
  expect(cache.get("three")).toBe("3");

  now = 100;
  expect(cache.get("three")).toBeUndefined();
  expect(cache.size).toBe(0);

  // 0 is no bound, on either.
  const unbounded = new ResultCache({ ttlMs: 0, maxEntries: 0 }, () => now);
  for (let i = 0; i < 500; i++) unbounded.set("a", String(i), "x");
  now = 1e12;
  expect(unbounded.size).toBe(500);
  expect(unbounded.get("0")).toBe("x");
});
