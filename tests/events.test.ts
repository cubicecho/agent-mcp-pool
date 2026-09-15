import { afterEach, expect, test } from "vitest";
import type { McpPool } from "../src/pool.ts";
import { echoServer, makePool, memoryRow } from "../src/testing/index.ts";
import type { PoolEvent } from "../src/types.ts";

let pool: McpPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

const servers = { echo: () => echoServer(), other: () => echoServer() };

/** A pool with a listener that keeps every event, and the kept events. */
function recorded(options: Parameters<typeof makePool>[0] = {}) {
  const events: PoolEvent[] = [];
  pool = makePool({ servers, ...options });
  pool.onEvent((event) => events.push(event));
  return { pool, events };
}

test("a connect reports its duration and tool count, and a failed one its error", async () => {
  const { pool, events } = recorded();
  await pool.sync([memoryRow("echo"), memoryRow("missing")]);
  expect(events).toContainEqual({
    type: "connect",
    serverId: "echo",
    ms: expect.any(Number),
    tools: 4,
  });
  expect(events).toContainEqual({
    type: "connect-failed",
    serverId: "missing",
    ms: expect.any(Number),
    error: expect.stringMatching(/no in-memory server/),
  });
});

test("a call reports its outcome, size and truncation", async () => {
  const { pool, events } = recorded({ maxResultChars: 100 });
  await pool.sync([memoryRow("echo")]);
  events.length = 0;

  await pool.call("echo__ping", { repeat: 1000 });
  await pool.call("echo__ping", {});
  await pool.call("echo__ping", { fail: "nope" }).catch(() => {});
  await pool.call("echo__add", { a: "x" }).catch(() => {});
  await pool.call("echo__nothing", {}).catch(() => {});
  await pool.call("echo__ping", { fail: true }, { raw: true });

  expect(events).toEqual([
    {
      type: "call",
      qualified: "echo__ping",
      serverId: "echo",
      toolName: "ping",
      hidden: false,
      raw: false,
      ms: expect.any(Number),
      ok: true,
      chars: 1000,
      truncated: true,
    },
    expect.objectContaining({ ok: true, chars: 8, truncated: false }),
    expect.objectContaining({ ok: false, code: "tool-error", error: "nope", chars: 4 }),
    expect.objectContaining({ ok: false, code: "invalid-arguments", toolName: "add" }),
    {
      type: "call",
      qualified: "echo__nothing",
      hidden: false,
      raw: false,
      ms: expect.any(Number),
      ok: false,
      code: "unknown-tool",
      error: expect.stringMatching(/no connected MCP server/),
    },
    expect.objectContaining({ ok: false, code: "tool-error", raw: true }),
  ]);
  expect(events[5]).not.toHaveProperty("error");
});

test("each close says why", async () => {
  const { pool, events } = recorded();
  const closes = () => events.flatMap((event) => (event.type === "close" ? [event] : []));

  await pool.sync([memoryRow("echo"), memoryRow("other")]);
  await pool.stop("echo");
  expect(pool.state().find((server) => server.id === "echo")?.status).toBe("idle");
  await pool.reconnect("echo", [memoryRow("echo"), memoryRow("other")]);
  await pool.sync([memoryRow("echo", { url: "memory://other" }), memoryRow("other")]);
  await pool.sync([memoryRow("other")]);
  await pool.shutdown();

  expect(closes()).toEqual([
    { type: "close", serverId: "echo", reason: "stop" },
    { type: "close", serverId: "echo", reason: "changed" },
    { type: "close", serverId: "echo", reason: "removed" },
    { type: "close", serverId: "other", reason: "shutdown" },
  ]);
});

test("an idle reap closes with reason idle, and state() already reads idle", async () => {
  const { pool, events } = recorded({ idleTimeoutMs: 30 });
  let status: string | undefined;
  pool.onEvent((event) => {
    if (event.type === "close") status = pool.state()[0]?.status;
  });
  await pool.sync([memoryRow("echo")]);
  for (let i = 0; i < 40 && !events.some((event) => event.type === "close"); i++) {
    await new Promise((done) => setTimeout(done, 25));
  }
  expect(events).toContainEqual({ type: "close", serverId: "echo", reason: "idle" });
  expect(status).toBe("idle");
});

test("a listener that throws is logged and does not break the call", async () => {
  const errors: string[] = [];
  pool = makePool({ servers, log: { error: (message) => errors.push(message) } });
  const seen: string[] = [];
  pool.onEvent(() => {
    throw new Error("tracer bug");
  });
  const stop = pool.onEvent((event) => seen.push(event.type));
  await pool.sync([memoryRow("echo")]);
  await expect(pool.call("echo__ping", {})).resolves.toBe("ping({})");
  expect(seen).toEqual(["connect", "call"]);
  expect(errors.some((message) => message.includes("tracer bug"))).toBe(true);
  stop();
  await pool.call("echo__ping", {});
  expect(seen).toEqual(["connect", "call"]);
});
