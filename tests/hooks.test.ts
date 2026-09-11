import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { McpPoolError } from "../src/errors.ts";
import { contextBlocks, expandArgs, templatePaths, validateHooks } from "../src/hooks.ts";
import { McpPool } from "../src/pool.ts";
import type { HookContext, HookOutcome, StdioServerConfig, ToolHook } from "../src/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url));

const config = (over: Partial<StdioServerConfig> = {}): StdioServerConfig => ({
  id: "echo-1",
  slug: "echo",
  label: "Echo",
  enabled: true,
  transport: "stdio",
  command: process.execPath,
  args: [FIXTURE],
  ...over,
});

const makePool = () => new McpPool({ clientName: "mcp-pool-hooks-test", log: {} });

let pool = makePool();

afterEach(async () => {
  await pool.shutdown();
  pool = makePool();
});

const context: HookContext = {
  session: { id: "s1" },
  host: "test",
  prompt: "hello",
  turn: { index: 4, messages: [{ speaker: "user", text: "hi", uuid: "s1:4" }] },
};

const hook = (over: Partial<ToolHook> = {}): ToolHook => ({
  id: "h",
  on: "beforeTurn",
  tool: "echo",
  args: { text: "{{prompt}}" },
  ...over,
});

/** A pool holding one echo server with these hooks, connected. */
async function withHooks(hooks: ToolHook[], over: Partial<StdioServerConfig> = {}) {
  await pool.sync([config({ hooks, ...over })]);
}

/** An outcome with nothing but what `contextBlocks` reads set. */
const outcome = (over: Partial<HookOutcome> = {}): HookOutcome => ({
  serverId: "echo-1",
  label: "Echo",
  hookId: "h",
  event: "beforeTurn",
  ok: true,
  text: "remembered",
  ms: 1,
  inject: true,
  maxTokens: 1000,
  ...over,
});

// --- templating ---------------------------------------------------------------------------------

test("a placeholder that is the whole string goes in raw, so arrays and numbers survive", () => {
  const { args, missing } = expandArgs(
    { turns: "{{turn.messages}}", at: "{{ turn.index }}", nested: ["{{session.id}}"] },
    context,
  );
  expect(args).toEqual({ turns: context.turn?.messages, at: 4, nested: ["s1"] });
  expect(missing).toEqual([]);
});

test("a placeholder inside a longer string is interpolated as text", () => {
  const { args } = expandArgs(
    { session_id: "app:{{session.id}}", note: "turn {{turn.index}} of {{host}}" },
    context,
  );
  expect(args).toEqual({ session_id: "app:s1", note: "turn 4 of test" });
});

test("a path the context has no value for is reported, not sent as empty", () => {
  const { missing } = expandArgs({ q: "{{reply}}", s: "x-{{vars.card}}" }, context);
  expect(missing).toEqual(["reply", "vars.card"]);
});

test("absent args are an empty object, and non-strings pass through", () => {
  expect(expandArgs(undefined, context).args).toEqual({});
  expect(expandArgs({ confirm: true, n: 3, none: null }, context).args).toEqual({
    confirm: true,
    n: 3,
    none: null,
  });
});

test("templatePaths finds every placeholder once", () => {
  expect(templatePaths({ a: "{{prompt}}", b: ["x {{session.id}} {{prompt}}"] })).toEqual([
    "prompt",
    "session.id",
  ]);
});

// --- validation ---------------------------------------------------------------------------------

test("a well-formed set of hooks has nothing wrong with it", () => {
  expect(
    validateHooks([
      hook({ id: "recall", inject: true, maxTokens: 800 }),
      hook({ id: "remember", on: "afterTurn", args: { turns: "{{turn.messages}}" } }),
      hook({ id: "card", on: "sessionEnd", args: { card: "{{vars.cardId}}", s: "{{status}}" } }),
      hook({ id: "forget", on: "sessionDelete", args: { session_id: "{{session.id}}" } }),
    ]),
  ).toEqual([]);
  expect(validateHooks(null)).toEqual([]);
});

