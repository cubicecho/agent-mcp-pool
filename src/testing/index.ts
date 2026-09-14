/**
 * Test helpers: an MCP server that runs in-process, and a pool wired to reach it without a child.
 *
 * Every consumer's suite used to declare its own `makePool()` and its own stdio fixture, and every
 * test of the pool itself spawned a process it was not about. Imported from
 * `@cubicecho/agent-mcp-pool/testing`; nothing here is loaded by the main entry.
 */

import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { McpPool, type McpPoolOptions } from "../pool.ts";
import type { TransportFactory } from "../transport.ts";
import type { HttpServerConfig } from "../types.ts";

/**
 * The echo server's tools: `ping`, `echo`, `add`, and a `read` that carries annotations, a title
 * and an output schema, so a test can see metadata go through.
 */
export const ECHO_TOOLS: Tool[] = [
  { name: "ping", description: "replies pong", inputSchema: { type: "object", properties: {} } },
  {
    name: "echo",
    description: "echoes the text back",
    inputSchema: { type: "object", properties: { text: { type: ["string", "null"] } } },
  },
  {
    name: "add",
    description: "adds two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "read",
    title: "Read a note",
    description: "reads a note by path",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
    outputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
];

/** What `echoServer` takes. */
export interface EchoServerOptions {
  /** The tools to list instead of `ECHO_TOOLS`. Every one answers the same way. */
  tools?: Tool[];
  /** Sent in `initialize`, as a server's own guidance for a model. */
  instructions?: string;
}

/**
 * An MCP server whose tools answer with what they were asked, for a pool to connect to.
 *
 * A tool call answers `name({...arguments})` as text, unless an argument asks for something else:
 * `sleepMs` waits first, `fail` answers `isError` (a string is the message), `empty` answers no
 * content, `image` an image block, `repeat` that many characters of text, and `structured` a
 * `structuredContent` with its JSON mirrored in a text block.
 *
 * @param options Which tools to list, and the instructions to send.
 * @returns An unconnected server. One per connection: an SDK server connects once.
 */
export function echoServer({ tools = ECHO_TOOLS, instructions }: EchoServerOptions = {}): Server {
  const server = new Server(
    { name: "echo", version: "0.0.1" },
    { capabilities: { tools: {} }, instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = request.params.arguments ?? {};
    if (args.sleepMs) await new Promise((done) => setTimeout(done, Number(args.sleepMs)));
    if (args.fail) {
      const text = typeof args.fail === "string" ? args.fail : "the tool failed on purpose";
      return { content: [{ type: "text", text }], isError: true };
    }
    if (args.empty) return { content: [] };
    if (args.image) return { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] };
    if (args.repeat) return { content: [{ type: "text", text: "x".repeat(Number(args.repeat)) }] };
    if (args.structured) {
      const structuredContent = { greeting: "hello", tools: tools.length };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    }
    return {
      content: [{ type: "text", text: `${request.params.name}(${JSON.stringify(args)})` }],
    };
  });
  return server;
}

/** Anything that connects to a transport the way an SDK `Server` or `McpServer` does. */
export interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
}

/**
 * A transport factory that reaches in-process servers by name, for `McpPoolOptions.createTransport`.
 *
 * The name is the host of a `memory://<name>` url, not the row id: `probe` dials a connection that
 * has no id, and a url is what both paths share. `memoryRow` writes that url.
 *
 * @param servers One builder per server name. Called on every connect, since a reconnect needs a fresh
 *   server: an SDK server connects once.
 * @returns A factory that links a new in-memory pair per connect. A row with no builder throws,
 *   which the pool reports as a connect that failed.
 */
export function memoryTransport(
  servers: Record<string, () => ConnectableServer>,
): TransportFactory {
  return (config) => {
    const url = config.transport === "http" ? config.url : "";
    const name = url.startsWith("memory://") ? url.slice("memory://".length) : "";
    const build = Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (!build) throw new Error(`no in-memory server for "${url || config.transport}"`);
    const [client, server] = InMemoryTransport.createLinkedPair();
    // Not awaited: the server attaches its handler before its first await, and anything the client
    // sends before then is queued by the transport.
    build()
      .connect(server)
      .catch(() => {});
    return client;
  };
}

/**
 * A row for an in-memory server. The http arm, because a row needs a transport and a url is the
 * one field that need not point at anything real once `createTransport` is replaced.
 *
 * @param id The row's id, slug and label, and the name `memoryTransport` looks it up by.
 * @param over Fields to set on top.
 */
export function memoryRow(id: string, over: Partial<HttpServerConfig> = {}): HttpServerConfig {
  return {
    id,
    slug: id,
    label: id,
    enabled: true,
    transport: "http",
    url: `memory://${id}`,
    ...over,
  };
}

/**
 * A pool for a test: silent, named, and reaching in-process servers where `servers` is given.
 *
 * @param options `servers` maps server names to builders (see `memoryTransport`); the rest is
 *   passed to `McpPool` over the test defaults.
 * @returns A pool that has not synced. `await pool.sync([memoryRow("echo")])` to connect it.
 */
export function makePool({
  servers,
  ...options
}: McpPoolOptions & { servers?: Record<string, () => ConnectableServer> } = {}): McpPool {
  return new McpPool({
    clientName: "mcp-pool-test",
    log: {},
    ...(servers ? { createTransport: memoryTransport(servers) } : {}),
    ...options,
  });
}

/**
 * The path of a stdio script that serves `echoServer()`, for a test that wants a real child.
 *
 * `{ transport: "stdio", command: process.execPath, args: [echoServerPath] }` is a row for it.
 */
export const echoServerPath = fileURLToPath(
  new URL(`./echo-stdio.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url),
);
