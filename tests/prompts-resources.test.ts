import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { McpPoolError } from "../src/errors.ts";
import { listAllPrompts, listAllResources, listAllResourceTemplates } from "../src/listing.ts";
import type { McpPool } from "../src/pool.ts";
import { promptText } from "../src/results.ts";
import { makePool } from "../src/testing/index.ts";
import type { StdioServerConfig } from "../src/types.ts";
import { echoRow } from "./helpers.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pool-surfaces-"));
const spawnLog = path.join(dir, "spawns.log");
const spawned = () =>
  fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").trim().split("\n").length : 0;

let pool: McpPool = makePool();
afterEach(async () => {
  await pool.shutdown();
  pool = makePool();
  fs.rmSync(spawnLog, { force: true });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The fixture with prompts, templates and completions on, and whatever a test adds. */
const row = (over: Partial<StdioServerConfig> = {}, env: Record<string, string> = {}) =>
  echoRow({
    env: {
      MCP_ECHO_SPAWN_LOG: spawnLog,
      MCP_ECHO_PROMPTS: "1",
      MCP_ECHO_TEMPLATES: "1",
      MCP_ECHO_COMPLETIONS: "1",
      ...env,
    },
    ...over,
  });

/** The fixture as an ordinary server: tools and resources, and no prompts or completions. */
const plain = (over: Partial<StdioServerConfig> = {}) =>
  echoRow({ env: { MCP_ECHO_SPAWN_LOG: spawnLog }, ...over });

async function until(done: () => boolean, what: string) {
  for (let attempt = 0; attempt < 100 && !done(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

test("the client-level walks read every page of prompts, resources and templates", async () => {
  await pool.sync([row({}, { MCP_ECHO_PAGE_SIZE: "1" })]);
  const client = await pool.client("echo-1");

  // A page size of one: everything past the first entry used to be dropped without a word.
  expect((await listAllPrompts(client)).map((prompt) => prompt.name)).toEqual([
    "greet",
    "review",
    "picture",
  ]);
  expect((await listAllResources(client)).map((resource) => resource.uri)).toEqual([
    "echo://greeting",
    "echo://long",
    "echo://pixel",
  ]);
  expect((await listAllResourceTemplates(client)).map((template) => template.name)).toEqual([
    "note",
    "user",
  ]);
});

test("a server that repeats its prompts cursor is refused rather than paged forever", async () => {
  await pool.sync([row({}, { MCP_ECHO_STUCK_PROMPTS: "1" })]);
  const client = await pool.client("echo-1");

  await expect(listAllPrompts(client)).rejects.toThrow(/repeated the prompts\/list cursor/);
});

test("prompts() asks only the servers whose handshake declared prompts, in configuration order", async () => {
  await pool.sync([
    row({ id: "a", slug: "a" }),
    plain({ id: "b", slug: "b" }),
    row({ id: "c", slug: "c", enabled: false }),
    row({ id: "d", slug: "d" }, { MCP_ECHO_PAGE_SIZE: "2" }),
  ]);

  const listed = await pool.prompts();
  // No entry for the server without the capability, and none for the one that is off.
  expect(listed.map((entry) => entry.serverId)).toEqual(["a", "d"]);
  expect(listed[1]?.prompts.map((prompt) => prompt.name)).toEqual(["greet", "review", "picture"]);
  expect(listed[1]?.error).toBeUndefined();
});

test("prompts() holds to the scope, and an empty scope is no servers rather than all", async () => {
  await pool.sync([row({ id: "a", slug: "a" }), row({ id: "b", slug: "b" })]);

  expect((await pool.prompts({ servers: ["b"] })).map((entry) => entry.serverId)).toEqual(["b"]);
  expect(await pool.prompts({ servers: [] })).toEqual([]);
});

test("a server never connected has said nothing about prompts, and is not dialled to ask", async () => {
  pool = makePool({ lazy: true });
  await pool.sync([row()]);

  expect(await pool.prompts()).toEqual([]);
  expect(spawned()).toBe(0);
});

test("a reaped server is still asked for its prompts, off the handshake it kept", async () => {
  pool = makePool({ idleTimeoutMs: 50 });
  await pool.sync([row()]);
  await until(() => pool.state()[0]?.status === "idle", "the idle reap");

  const [entry] = await pool.prompts();
  expect(entry?.prompts).toHaveLength(3);
});

test("a server that cannot be listed keeps its entry, with the reason and no prompts", async () => {
  await pool.sync([row({ id: "a", slug: "a" }, { MCP_ECHO_STUCK_PROMPTS: "1" }), row()]);

  // One broken server must not empty a picker of the ones that answered.
  const [broken, working] = await pool.prompts();
  expect(broken).toMatchObject({ serverId: "a", prompts: [] });
  expect(broken?.error).toMatch(/cursor/);
  expect(working?.prompts).toHaveLength(3);
});

test("resources() lists every page of resources and templates", async () => {
  await pool.sync([row({}, { MCP_ECHO_PAGE_SIZE: "1" })]);

  const [entry] = await pool.resources();
  expect(entry?.resources.map((resource) => resource.uri)).toEqual([
    "echo://greeting",
    "echo://long",
    "echo://pixel",
  ]);
  expect(entry?.templates.map((template) => template.uriTemplate)).toEqual([
    "echo://notes/{folder}/{note}",
    "echo://users/{id}",
  ]);
});

test("a server with resources and no templates handler lists no templates, not an error", async () => {
  await pool.sync([plain()]);

  const [entry] = await pool.resources();
  expect(entry).toMatchObject({ serverId: "echo-1", templates: [] });
  expect(entry?.resources).toHaveLength(3);
  expect(entry?.error).toBeUndefined();
});

test("a server with prompts and no tools connects, lists no tools, and serves its prompts", async () => {
  const errors: string[] = [];
  pool = makePool({ log: { error: (message) => errors.push(message) } });
  // Neither tools nor resources: a prompts-only server answers `tools/list` with Method not
  // found, which used to fail the connect and leave its prompts unreachable.
  await pool.sync([row({}, { MCP_ECHO_WITHOUT: "tools,resources" })]);

  expect(pool.state()[0]).toMatchObject({ status: "ready", tools: [] });
  expect(pool.tools()).toEqual([]);
  const [entry] = await pool.prompts();
  expect(entry?.prompts.map((prompt) => prompt.name)).toEqual(["greet", "review", "picture"]);
  expect(await pool.expandPrompt("echo-1", "greet", { name: "Ada" })).toBe("Hello, Ada!");
  expect(errors).toEqual([]);
});

test("a server with resources and no tools connects and serves its resources", async () => {
  await pool.sync([echoRow({ env: { MCP_ECHO_SPAWN_LOG: spawnLog, MCP_ECHO_WITHOUT: "tools" } })]);

  expect(pool.state()[0]).toMatchObject({ status: "ready", tools: [] });
  const [entry] = await pool.resources();
  expect(entry?.resources).toHaveLength(3);
  expect(await pool.readResource("echo-1", "echo://greeting")).toMatchObject({
    text: "hello from a resource",
  });
});

test("a refresh leaves a server that declared no tools alone rather than logging a failure", async () => {
  const errors: string[] = [];
  pool = makePool({ refreshMs: 1, log: { error: (message) => errors.push(message) } });
  await pool.sync([row({}, { MCP_ECHO_WITHOUT: "tools" })]);

  // Past the refresh age, a catalogue read is what starts a re-list.
  await new Promise((resolve) => setTimeout(resolve, 10));
  pool.catalog();
  await new Promise((resolve) => setTimeout(resolve, 100));
  pool.catalog();

  expect(errors).toEqual([]);
  expect(pool.state()[0]?.status).toBe("ready");
});

test("one message expands verbatim", async () => {
  await pool.sync([row()]);

  expect(await pool.expandPrompt("echo-1", "greet", { name: "Ada" })).toBe("Hello, Ada!");
});

test("several messages are joined with their roles in front", async () => {
  await pool.sync([row()]);

  expect(await pool.expandPrompt("echo-1", "review", { code: "x = 1" })).toBe(
    "user: Review x = 1\n\nassistant: Looks fine.",
  );
});

test("content with no text is named in brackets rather than dropped", async () => {
  await pool.sync([row()]);

  expect(await pool.expandPrompt("echo-1", "picture")).toBe("[image image/png, 2 bytes omitted]");
});

test("a prompt with no messages expands to nothing", () => {
  expect(promptText({ messages: [] })).toBe("");
});

test("expandPrompt refuses a server that never declared prompts, by name", async () => {
  await pool.sync([plain()]);

  const refused = await pool.expandPrompt("echo-1", "greet").catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(McpPoolError);
  expect(refused).toMatchObject({ code: "unsupported", serverId: "echo-1" });
});

test("a server outside the scope is refused in the words for one that does not exist", async () => {
  await pool.sync([row()]);

  const refused = await pool
    .expandPrompt("echo-1", "greet", { name: "Ada" }, { servers: [] })
    .catch((error: unknown) => error);
  expect(refused).toMatchObject({ code: "out-of-scope" });
  expect((refused as Error).message).toBe('no MCP server is configured with id "echo-1"');
  await expect(pool.readResource("echo-1", "echo://greeting", { servers: [] })).rejects.toThrow(
    /no MCP server is configured/,
  );
});

test("readResource returns text with its mime type", async () => {
  await pool.sync([plain()]);

  expect(await pool.readResource("echo-1", "echo://greeting")).toEqual({
    uri: "echo://greeting",
    mimeType: "text/plain",
    text: "hello from a resource",
    truncated: false,
  });
});

test("a binary resource is named with its type and size, as a tool result's would be", async () => {
  await pool.sync([plain()]);

  const read = await pool.readResource("echo-1", "echo://pixel");
  expect(read).toMatchObject({ mimeType: "image/png", truncated: false });
  expect(read.text).toBe("[resource echo://pixel image/png, 2 bytes omitted]");
});

test("readResource cuts its text to maxChars and says it did", async () => {
  await pool.sync([plain()]);

  const read = await pool.readResource("echo-1", "echo://long", { maxChars: 100 });
  expect(read.truncated).toBe(true);
  expect(read.text.length).toBeLessThanOrEqual(100);
  expect(read.text).toContain("[truncated: kept");
});

test("parts that disagree on a mime type report none", async () => {
  await pool.sync([plain()]);

  const read = await pool.readResource("echo-1", "echo://mixed");
  expect(read.mimeType).toBeUndefined();
  expect(read.text).toBe("# a\nb");
});

test("complete answers the server's suggestions for a prompt argument", async () => {
  await pool.sync([row()]);

  const values = await pool.complete(
    "echo-1",
    { type: "ref/prompt", name: "greet" },
    { name: "name", value: "A" },
  );
  expect(values).toEqual(["Ada", "Alan"]);
});

test("complete passes the arguments already filled in as context", async () => {
  await pool.sync([row()]);

  const values = await pool.complete(
    "echo-1",
    { type: "ref/resource", uri: "echo://notes/{folder}/{note}" },
    { name: "note", value: "" },
    { folder: "work" },
  );
  expect(values).toEqual(["work-a", "work-b"]);
});

test("a server without completions answers no suggestions, and is not dialled to say so", async () => {
  pool = makePool({ idleTimeoutMs: 50 });
  await pool.sync([plain()]);
  await until(() => pool.state()[0]?.status === "idle", "the idle reap");

  // A UI asks on every keystroke; the kept handshake already says there is nothing to ask.
  const values = await pool.complete(
    "echo-1",
    { type: "ref/prompt", name: "greet" },
    { name: "name", value: "A" },
  );
  expect(values).toEqual([]);
  expect(spawned()).toBe(1);
});

test("a server never connected is dialled once to learn whether it completes", async () => {
  pool = makePool({ lazy: true });
  await pool.sync([plain()]);

  expect(
    await pool.complete("echo-1", { type: "ref/prompt", name: "greet" }, { name: "n", value: "" }),
  ).toEqual([]);
  expect(spawned()).toBe(1);
});
