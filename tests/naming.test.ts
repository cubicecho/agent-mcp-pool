import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { couldQualify, labelOf, pooledTool, qualify, SEPARATOR, slugOf } from "../src/naming.ts";
import type { StdioServerConfig } from "../src/types.ts";

const config = (over: Partial<StdioServerConfig> = {}): StdioServerConfig => ({
  id: "echo-1",
  slug: "echo",
  label: "Echo",
  enabled: true,
  transport: "stdio",
  command: "node",
  ...over,
});

const tool = (over: Partial<Parameters<typeof pooledTool>[1]> = {}) => ({
  name: "ping",
  description: "Answers.",
  parameters: { type: "object" } as Record<string, unknown>,
  ...over,
});

test("a slug names the server, and an id stands in when there is none", () => {
  expect(slugOf(config())).toBe("echo");
  expect(slugOf(config({ slug: undefined }))).toBe("echo-1");
  // Empty falls back too: an empty slug would qualify a tool as `__ping`, which names no server.
  expect(slugOf(config({ slug: "" }))).toBe("echo-1");
});

test("a name that fits the limit is left exactly as it was built", () => {
  expect(qualify("echo", "ping")).toBe(`echo${SEPARATOR}ping`);
  // The boundary itself, since this is where truncation starts: 64 characters is allowed.
  const exact = qualify("s".repeat(58), "tool");
  expect(exact).toHaveLength(64);
  expect(exact).toBe(`${"s".repeat(58)}${SEPARATOR}tool`);
});

test("an over-long name is cut to the limit and given a hash of the whole of itself", () => {
  const slug = "s".repeat(58);
  const name = qualify(slug, "toolong");
  const full = `${slug}${SEPARATOR}toolong`;

  expect(name).toHaveLength(64);
  // The hash is of the *entire* name, which is the half that was thrown away — hashing only the
  // surviving prefix would give two truncated siblings the same digest.
  const digest = createHash("sha256").update(full).digest("hex").slice(0, 6);
  expect(name).toBe(`${full.slice(0, 57)}_${digest}`);
});

/**
 * The bug this exists for: two tools whose qualified names share a 64-character prefix used to
 * truncate onto one key, and the second silently replaced the first in the pool's index — the
 * model was offered a name that dispatched to the wrong tool.
 */
test("names that share a truncated prefix stay distinct", () => {
  const slug = "e".repeat(62); // 62 + "__" is already the whole budget
  const names = ["read_the_file", "read_the_other_file", "read"].map((name) => qualify(slug, name));

  expect(new Set(names).size).toBe(3);
  for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
});

/**
 * MCP allows `[A-Za-z0-9_.-]` in a tool name; OpenAI allows `^[a-zA-Z0-9_-]{1,64}$`. A server
 * calling its tool `fs.read` therefore sends a `function.name` the API refuses — and it refuses
 * the request, which is every other server's tools along with it.
 */
test("a name carries no character OpenAI would refuse", () => {
  expect(qualify("echo", "fs.read")).toBe("echo__fs_read");
  expect(qualify("echo", "read:file/now")).toBe("echo__read_file_now");
  // The slug half as well. `validateServerConfig` allows none of this, but nothing makes the pool
  // reject a row that never went through it.
  expect(qualify("my server", "ping")).toBe("my_server__ping");
});

test("two names that only a refused character told apart stay apart once truncated", () => {
  const slug = "e".repeat(60);
  const dotted = qualify(slug, "a.b");
  const scored = qualify(slug, "a_b");

  // Both are over the limit, so both are cut — and the hash is of the name as the server gave it,
  // which by then is the only thing left that still distinguishes them.
  expect(dotted).toHaveLength(64);
  expect(dotted).not.toBe(scored);
});

test("couldQualify claims a name built from a slug it had to substitute", () => {
  // `wake` compares a raw slug against a name that has already been through `qualify`. Without
  // the same substitution here, a cold server with an unusual slug is never woken by its own tool.
  expect(couldQualify("my server", qualify("my server", "ping"))).toBe(true);
});

test("the same name is built the same way every time", () => {
  // `connect` builds these and `relabel` rebuilds them; a hash that drifted between the two would
  // leave the model calling a name the index no longer holds.
  expect(qualify("q".repeat(60), "tool")).toBe(qualify("q".repeat(60), "tool"));
});

test("a pooled tool keeps the server's own name alongside the one the model sees", () => {
  const pooled = pooledTool(config(), tool());

  // The server is called back under its own name; only the wire name is namespaced.
  expect(pooled.name).toBe("ping");
  expect(pooled.qualified).toBe("echo__ping");
  expect(pooled.definition).toEqual({
    type: "function",
    function: {
      name: "echo__ping",
      description: "[Echo] Answers.",
      parameters: { type: "object" },
    },
  });
});

test("the definition is built from the same qualified name the index is keyed by", () => {
  const pooled = pooledTool(config({ slug: "s".repeat(62) }), tool({ name: "ping" }));
  const name = pooled.definition.type === "function" ? pooled.definition.function.name : "";

  expect(name).toBe(pooled.qualified);
});

