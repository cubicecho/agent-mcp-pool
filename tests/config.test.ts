import { expect, test } from "vitest";
import { sameConnection, scope } from "../src/config.ts";
import type { McpServerConfig } from "../src/types.ts";

const config = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: "echo-1",
  slug: "echo",
  label: "Echo",
  enabled: true,
  transport: "stdio",
  command: "node",
  args: ["server.mjs"],
  env: { TOKEN: "t" },
  url: "",
  headers: null,
  ...over,
});

test("an identical row is the same connection", () => {
  expect(sameConnection(config(), config())).toBe(true);
});

/**
 * The regression this replaced a `JSON.stringify` for: comparing whole rows bounced a running
 * server — dropping whatever state it held — because someone corrected a typo in its label.
 */
test("a row that changed only in what an operator reads is the same connection", () => {
  const edited = config({ label: "Echo, renamed", slug: "echo2", idleTimeoutMs: 60_000 });

  expect(sameConnection(config(), edited)).toBe(true);
});

test("every field a child process is made of restarts it when it changes", () => {
  const edits: Partial<McpServerConfig>[] = [
    { enabled: false },
    { transport: "http" },
    { command: "python" },
    { url: "https://example.test/mcp" },
    { cwd: "/srv/notes" },
    { args: ["server.mjs", "--verbose"] },
    { env: { TOKEN: "other" } },
    { headers: { Authorization: "Bearer t" } },
  ];

  for (const edit of edits) {
    expect(sameConnection(config(), config(edit)), Object.keys(edit)[0]).toBe(false);
  }
});

test("absent and empty are the same absence", () => {
  // A row that has never had one of these and a row whose one was cleared reach the same child,
  // so a migration that starts writing `[]` where it used to write `null` restarts nothing.
  expect(sameConnection(config({ args: null }), config({ args: [] }))).toBe(true);
  expect(sameConnection(config({ args: [] }), config({ args: null }))).toBe(true);
  expect(sameConnection(config({ env: null }), config({ env: {} }))).toBe(true);
  expect(sameConnection(config({ headers: null }), config({ headers: {} }))).toBe(true);
  expect(sameConnection(config({ cwd: null }), config({ cwd: undefined }))).toBe(true);
  expect(sameConnection(config({ cwd: null }), config({ cwd: "" }))).toBe(true);
});

test("args and env are compared by value, not by identity", () => {
  // Two rows read out of a database are never the same object, so a reference comparison here
  // would restart every server on every sync.
  const args = ["server.mjs"];
  expect(sameConnection(config({ args }), config({ args: [...args] }))).toBe(true);
  // Order is part of an argv, though.
  expect(sameConnection(config({ args: ["a", "b"] }), config({ args: ["b", "a"] }))).toBe(false);
  expect(
    sameConnection(config({ env: { A: "1", B: "2" } }), config({ env: { B: "2", A: "1" } })),
  ).toBe(true);
});

/**
 * `undefined` means every connected server; an *empty* scope means none of them, which is what a
 * caller wants for an agent with no servers linked to it. Collapsing the two would hand such an
 * agent every server the pool has.
 */
test("no scope and an empty scope are different answers", () => {
  expect(scope(undefined)).toBeUndefined();
  expect(scope()).toBeUndefined();
  expect(scope([])).toEqual(new Set());
});

test("a scope is a set of ids, from whatever the caller counted out", () => {
  expect(scope(["a", "b", "a"])).toEqual(new Set(["a", "b"]));
  // Any iterable: callers hand over arrays, sets and the keys of a map.
  expect(scope(new Set(["a"]))).toEqual(new Set(["a"]));
  expect(scope(new Map([["a", 1]]).keys())).toEqual(new Set(["a"]));
});

test("a scope is a copy, so a caller's later edit cannot widen a run in flight", () => {
  const servers = ["a"];
  const allowed = scope(servers);
  servers.push("b");

  expect(allowed?.has("b")).toBe(false);
});