test("validation names each problem and the hook it is on", () => {
  const errors = validateHooks([
    hook({ id: "a", on: "whenever" as never }),
    hook({ id: "b", on: "afterTurn", inject: true }),
    hook({ id: "c", args: { text: "{{reply}}" } }),
    hook({ id: "c" }),
    hook({ id: "d", tool: "" }),
    hook({ id: "e", maxTokens: 0, timeoutMs: 1.5 }),
    hook({ id: "" }),
  ]);
  expect(errors).toEqual([
    expect.stringMatching(/^hook "a": "whenever" is not an event/),
    expect.stringMatching(/^hook "b": only sessionStart and beforeTurn can inject/),
    expect.stringMatching(/^hook "c": beforeTurn has no \{\{reply\}\}/),
    expect.stringMatching(/^hook "c": another hook on this server has that id/),
    expect.stringMatching(/^hook "d": needs a tool/),
    expect.stringMatching(/^hook "e": maxTokens/),
    expect.stringMatching(/^hook "e": timeoutMs/),
    expect.stringMatching(/^hook 7: needs an id/),
  ]);
});

// --- context blocks -----------------------------------------------------------------------------

test("contextBlocks wraps each injecting hook's output, naming its server", () => {
  const blocks = contextBlocks([
    outcome({ label: 'Mem "ory" <1>', text: "  one  " }),
    outcome({ hookId: "failed", ok: false, text: undefined, error: "down" }),
    outcome({ hookId: "quiet", inject: false }),
    outcome({ hookId: "empty", text: undefined }),
    outcome({ hookId: "two", label: "Other", text: "two" }),
  ]);
  expect(blocks.text).toBe(
    '<context source="Mem &quot;ory&quot; &lt;1>">\none\n</context>\n\n<context source="Other">\ntwo\n</context>',
  );
  expect(blocks.injected).toEqual([
    { serverId: "echo-1", hookId: "h", tokens: 1, text: "one" },
    { serverId: "echo-1", hookId: "two", tokens: 1, text: "two" },
  ]);
});

