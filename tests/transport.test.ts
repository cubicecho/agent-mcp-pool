import http from "node:http";
import type { AddressInfo } from "node:net";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test } from "vitest";
import { McpPool } from "../src/pool.ts";
import { createTransport, keepAliveFetch, readStderrTail } from "../src/transport.ts";
import type { HttpServerConfig, McpConnection } from "../src/types.ts";

/**
 * The other transport. Everything else in this suite boots a stdio child out of `tests/fixtures`,
 * so until now nothing had ever constructed the http arm — and a config bug there lands in the
 * construction rather than in the protocol. These tests stop short of speaking MCP: a request
 * carries its headers before the server has said anything back, so a listener that records what
 * arrived and answers 500 proves what needs proving.
 */
const config = (over: Partial<HttpServerConfig> = {}): McpConnection => ({
  transport: "http",
  url: "http://127.0.0.1:1/mcp",
  headers: null,
  ...over,
});

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
});

/** A server that records the request it was given and refuses it. Returns its url. */
const recording = async (seen: { headers?: http.IncomingHttpHeaders; path?: string }) => {
  const server = http.createServer((request, response) => {
    seen.headers = request.headers;
    seen.path = request.url;
    response.writeHead(500).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
};

const ping: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "ping" };

/** The stdio half of the same guard, which had a test only by accident of the pool having one. */
test("a stdio server with no command is refused, rather than spawned as nothing", () => {
  // Cast because the type now says a stdio row has a command — which is the improvement, and
  // leaves this guard reachable only from JavaScript, or from a database column that allows null.
  const row = { transport: "stdio", command: "" } as unknown as McpConnection;
  expect(() => createTransport(row)).toThrow(/a stdio server needs a command/);
});

test("an http server with no url is refused, rather than dialled at nothing", () => {
  expect(() => createTransport(config({ url: "" }))).toThrow(/an http server needs a url/);
});

/**
 * `new URL` rather than the string: a url the SDK cannot parse should fail where the row was
 * written, with the row in hand, and not later inside a request nobody can trace back to it.
 */
test("a url that is not a url is refused at construction", () => {
  expect(() => createTransport(config({ url: "not a url" }))).toThrow(/Invalid URL/);
});

test("an http transport puts the row's headers on the wire", async () => {
  const seen: { headers?: http.IncomingHttpHeaders; path?: string } = {};
  const url = await recording(seen);

  const transport = createTransport(config({ url, headers: { authorization: "Bearer t" } }));
  // A 500 is the point: the headers were sent before this could fail.
  await expect(transport.send(ping)).rejects.toThrow();

  expect(seen.headers?.authorization).toBe("Bearer t");
  // The whole url, not just its origin — a server mounted under a path is the common case.
  expect(seen.path).toBe("/mcp");
});

/**
 * `headers` is nullable on the row, and the option it feeds is not. A null arriving as
 * `{ headers: null }` is the kind of thing that only shows up against a real server.
 */
test("a row with no headers sends none of its own", async () => {
  const seen: { headers?: http.IncomingHttpHeaders; path?: string } = {};
  const url = await recording(seen);

  const transport = createTransport(config({ url, headers: null }));
  await expect(transport.send(ping)).rejects.toThrow();

  expect(seen.headers?.authorization).toBeUndefined();
  // It still sent a request, which is what says the null was handled rather than swallowed.
  expect(seen.headers?.["content-type"]).toContain("application/json");
});

/**
 * A server that counts the connections opened to it and says nothing about how long it keeps one,
 * so the client's own idle timeout is the only thing deciding. Node's default would advertise
 * `timeout=5` and be believed.
 */
const counting = async (seen: { connections: number }) => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(500).end();
  });
  server.keepAliveTimeout = 0;
  server.on("connection", () => {
    seen.connections += 1;
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The reason the option exists. Node's `fetch` drops an idle connection after 4s, so this waits
 * past that: a second connection here means the transport went back to the global `fetch`.
 */
test("an http transport reuses its connection after a pause longer than fetch's own 4s", async () => {
  const seen = { connections: 0 };
  const transport = createTransport(config({ url: await counting(seen) }));

  await expect(transport.send(ping)).rejects.toThrow();
  await pause(4500);
  await expect(transport.send(ping)).rejects.toThrow();

  expect(seen.connections).toBe(1);
}, 10_000);

test("a fetch passed in is the one an http transport dials with", async () => {
  const seen = { connections: 0 };
  const transport = createTransport(config({ url: await counting(seen) }), {
    fetch: keepAliveFetch(50),
  });

  await expect(transport.send(ping)).rejects.toThrow();
  // Past the 50ms this fetch keeps a connection, and far inside the 30s the default would.
  await pause(400);
  await expect(transport.send(ping)).rejects.toThrow();

  expect(seen.connections).toBe(2);
});

/**
 * The pool's half: the option is no use if only a hand-built transport honours it. Both of the
 * pool's dials are checked, since `probe()` builds its transport on a path of its own.
 */
test("a pool's fetch is what its connects and its probes dial with", async () => {
  const dialled: string[] = [];
  const pool = new McpPool({
    log: {},
    fetch: async (url) => {
      dialled.push(String(url));
      return new Response(null, { status: 500 });
    },
  });

  await pool.sync([
    { id: "a", slug: "a", label: "a", enabled: true, ...config({ url: "http://a.test/mcp" }) },
  ]);
  await pool.probe(config({ url: "http://b.test/mcp" }));
  await pool.shutdown();

  expect(dialled).toContain("http://a.test/mcp");
  expect(dialled).toContain("http://b.test/mcp");
});

/**
 * An http transport has no `stderr` property at all, which is why `readStderrTail` narrows rather
 * than optional-chains. Called on one anyway, because the pool calls it on whatever it just built.
 */
test("reading a stderr tail from an http transport is a no-op, not a crash", () => {
  const tail = readStderrTail(createTransport(config()));
  expect(tail()).toBe("");
});
