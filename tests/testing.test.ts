import { afterEach, expect, test } from "vitest";
import { McpPool } from "../src/pool.ts";
import { probe } from "../src/probe.ts";
import {
  ECHO_TOOLS,
  echoServer,
  echoServerPath,
  makePool,
  memoryRow,
  memoryTransport,
} from "../src/testing/index.ts";

const pools: McpPool[] = [];
const track = (pool: McpPool) => {
  pools.push(pool);
  return pool;
};
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

test("a pool reaches an in-process server through createTransport, with no child", async () => {
  const pool = track(
    makePool({ servers: { echo: () => echoServer({ instructions: "be brief" }) } }),
  );
  await pool.sync([memoryRow("echo")]);

  const [state] = pool.state();
  expect(state?.status).toBe("ready");
  expect(state?.pid).toBeUndefined();
  expect(state?.instructions).toBe("be brief");
  expect(state?.tools.map((tool) => tool.name)).toEqual(ECHO_TOOLS.map((tool) => tool.name));
  await expect(pool.call("echo__add", { a: 1, b: 2 })).resolves.toBe('add({"a":1,"b":2})');
});

test("a reconnect builds a fresh server, since an SDK server connects once", async () => {
  let built = 0;
  const pool = track(
    makePool({
      servers: {
        echo: () => {
          built++;
          return echoServer();
        },
      },
    }),
  );
  await pool.sync([memoryRow("echo")]);
  await pool.sync([memoryRow("echo", { label: "Echo two", headers: { a: "b" } })]);
  await expect(pool.call("echo__ping", {})).resolves.toBe("ping({})");
  expect(built).toBe(2);
});

test("a row with no in-memory server fails its connect rather than throwing out of sync", async () => {
  const pool = track(makePool({ servers: {} }));
  await pool.sync([memoryRow("nowhere")]);
  const [state] = pool.state();
  expect(state?.status).toBe("error");
  expect(state?.error).toMatch(/no in-memory server/);
});

test("probe takes the same factory", async () => {
  const result = await probe(memoryRow("echo"), "mcp-pool-test", {
    createTransport: memoryTransport({ echo: () => echoServer() }),
  });
  expect(result.tools.map((tool) => tool.name)).toContain("ping");
});

test("echoServerPath serves the same tools over stdio", async () => {
  const pool = track(new McpPool({ log: {} }));
  await pool.sync([
    {
      id: "stdio",
      slug: "stdio",
      label: "Stdio",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: [echoServerPath],
    },
  ]);
  expect(pool.state()[0]?.pid).toBeTypeOf("number");
  await expect(pool.call("stdio__ping", {})).resolves.toBe("ping({})");
});