test("a tool is introduced by its server's label, falling back to the slug and then the id", () => {
  const described = (over: Partial<StdioServerConfig>) => {
    const { definition } = pooledTool(config(over), tool());
    return definition.type === "function" ? definition.function.description : "";
  };

  expect(described({ label: "Echo" })).toBe("[Echo] Answers.");
  // No row can be introduced as `[]`: an unlabelled server borrows whatever names it.
  expect(described({ label: "" })).toBe("[echo] Answers.");
  expect(described({ label: "", slug: undefined })).toBe("[echo-1] Answers.");
});

test("a tool with no description of its own is still introduced by its server", () => {
  const { definition } = pooledTool(config(), tool({ description: "" }));
  const description = definition.type === "function" ? definition.function.description : "";

  // Trimmed rather than left as `[Echo] `, which reads to a model as a truncated sentence.
  expect(description).toBe("[Echo]");
});

/**
 * OpenAI refuses a function description past 1024 characters, and refuses the request rather than
 * the tool — so one server's usage guide costs the model every other server's tools.
 */
test("a description is capped over the whole of what the model is sent, prefix included", () => {
  const written = "x".repeat(2000);
  const pooled = pooledTool(config(), tool({ description: written }), 120);
  const sent =
    (pooled.definition.type === "function" ? pooled.definition.function.description : "") ?? "";

  expect(sent.length).toBeLessThanOrEqual(120);
  // The prefix counts against the budget, because it is what the API measures.
  expect(sent.startsWith("[Echo] ")).toBe(true);
  // What the server actually said is still on the tool, the way its own name is.
  expect(pooled.description).toBe(written);
});

test("a description that fits is untouched, and no cap leaves even a long one alone", () => {
  const sent = (description: string, max?: number) => {
    const { definition } = pooledTool(config(), tool({ description }), max);
    return (definition.type === "function" ? definition.function.description : "") ?? "";
  };

  expect(sent("x".repeat(2000))).toHaveLength(2007);
  expect(sent("Answers.", 1024)).toBe("[Echo] Answers.");
});

test("the server's schema is passed through untouched, not rebuilt", () => {
  // The pool hands this schema back to the model and never validates against it, so a rewrite
  // here would silently change what the server said its arguments are.
  const parameters = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };
  const pooled = pooledTool(config(), tool({ parameters }));

  expect(pooled.parameters).toEqual(parameters);
  expect(pooled.definition.type === "function" && pooled.definition.function.parameters).toEqual(
    parameters,
  );
});

/**
 * The question `wake` asks of a name nothing has claimed yet. It has to be exact in one
 * direction — a server that really owns the name must always be woken — and is allowed to be
 * generous in the other, since waking a server that turns out not to have the tool costs a
 * process, not a wrong answer.
 */
test("couldQualify claims a name its slug built", () => {
  expect(couldQualify("echo", "echo__ping")).toBe(true);
  expect(couldQualify("echo", "notes__ping")).toBe(false);
  // The separator is part of the claim: a slug is not a prefix of another server's slug.
  expect(couldQualify("echo", "echoes__ping")).toBe(false);
});

test("couldQualify claims a truncated name whose slug was cut into", () => {
  const slug = "s".repeat(60);
  const qualified = qualify(slug, "ping");
  expect(qualified).toHaveLength(64);
  // The prefix test alone cannot see this one: `<slug>__ping` is 66 characters, so the slug lost
  // its own tail to the truncation and the name does not start with `<slug>__` at all.
  expect(qualified.startsWith(`${slug}__`)).toBe(false);
  expect(couldQualify(slug, qualified)).toBe(true);
  expect(couldQualify(`${"d".repeat(60)}`, qualified)).toBe(false);
});

test("couldQualify claims every long name its slug built, whatever the tool", () => {
  const slug = "s".repeat(60);
  for (const tool of ["ping", "echo", "add", "a-much-longer-tool-name"]) {
    expect(couldQualify(slug, qualify(slug, tool))).toBe(true);
  }
});

test("couldQualify refuses a name of the right length that is not a hash", () => {
  const slug = "echo";
  // 64 characters, but the tail is not six hex digits, so it was never truncated — which means
  // it carries its whole slug and the prefix test already answered.
  const name = `notes__${"t".repeat(64 - 7)}`;
  expect(name).toHaveLength(64);
  expect(couldQualify(slug, name)).toBe(false);
});

/**
 * The same fallback as `slugOf`, and it exists for the same reason: three places wrote it out and
 * one of them wrote it differently.
 */
test("labelOf falls back through the slug to the id", () => {
  expect(labelOf({ id: "notes-1", slug: "notes", label: "Notes" })).toBe("Notes");
  expect(labelOf({ id: "notes-1", slug: "notes", label: "" })).toBe("notes");
  expect(labelOf({ id: "notes-1", slug: undefined, label: "" })).toBe("notes-1");
});
