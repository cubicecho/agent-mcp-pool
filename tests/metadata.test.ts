import { afterEach, expect, test } from "vitest";
import type { McpPool } from "../src/pool.ts";
import { probe } from "../src/probe.ts";
import { echoServer, makePool, memoryRow, memoryTransport } from "../src/testing/index.ts";

let pool: McpPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

const servers = { echo: () => echoServer(), other: () => echoServer() };
const READ_ANNOTATIONS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

test("state() and catalog() carry a tool's title and annotations", async () => {
  pool = makePool({ servers });
  await pool.sync([memoryRow("echo")]);
  const read = pool.state()[0]?.tools.find((tool) => tool.name === "read");
  expect(read).toEqual({
    name: "read",
    qualified: "echo__read",
    description: "reads a note by path",
    title: "Read a note",
    annotations: READ_ANNOTATIONS,
    hidden: false,
  });
  // A tool with neither gains no undefined keys, so an existing deep-equal still holds.
  expect(pool.state()[0]?.tools.find((tool) => tool.name === "ping")).toEqual({
    name: "ping",
    qualified: "echo__ping",
    description: "replies pong",
    hidden: false,
  });
  expect(pool.catalog()[0]?.tools.find((tool) => tool.name === "echo__read")).toEqual({
    name: "echo__read",
    description: "reads a note by path",
    title: "Read a note",
    annotations: READ_ANNOTATIONS,
  });
});

test("tools() stays OpenAI-shaped", async () => {
  pool = makePool({ servers });
  await pool.sync([memoryRow("echo")]);
  const definition = pool.tools({ names: ["echo__read"] })[0];
  expect(Object.keys(definition?.function ?? {}).sort()).toEqual([
    "description",
    "name",
    "parameters",
  ]);
});

test("describe() returns the whole tool, obeying scope and hiding", async () => {
  pool = makePool({ servers });
  await pool.sync([memoryRow("echo", { hiddenTools: ["add"] }), memoryRow("other")]);

  expect(pool.describe("echo__read")).toEqual({
    serverId: "echo",
    name: "read",
    qualified: "echo__read",
    description: "reads a note by path",
    title: "Read a note",
    annotations: READ_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
    outputSchema: { type: "object", properties: { text: { type: "string" } } },
    hidden: false,
  });
  expect(pool.describe("echo__read", { servers: ["other"] })).toBeUndefined();
  expect(pool.describe("echo__read", { servers: [] })).toBeUndefined();
  expect(pool.describe("echo__add")).toBeUndefined();
  expect(pool.describe("echo__add", { hidden: true })?.hidden).toBe(true);
  expect(pool.describe("echo__nothing")).toBeUndefined();
});

test("describe() never connects a cold server", async () => {
  let built = 0;
  pool = makePool({
    lazy: true,
    servers: {
      echo: () => {
        built++;
        return echoServer();
      },
    },
  });
  await pool.sync([memoryRow("echo")]);
  expect(pool.describe("echo__read")).toBeUndefined();
  expect(built).toBe(0);
});

test("probe() reports title and annotations", async () => {
  const result = await probe(memoryRow("echo"), "mcp-pool-test", {
    createTransport: memoryTransport(servers),
  });
  expect(result.tools.find((tool) => tool.name === "read")).toEqual({
    name: "read",
    description: "reads a note by path",
    title: "Read a note",
    annotations: READ_ANNOTATIONS,
  });
});
