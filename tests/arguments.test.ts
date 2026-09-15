import { afterEach, expect, test } from "vitest";
import { coerceArguments } from "../src/arguments.ts";
import { httpStatusFor, McpPoolError, type McpPoolErrorCode } from "../src/errors.ts";
import type { McpPool } from "../src/pool.ts";
import { echoServer, makePool, memoryRow } from "../src/testing/index.ts";

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    limit: { type: "integer" },
    ratio: { type: "number" },
    recursive: { type: "boolean" },
    tags: { type: "array", items: { type: "number" } },
    filter: {
      type: "object",
      properties: { depth: { type: "integer" }, mode: { enum: ["fast", "slow"] } },
      required: ["mode"],
    },
    note: { type: ["string", "null"] },
    either: { anyOf: [{ type: "string" }, { type: "number" }] },
  },
  required: ["path"],
};

test("repairs the scalar types a model gets wrong", () => {
  expect(
    coerceArguments(
      {
        path: 42,
        limit: " 5 ",
        ratio: "0.5",
        recursive: "TRUE",
        tags: '["1", 2]',
        filter: '{"depth": "3", "mode": "fast"}',
        extra: "kept",
      },
      schema,
    ),
  ).toEqual({
    args: {
      path: "42",
      limit: 5,
      ratio: 0.5,
      recursive: true,
      tags: [1, 2],
      filter: { depth: 3, mode: "fast" },
      extra: "kept",
    },
    problems: [],
  });
});

test("parses a string input, and treats nothing as an empty object", () => {
  expect(coerceArguments('{"path": "a", "limit": "2"}', schema).args).toEqual({
    path: "a",
    limit: 2,
  });
  expect(coerceArguments(undefined, { type: "object" })).toEqual({ args: {}, problems: [] });
  expect(coerceArguments("  ", { type: "object" })).toEqual({ args: {}, problems: [] });
  expect(coerceArguments("not json", schema).problems).toEqual([
    'arguments must be a JSON object, got "not json"',
  ]);
  expect(coerceArguments([1], schema).problems).toEqual(["arguments must be an object, got [1]"]);
});

test("drops an empty string or null the model sent for an optional parameter", () => {
  expect(coerceArguments({ path: "a", limit: "", recursive: null, note: null }, schema)).toEqual({
    args: { path: "a", note: null },
    problems: [],
  });
});

test("names what it cannot repair, at any depth, in words a model can act on", () => {
  const { problems } = coerceArguments(
    { limit: "abc", tags: [1, "x"], filter: { depth: 1.5, mode: "medium" } },
    schema,
  );
  expect(problems).toEqual([
    '`limit` must be an integer, got "abc"',
    '`tags[1]` must be a number, got "x"',
    "`filter.depth` must be an integer, got 1.5",
    '`filter.mode` must be one of "fast", "slow", got "medium"',
    "missing required `path`",
  ]);
});

test("leaves what it does not read to the server", () => {
  expect(coerceArguments({ path: "a", either: true }, schema)).toEqual({
    args: { path: "a", either: true },
    problems: [],
  });
  expect(coerceArguments({ anything: "5" }, {})).toEqual({ args: { anything: "5" }, problems: [] });
});

test("never edits the input", () => {
  const input = { path: "a", filter: { depth: "2", mode: "fast" } };
  coerceArguments(input, schema);
  expect(input).toEqual({ path: "a", filter: { depth: "2", mode: "fast" } });
});

test("httpStatusFor maps every code", () => {
  const codes: Record<McpPoolErrorCode, number> = {
    "unknown-server": 404,
    disabled: 404,
    backoff: 503,
    "connect-failed": 502,
    "unknown-tool": 404,
    "out-of-scope": 404,
    "no-configs": 500,
    "tool-error": 502,
    "invalid-arguments": 400,
    timeout: 504,
  };
  for (const [code, status] of Object.entries(codes)) {
    expect(httpStatusFor(code as McpPoolErrorCode)).toBe(status);
  }
});

let pool: McpPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

const servers = { echo: () => echoServer() };

test("call() sends coerced arguments by default", async () => {
  pool = makePool({ servers });
  await pool.sync([memoryRow("echo")]);
  await expect(pool.call("echo__add", { a: "1", b: "2.5" })).resolves.toBe('add({"a":1,"b":2.5})');
  await expect(pool.call("echo__add", '{"a": 1, "b": 2}')).resolves.toBe('add({"a":1,"b":2})');
});

