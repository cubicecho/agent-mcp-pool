import { expect, test } from "vitest";
import { copyConfig, sameConnection, scope } from "../src/config.ts";
import type { HttpServerConfig, StdioServerConfig } from "../src/types.ts";

const config = (over: Partial<StdioServerConfig> = {}): StdioServerConfig => ({
  id: "echo-1",
  slug: "echo",
  label: "Echo",
  enabled: true,
  transport: "stdio",
  command: "node",
  args: ["server.mjs"],
  env: { TOKEN: "t" },
  ...over,
});

/** The other arm. A row carries one transport's fields, so the pair has to be tested as a pair. */
const remote = (over: Partial<HttpServerConfig> = {}): HttpServerConfig => ({
  id: "echo-1",
  slug: "echo",
  label: "Echo",
  enabled: true,
  transport: "http",
  url: "https://example.test/mcp",
  headers: { Authorization: "Bearer t" },
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
  const stdioEdits: Partial<StdioServerConfig>[] = [
    { enabled: false },
    { command: "python" },
    { cwd: "/srv/notes" },
    { args: ["server.mjs", "--verbose"] },
    { env: { TOKEN: "other" } },
  ];
  for (const edit of stdioEdits) {
    expect(sameConnection(config(), config(edit)), Object.keys(edit)[0]).toBe(false);
  }

  const httpEdits: Partial<HttpServerConfig>[] = [
    { enabled: false },
    { url: "https://example.test/other" },
    { headers: { Authorization: "Bearer other" } },
  ];
  for (const edit of httpEdits) {
    expect(sameConnection(remote(), remote(edit)), Object.keys(edit)[0]).toBe(false);
  }

  // The discriminant itself: two rows that agree on nothing else cannot be the same connection,
  // and it is the comparison every per-arm one is now reached through.
  expect(sameConnection(config(), remote())).toBe(false);
});

test("absent and empty are the same absence", () => {
  // A row that has never had one of these and a row whose one was cleared reach the same child,
  // so a migration that starts writing `[]` where it used to write `null` restarts nothing.
  expect(sameConnection(config({ args: null }), config({ args: [] }))).toBe(true);
  expect(sameConnection(config({ args: [] }), config({ args: null }))).toBe(true);
  expect(sameConnection(config({ env: null }), config({ env: {} }))).toBe(true);
  expect(sameConnection(remote({ headers: null }), remote({ headers: {} }))).toBe(true);
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
/**
 * The entry used to hold the caller's own object, which made the pool's record of what it dialled
 * editable from outside it — and `sameConnection` a comparison between a row and itself.
 */
test("a copied row is the caller's row, and no longer the same object", () => {
  const row = config();
  const copy = copyConfig(row) as StdioServerConfig;

  expect(copy).toEqual(row);
  expect(sameConnection(copy, row)).toBe(true);

  row.args?.push("--edited");
  if (row.env) row.env.TOKEN = "edited";

  // An edit on either side is invisible to the other, which is what lets the pool notice one.
  expect(sameConnection(copy, row)).toBe(false);
  expect(copy.args).toEqual(["server.mjs"]);
  expect(copy.env).toEqual({ TOKEN: "t" });
});

test("the other arm's container is copied too, rather than only the stdio ones", () => {
  const row = remote();
  const copy = copyConfig(row) as HttpServerConfig;

  if (row.headers) row.headers.Authorization = "Bearer edited";

  expect(sameConnection(copy, row)).toBe(false);
  expect(copy.headers).toEqual({ Authorization: "Bearer t" });
});

test("a copy carries only its own arm's fields, rather than the other arm's as empties", () => {
  // The flat row wrote `headers: null` on every stdio server. Rebuilding both arms' containers
  // here would put that back, and `state()` would show an operator a field their row has not got.
  expect(copyConfig(config())).not.toHaveProperty("headers");
  expect(copyConfig(remote())).not.toHaveProperty("env");
});

test("an absent container stays absent in the copy, rather than becoming an empty one", () => {
  // `sameConnection` reads null and empty as the same absence, and `state()` reports the copy —
  // inventing an empty array here would show an operator a field their row does not have.
  const copy = copyConfig(config({ args: null, env: null })) as StdioServerConfig;

  expect(copy.args).toBeNull();
  expect(copy.env).toBeNull();
  expect(copyConfig(remote({ headers: null })) as HttpServerConfig).toHaveProperty("headers", null);
});

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
