import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import type { McpPoolOptions } from "../src/options.ts";
import type { McpPool } from "../src/pool.ts";
import { makePool } from "../src/testing/index.ts";
import type { ServerLogEntry, StdioServerConfig } from "../src/types.ts";
import { echoRow } from "./helpers.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pool-logging-"));
const levelLog = path.join(dir, "levels.log");
const spawnLog = path.join(dir, "spawns.log");
const lines = (file: string) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];

let pool: McpPool = makePool();
let errors: string[] = [];
const open = (options: McpPoolOptions = {}) => {
  pool = makePool({ log: { error: (message) => errors.push(message) }, ...options });
  return pool;
};
afterEach(async () => {
  await pool.shutdown();
  errors = [];
  fs.rmSync(levelLog, { force: true });
  fs.rmSync(spawnLog, { force: true });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The fixture declaring `logging`, writing down every level it is set to. */
const logging = (over: Partial<StdioServerConfig> = {}) =>
  echoRow({
    env: { MCP_ECHO_LOGGING: "1", MCP_ECHO_LEVEL_LOG: levelLog, MCP_ECHO_SPAWN_LOG: spawnLog },
    ...over,
  });

async function until(done: () => boolean, what: string) {
  for (let attempt = 0; attempt < 100 && !done(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

/** Every `notifications/message` the pool-wide listener heard, by its `data`. */
function pooled() {
  const heard: unknown[] = [];
  pool.onNotification((_id, notification) => {
    if (notification.method === "notifications/message") heard.push(notification.params?.data);
  });
  return heard;
}

test("a server that declares logging is set to the row's level once it connects", async () => {
  await open({ logLevel: "info" }).sync([logging({ logLevel: "warning" })]);
  await until(() => lines(levelLog).length > 0, "a setLevel");

  expect(lines(levelLog)).toEqual(["warning"]);
});

test("the pool's level stands in for a row with none, and a null row is one with none", async () => {
  await open({ logLevel: "info" }).sync([logging({ logLevel: null })]);
  await until(() => lines(levelLog).length > 0, "a setLevel");

  expect(lines(levelLog)).toEqual(["info"]);
});

test("with no level anywhere, nothing is sent and the server keeps its own", async () => {
  await open().sync([logging()]);
  await pool.call("echo__ping", {});

  expect(lines(levelLog)).toEqual([]);
});

test("a server that never declared logging is not asked to set a level", async () => {
  await open({ logLevel: "debug" }).sync([echoRow({ env: { MCP_ECHO_LEVEL_LOG: levelLog } })]);
  await pool.call("echo__ping", {});

  expect(lines(levelLog)).toEqual([]);
  // The SDK would refuse the request outright, and that refusal would be logged here.
  expect(errors).toEqual([]);
});

test("an edited level reaches a live server without restarting it", async () => {
  await open().sync([logging({ logLevel: "error" })]);
  await until(() => lines(levelLog).length === 1, "the first setLevel");
  await pool.sync([logging({ logLevel: "debug" })]);
  await until(() => lines(levelLog).length === 2, "the second setLevel");

  expect(lines(levelLog)).toEqual(["error", "debug"]);
  expect(lines(spawnLog)).toHaveLength(1);
});

test("a call hears what its server logs while it runs, and onNotification does not", async () => {
  await open().sync([logging()]);
  const elsewhere = pooled();
  const heard: ServerLogEntry[] = [];

  const out = await pool.call(
    "echo__echo",
    {
      logs: [
        { level: "warning", logger: "index", data: "index stale, rebuilding" },
        { level: "info", data: { rebuilt: 3 } },
      ],
    },
    { onLog: (entry) => heard.push(entry) },
  );

  expect(out).toContain("echo(");
  expect(heard).toEqual([
    { level: "warning", logger: "index", data: "index stale, rebuilding" },
    { level: "info", data: { rebuilt: 3 } },
  ]);
  expect(elsewhere).toEqual([]);
});

test("a call that does not listen leaves its server's log to onNotification", async () => {
  await open().sync([logging()]);
  const elsewhere = pooled();

  await pool.call("echo__echo", { logs: [{ level: "error", data: "rate limited" }] });
  await until(() => elsewhere.length > 0, "the pool-wide listener");

  expect(elsewhere).toEqual(["rate limited"]);
});

test("a message sent while two calls are in flight is neither's", async () => {
  await open().sync([logging()]);
  const elsewhere = pooled();
  const first: ServerLogEntry[] = [];
  const second: ServerLogEntry[] = [];

  await Promise.all([
    // Speaks while the other is still running, so nothing says which of the two it is about.
    pool.call(
      "echo__echo",
      { sleepMs: 50, logs: [{ level: "info", data: "first" }] },
      { onLog: (entry) => first.push(entry) },
    ),
    // Speaks once the first has answered, when it is the only call left to be about.
    pool.call(
      "echo__echo",
      { sleepMs: 400, logs: [{ level: "info", data: "second" }] },
      { onLog: (entry) => second.push(entry) },
    ),
  ]);
  await until(() => elsewhere.length === 1, "the first message on the pool-wide listener");

  expect(first).toEqual([]);
  expect(second).toEqual([{ level: "info", data: "second" }]);
  expect(elsewhere).toEqual(["first"]);
});

test("a chatty call is cut off at the cap, with one summary at the worst level it dropped", async () => {
  await open({ maxLogsPerCall: 3 }).sync([logging()]);
  const elsewhere = pooled();
  const heard: ServerLogEntry[] = [];

  await pool.call("echo__echo", { logCount: 10 }, { onLog: (entry) => heard.push(entry) });
  await until(() => elsewhere.length === 7, "the dropped messages on the pool-wide listener");

  expect(heard).toEqual([
    { level: "debug", data: "#0" },
    { level: "debug", data: "#1" },
    { level: "debug", data: "#2" },
    // The last of the ten is an error, so the summary is one too.
    { level: "error", data: "7 more messages dropped", dropped: 7 },
  ]);
  expect(elsewhere).toEqual(["#3", "#4", "#5", "#6", "#7", "#8", "#9"]);
});

test("a listener that throws is logged, and the call still answers", async () => {
  await open().sync([logging()]);

  const out = await pool.call(
    "echo__echo",
    { logs: [{ level: "info", data: "hello" }] },
    {
      onLog: () => {
        throw new Error("broken listener");
      },
    },
  );

  expect(out).toContain("echo(");
  expect(errors).toEqual([expect.stringContaining("broken listener")]);
});
