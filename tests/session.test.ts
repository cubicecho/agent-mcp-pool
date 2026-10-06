import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, test } from "vitest";
import { McpPool } from "../src/pool.ts";
import { sessionLost } from "../src/transport.ts";
import type { PoolEvent } from "../src/types.ts";

/**
 * A remote server that forgets a session goes on answering, so nothing closes and the pool is
 * never told: the entry stays `ready` and every request on it is refused. That needs a server
 * which really speaks streamable HTTP and really holds sessions, which no fixture did — the stdio
 * ones cannot lose a session, and the listeners in `transport.test.ts` never get as far as one.
 */
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/**
 * A pool with one remote server whose sessions the test can take away, and which can be switched
 * from stateless to stateful the way a redeploy with a new setting switches one.
 */
const remote = async (options: { stateful: boolean }) => {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let initializes = 0;
  const serve = async (transport: StreamableHTTPServerTransport) => {
    const server = new McpServer({ name: "remote", version: "1.0.0" });
    server.tool("noop", "Does nothing.", {}, () => ({ content: [{ type: "text", text: "done" }] }));
    await server.connect(transport);
    return server;
  };
  const refuse = (response: http.ServerResponse, status: number, error: string) =>
    response
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify({ error }));

  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const initialize = (body as { method?: string } | undefined)?.method === "initialize";
    if (initialize) initializes += 1;

    if (!options.stateful) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = await serve(transport);
      response.on("close", () => void mcp.close());
      await transport.handleRequest(request, response, body);
      return;
    }
    const id = request.headers["mcp-session-id"];
    if (typeof id === "string") {
      const known = sessions.get(id);
      if (!known) return refuse(response, 404, "Unknown MCP session");
      await known.handleRequest(request, response, body);
      return;
    }
    if (!initialize) return refuse(response, 400, "Missing Mcp-Session-Id header");
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${initializes}`,
      enableJsonResponse: true,
      onsessioninitialized: (created) => {
        sessions.set(created, transport);
      },
    });
    await serve(transport);
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const pool = new McpPool();
  const events: PoolEvent[] = [];
  pool.onEvent((event) => events.push(event));
  closers.push(async () => {
    await pool.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await pool.sync([
    {
      id: "remote",
      slug: "remote",
      label: "remote",
      enabled: true,
      transport: "http",
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      headers: null,
    },
  ]);
  return {
    pool,
    options,
    events,
    initializes: () => initializes,
    forgetSessions: () => sessions.clear(),
  };
};

const toolNames = async (client: Client) =>
  (await client.listTools()).tools.map((tool) => tool.name);

test("use() redials a server that has forgotten the session, and answers the request", async () => {
  const { pool, events, initializes, forgetSessions } = await remote({ stateful: true });
  expect(await pool.use("remote", toolNames)).toEqual(["noop"]);
  forgetSessions();

  // What `client()` alone leaves a consumer with: a client that keeps the dead id.
  const stale = await pool.client("remote");
  await expect(stale.listTools()).rejects.toThrow(/Unknown MCP session/);
  expect(pool.state()[0]?.status).toBe("ready");

  expect(await pool.use("remote", toolNames)).toEqual(["noop"]);

  expect(initializes()).toBe(2);
  expect(await pool.client("remote")).not.toBe(stale);
  expect(events.filter((event) => event.type === "close")).toEqual([
    { type: "close", serverId: "remote", reason: "redial" },
  ]);
});

test("call() redials too, rather than handing the model a transport error", async () => {
  const { pool, initializes, forgetSessions } = await remote({ stateful: true });
  forgetSessions();

  expect(await pool.call("remote__noop", {})).toBe("done");
  expect(initializes()).toBe(2);
});

test("a burst of requests that all find the session gone shares one redial", async () => {
  const { pool, initializes, forgetSessions } = await remote({ stateful: true });
  forgetSessions();

  const results = await Promise.all([
    pool.use("remote", toolNames),
    pool.call("remote__noop", {}),
    pool.use("remote", toolNames),
    pool.call("remote__noop", {}),
  ]);

  expect(results).toEqual([["noop"], "done", ["noop"], "done"]);
  expect(initializes()).toBe(2);
});

test("a server joined stateless that starts asking for a session id is redialled", async () => {
  const { pool, options, initializes } = await remote({ stateful: false });
  options.stateful = true;

  expect(await pool.use("remote", toolNames)).toEqual(["noop"]);
  expect(initializes()).toBe(2);
});

test("any other failure is the caller's, on the connection it had", async () => {
  const { pool, initializes } = await remote({ stateful: true });
  const before = await pool.client("remote");
  let runs = 0;

  await expect(
    pool.use("remote", async () => {
      runs += 1;
      throw new Error("the request itself was wrong");
    }),
  ).rejects.toThrow("the request itself was wrong");

  expect(runs).toBe(1);
  expect(await pool.client("remote")).toBe(before);
  expect(initializes()).toBe(1);
});

test("use() refuses what client() refuses", async () => {
  const { pool } = await remote({ stateful: true });
  await expect(pool.use("nobody", toolNames)).rejects.toMatchObject({ code: "unknown-server" });
});

/** The two refusals, and the one that looks like the second but is about the request. */
test("sessionLost reads 404 with a session held and 400 with none, and nothing else", () => {
  const held = { sessionId: "abc" } as Transport;
  const none = {} as Transport;

  expect(sessionLost(held, new StreamableHTTPError(404, "Unknown MCP session"))).toBe(true);
  expect(sessionLost(none, new StreamableHTTPError(400, "Missing Mcp-Session-Id header"))).toBe(
    true,
  );

  expect(sessionLost(held, new StreamableHTTPError(400, "Bad Request"))).toBe(false);
  expect(sessionLost(none, new StreamableHTTPError(404, "Not Found"))).toBe(false);
  expect(sessionLost(held, new StreamableHTTPError(500, "Internal Server Error"))).toBe(false);
  expect(sessionLost(held, new Error("HTTP 404"))).toBe(false);
  expect(sessionLost(undefined, new StreamableHTTPError(404, "Not Found"))).toBe(false);
});