/** The text inside each `<context>` block, in order. */
const inner = (text: string) =>
  [...text.matchAll(/<context source="[^"]*">\n([\s\S]*?)\n<\/context>/g)].map((m) => m[1]);

test("contextBlocks reports each hook's text as it went into its block, cut or not", () => {
  const long = "x".repeat(400); // 100 tokens
  const blocks = contextBlocks(
    [
      outcome({ hookId: "whole", text: "  kept whole  " }),
      outcome({ hookId: "own-cap", text: long, maxTokens: 10 }),
      outcome({ hookId: "total", text: long }),
    ],
    { maxTokens: 30 },
  );
  expect(blocks.injected.map((i) => i.text)).toEqual(inner(blocks.text));
  expect(blocks.injected.map((i) => i.text)).toEqual([
    "kept whole",
    `${"x".repeat(39)}…`,
    `${"x".repeat(67)}…`,
  ]);
});

test("contextBlocks holds each block to its hook's cap and the whole to the total", () => {
  const long = "x".repeat(400); // 100 tokens
  const capped = contextBlocks([outcome({ text: long, maxTokens: 10 })]);
  expect(capped.injected[0].tokens).toBe(10);
  expect(capped.text).toContain(`${"x".repeat(39)}…`);

  const total = contextBlocks(
    [
      outcome({ hookId: "a", text: long }),
      outcome({ hookId: "b", text: long }),
      outcome({ hookId: "c", text: long }),
    ],
    { maxTokens: 150 },
  );
  // The first fits whole, the second is cut to what is left, the third has nothing left.
  expect(total.injected.map(({ hookId, tokens }) => [hookId, tokens])).toEqual([
    ["a", 100],
    ["b", 50],
  ]);
});

// --- runHooks -----------------------------------------------------------------------------------

test("runHooks calls the bound tool with its templated arguments", async () => {
  await withHooks([hook({ inject: true })]);
  const [result] = await pool.runHooks("beforeTurn", context);
  expect(result).toMatchObject({
    serverId: "echo-1",
    label: "Echo",
    hookId: "h",
    event: "beforeTurn",
    ok: true,
    text: 'echo({"text":"hello"})',
    inject: true,
    maxTokens: 1000,
  });
});

test("runHooks runs only this event's enabled hooks, in configuration order, at once", async () => {
  await withHooks([
    hook({ id: "slow", args: { text: "slow", sleepMs: 300 } }),
    hook({ id: "other-event", on: "afterTurn" }),
    hook({ id: "off", enabled: false }),
    hook({ id: "fast", tool: "ping", args: { sleepMs: 300 } }),
  ]);
  const started = Date.now();
  const outcomes = await pool.runHooks("beforeTurn", context);
  expect(outcomes.map((o) => o.hookId)).toEqual(["slow", "fast"]);
  expect(outcomes.every((o) => o.ok)).toBe(true);
  // Two 300ms hooks in sequence would take 600.
  expect(Date.now() - started).toBeLessThan(550);
});

test("runHooks leaves out disabled servers and servers outside the scope", async () => {
  await withHooks([hook()]);
  expect(await pool.runHooks("beforeTurn", context, { servers: [] })).toEqual([]);
  expect(await pool.runHooks("beforeTurn", context, { servers: ["echo-1"] })).toHaveLength(1);

  await pool.sync([config({ hooks: [hook()], enabled: false })]);
  expect(await pool.runHooks("beforeTurn", context)).toEqual([]);
});

test("a failing hook is an outcome and a notice, never a rejection", async () => {
  await withHooks([
    hook({ id: "boom", args: { fail: "boom" } }),
    hook({ id: "missing-tool", tool: "nope" }),
    hook({ id: "fine" }),
  ]);
  const notices: string[] = [];
  const outcomes = await pool.runHooks("beforeTurn", context, {
    onNotice: (notice) => notices.push(notice),
  });
  expect(outcomes.map(({ hookId, ok }) => [hookId, ok])).toEqual([
    ["boom", false],
    ["missing-tool", false],
    ["fine", true],
  ]);
  expect(outcomes[0].error).toBe("boom");
  expect(outcomes[1].error).toContain("echo__nope");
  expect(notices).toEqual(
    expect.arrayContaining([
      'Echo: beforeTurn hook "boom" failed: boom',
      expect.stringContaining('hook "missing-tool" failed'),
    ]),
  );
});

test("a hook whose placeholder has no value is skipped rather than sent", async () => {
  await withHooks([hook({ args: { text: "{{reply}}" } })]);
  const notices: string[] = [];
  const [result] = await pool.runHooks("beforeTurn", context, {
    onNotice: (notice) => notices.push(notice),
  });
  expect(result).toMatchObject({ ok: false, skipped: true, error: "no value for {{reply}}" });
  expect(notices).toEqual(['Echo: beforeTurn hook "h" skipped: no value for {{reply}}']);
});

test("a hook that outlives its timeout fails at the timeout", async () => {
  await withHooks([hook({ timeoutMs: 100, args: { sleepMs: 2000 } })]);
  const [result] = await pool.runHooks("beforeTurn", context);
  expect(result.ok).toBe(false);
  expect(result.ms).toBeLessThan(1500);
});

test("an abort resolves the hooks promptly, and one already aborted never runs", async () => {
  await withHooks([hook({ on: "afterTurn", args: { sleepMs: 5000 } })]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const [aborted] = await pool.runHooks("afterTurn", context, { signal: controller.signal });
  expect(aborted.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(1500);

  const [skipped] = await pool.runHooks("afterTurn", context, { signal: controller.signal });
  expect(skipped).toMatchObject({ ok: false, skipped: true });
});

test("an empty result is a success with nothing to inject", async () => {
  await withHooks([hook({ inject: true, args: { empty: true } })]);
  const [result] = await pool.runHooks("beforeTurn", context);
  expect(result.ok).toBe(true);
  expect(result.text).toBeUndefined();
  expect(contextBlocks([result]).text).toBe("");
});

test("inject is ignored on an event that runs too late, even on an unvalidated row", async () => {
  await withHooks([hook({ on: "afterTurn", inject: true })]);
  const [result] = await pool.runHooks("afterTurn", context);
  expect(result.inject).toBe(false);
});

test("runHooks fills in now when the caller did not", async () => {
  await withHooks([hook({ args: { text: "{{now}}" } })]);
  const [result] = await pool.runHooks("beforeTurn", context);
  expect(result.text).toMatch(/"text":"\d{4}-\d{2}-\d{2}T/);
});

// --- hidden tools -------------------------------------------------------------------------------

test("a hidden tool is not offered, is refused to a plain call, and reaches a hook", async () => {
  await pool.sync([
    config({
      hiddenTools: ["add"],
      hooks: [hook({ tool: "add", args: { a: 1, b: 2 } })],
    }),
  ]);

  const offered = pool.tools().map((t) => t.function.name);
  expect(offered).toContain("echo__echo");
  expect(offered).not.toContain("echo__add");
  expect(pool.tools({ names: ["echo__add"] })).toEqual([]);
  expect(pool.catalog()[0].tools.map((t) => t.name)).not.toContain("echo__add");
  expect(pool.state()[0].tools.map(({ name, hidden }) => [name, hidden])).toEqual([
    ["ping", false],
    ["echo", false],
    ["add", true],
  ]);

  const refused = await pool.call("echo__add", { a: 1, b: 2 }).catch((error) => error);
  expect(refused).toBeInstanceOf(McpPoolError);
  expect(refused.code).toBe("unknown-tool");
  expect(refused.message).toBe('no connected MCP server offers a tool called "echo__add"');

  expect(await pool.call("echo__add", { a: 1, b: 2 }, { hidden: true })).toBe('add({"a":1,"b":2})');
  const [result] = await pool.runHooks("beforeTurn", context);
  expect(result).toMatchObject({ ok: true, text: 'add({"a":1,"b":2})' });
});

test("a server whose every tool is hidden drops out of the catalogue", async () => {
  await pool.sync([config({ hiddenTools: ["ping", "echo", "add"] })]);
  expect(pool.catalog()).toEqual([]);
  expect(pool.tools()).toEqual([]);
});

test("unhiding a tool applies without a reconnect", async () => {
  await pool.sync([config({ hiddenTools: ["add"] })]);
  const { pid } = pool.state()[0];
  await pool.sync([config({ hiddenTools: [] })]);
  expect(pool.state()[0].pid).toBe(pid);
  expect(pool.tools().map((t) => t.function.name)).toContain("echo__add");
});

// --- call options -------------------------------------------------------------------------------

test("call still takes a bare scope as its third argument", async () => {
  await pool.sync([config()]);
  expect(await pool.call("echo__ping", {}, ["echo-1"])).toBe("ping({})");
  expect((await pool.call("echo__ping", {}, ["other"]).catch((e) => e)).code).toBe("out-of-scope");
  expect((await pool.call("echo__ping", {}, { servers: [] }).catch((e) => e)).code).toBe(
    "out-of-scope",
  );
});

test("call honours a timeout and a signal", async () => {
  await pool.sync([config()]);
  const started = Date.now();
  await expect(pool.call("echo__echo", { sleepMs: 2000 }, { timeoutMs: 100 })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1500);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await expect(
    pool.call("echo__echo", { sleepMs: 2000 }, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1500);
});