test("call() refuses what coercion cannot repair, before the server sees it", async () => {
  pool = makePool({ servers });
  await pool.sync([memoryRow("echo")]);
  const error = await pool.call("echo__add", { a: "one" }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(McpPoolError);
  expect(error).toMatchObject({
    code: "invalid-arguments",
    serverId: "echo",
    toolName: "echo__add",
    message:
      'invalid arguments for "echo__add": `a` must be a number, got "one"; missing required `b`',
  });
});

test("a scope refusal wins over an arguments refusal", async () => {
  pool = makePool({ servers });
  await pool.sync([memoryRow("echo")]);
  await expect(pool.call("echo__add", {}, { servers: [] })).rejects.toMatchObject({
    code: "out-of-scope",
  });
});

test("coercion is configured on the pool, the row and the call, nearest first", async () => {
  pool = makePool({ servers: { ...servers, raw: () => echoServer() }, coerceArguments: false });
  await pool.sync([memoryRow("echo"), memoryRow("raw", { coerceArguments: null })]);
  await expect(pool.call("echo__add", { a: "1", b: 2 })).resolves.toBe('add({"a":"1","b":2})');
  await expect(pool.call("echo__add", { a: "1", b: 2 }, { coerce: true })).resolves.toBe(
    'add({"a":1,"b":2})',
  );
  await pool.sync([memoryRow("echo", { coerceArguments: true })]);
  await expect(pool.call("echo__add", { a: "1", b: 2 })).resolves.toBe('add({"a":1,"b":2})');
  await expect(pool.call("echo__add", { a: "1", b: 2 }, { coerce: false })).resolves.toBe(
    'add({"a":"1","b":2})',
  );
});

test("a call that runs out of time is refused as timeout", async () => {
  pool = makePool({ servers, callTimeoutMs: 50 });
  await pool.sync([memoryRow("echo")]);
  const error = await pool.call("echo__ping", { sleepMs: 500 }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    code: "timeout",
    timeoutMs: 50,
    serverId: "echo",
    toolName: "echo__ping",
  });
  expect(httpStatusFor((error as McpPoolError).code)).toBe(504);
});

test("maxResultChars caps a call on the pool, the row and the call, nearest first", async () => {
  pool = makePool({ servers: { ...servers, big: () => echoServer() }, maxResultChars: 100 });
  await pool.sync([memoryRow("echo"), memoryRow("big", { maxResultChars: 0 })]);
  const capped = await pool.call("echo__ping", { repeat: 10_000 });
  expect(capped.length).toBeLessThanOrEqual(100);
  expect(capped).toMatch(/\[truncated: kept \d+ of 10000 chars\]/);
  expect(await pool.call("big__ping", { repeat: 10_000 })).toHaveLength(10_000);
  const perCall = await pool.call("big__ping", { repeat: 10_000 }, { maxResultChars: 50 });
  expect(perCall.length).toBeLessThanOrEqual(50);
  expect(perCall).toMatch(/\[truncated: kept \d+ of 10000 chars\]/);
  expect(await pool.call("echo__ping", { repeat: 10_000 }, { maxResultChars: 0 })).toHaveLength(
    10_000,
  );
});

test("a tool-error message is capped too", async () => {
  pool = makePool({ servers, maxResultChars: 80 });
  await pool.sync([memoryRow("echo")]);
  const error = (await pool
    .call("echo__ping", { fail: "e".repeat(5000) })
    .catch((caught: unknown) => caught)) as McpPoolError;
  expect(error.code).toBe("tool-error");
  expect(error.message.length).toBeLessThanOrEqual(80);
});

test("raw returns the server's result under the same scope, uncut and unthrown", async () => {
  pool = makePool({ servers, maxResultChars: 20 });
  await pool.sync([memoryRow("echo")]);
  const image = await pool.call("echo__ping", { image: true }, { raw: true });
  expect(image.content).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
  const long = await pool.call("echo__ping", { repeat: 500 }, { raw: true });
  expect(long.content[0]).toEqual({ type: "text", text: "x".repeat(500) });
  const failed = await pool.call("echo__ping", { fail: true }, { raw: true });
  expect(failed.isError).toBe(true);
  const structured = await pool.call("echo__ping", { structured: true }, { raw: true });
  expect(structured.structuredContent).toEqual({ greeting: "hello", tools: 4 });
  await expect(
    pool.call("echo__ping", {}, { raw: true, servers: ["other"] }),
  ).rejects.toMatchObject({ code: "out-of-scope" });
  await expect(pool.call("echo__add", { a: "x" }, { raw: true })).rejects.toMatchObject({
    code: "invalid-arguments",
  });
  // And the text path compacts the mirrored structure.
  expect(await pool.call("echo__ping", { structured: true }, { maxResultChars: 0 })).toBe(
    '{"greeting":"hello","tools":4}',
  );
});
