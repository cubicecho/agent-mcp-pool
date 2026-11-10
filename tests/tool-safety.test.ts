import { CallToolRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test } from "vitest";
import type { McpPool } from "../src/pool.ts";
import { echoServer, makePool, memoryRow } from "../src/testing/index.ts";
import type { HttpServerConfig } from "../src/types.ts";

let pool: McpPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

const tool = (name: string, annotations?: Tool["annotations"]): Tool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} },
  ...(annotations ? { annotations } : {}),
});

const TOOLS = [
  tool("read", { readOnlyHint: true }),
  // A read that also claims to be destructive: the spec ignores the second beside the first.
  tool("peek", { readOnlyHint: true, destructiveHint: true }),
  tool("put", { idempotentHint: true }),
  tool("append", { destructiveHint: false }),
  tool("send"),
];

const WORST = { readsOnly: false, idempotent: false, destructive: true };

/** A pool over one server offering `TOOLS`, counting what it is really asked. */
async function notes(row: Partial<HttpServerConfig> = { trustAnnotations: true }, options = {}) {
  const asked: string[] = [];
  const build = () => {
    const server = echoServer({ tools: TOOLS });
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      asked.push(request.params.name);
      return { content: [{ type: "text", text: `${request.params.name}#${asked.length}` }] };
    });
    return server;
  };
  pool = makePool({ servers: { notes: build }, ...options });
  await pool.sync([memoryRow("notes", row)]);
  return { pool, asked };
}

test("a trusted row's annotations are read as the spec reads them", async () => {
  const { pool } = await notes();

  expect(pool.toolSafety("notes__read")).toEqual({
    readsOnly: true,
    idempotent: true,
    destructive: false,
  });
  expect(pool.toolSafety("notes__peek")).toEqual({
    readsOnly: true,
    idempotent: true,
    destructive: false,
  });
  // An idempotent write is safe to deduplicate and still a write, destructive by default.
  expect(pool.toolSafety("notes__put")).toEqual({
    readsOnly: false,
    idempotent: true,
    destructive: true,
  });
  expect(pool.toolSafety("notes__append")).toEqual({
    readsOnly: false,
    idempotent: false,
    destructive: false,
  });
  expect(pool.toolSafety("notes__send")).toEqual(WORST);

  expect(TOOLS.map(({ name }) => pool.readsOnly(`notes__${name}`))).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
});

test("a row that does not trust its annotations gets the worst case for every tool", async () => {
  for (const row of [{}, { trustAnnotations: false }, { trustAnnotations: null }]) {
    const { pool } = await notes(row);
    for (const { name } of TOOLS) {
      expect(pool.toolSafety(`notes__${name}`)).toEqual(WORST);
      expect(pool.readsOnly(`notes__${name}`)).toBe(false);
    }
    await pool.shutdown();
  }
});

test("trust is read from the row as it stands, so an edit applies on the next sync", async () => {
  const { pool } = await notes({});
  expect(pool.readsOnly("notes__read")).toBe(false);

  await pool.sync([memoryRow("notes", { trustAnnotations: true })]);
  expect(pool.readsOnly("notes__read")).toBe(true);
});

test("an unknown, out-of-scope or hidden name fails closed", async () => {
  const { pool } = await notes({ trustAnnotations: true, hiddenTools: ["peek"] });

  expect(pool.toolSafety("notes__nothing")).toEqual(WORST);
  expect(pool.readsOnly("elsewhere__read")).toBe(false);
  // Absent scope is every server and empty scope is none.
  expect(pool.readsOnly("notes__read", { servers: ["notes"] })).toBe(true);
  expect(pool.readsOnly("notes__read", { servers: ["other"] })).toBe(false);
  expect(pool.readsOnly("notes__read", { servers: [] })).toBe(false);
  // To a run a hidden tool does not exist, so it is not vouched for either.
  expect(pool.toolSafety("notes__peek")).toEqual(WORST);
});

test("the result cache caches exactly the tools toolSafety calls idempotent", async () => {
  const { pool, asked } = await notes({ trustAnnotations: true }, { resultCache: {} });

  for (const { name } of TOOLS) {
    await pool.call(`notes__${name}`, {});
    await pool.call(`notes__${name}`, {});
  }

  const once = TOOLS.map(({ name }) => asked.filter((seen) => seen === name).length === 1);
  expect(once).toEqual(TOOLS.map(({ name }) => pool.toolSafety(`notes__${name}`).idempotent));
});

test("a stopped server answers from its last-known tools and is not woken to", async () => {
  const { pool } = await notes();
  await pool.stop("notes");

  expect(pool.readsOnly("notes__read")).toBe(true);
  expect(pool.state().find((server) => server.id === "notes")?.status).toBe("idle");
});
