import { appendFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// One line per process started. The pool is supposed to keep one child per configured server,
// and nothing it exposes can tell one child from two — so the children say so themselves.
if (process.env.MCP_ECHO_SPAWN_LOG)
  appendFileSync(process.env.MCP_ECHO_SPAWN_LOG, `${process.pid}\n`);

// What this child actually inherited. Written to a file rather than reported through a tool, so
// a test can assert on the environment policy without the server choosing what to say about it.
if (process.env.MCP_ECHO_ENV_DUMP)
  writeFileSync(process.env.MCP_ECHO_ENV_DUMP, JSON.stringify(process.env));

// Fails the way a misconfigured server does: one line of explanation on stderr, then a non-zero
// exit. Nothing the client sees says more than "the connection closed", which is the point.
if (process.env.MCP_ECHO_FAIL) {
  process.stderr.write(`${process.env.MCP_ECHO_FAIL}\n`);
  process.exit(1);
}

/** A stdio MCP server with three trivial tools, for the runner tests to connect to. */
const tools = [
  { name: "ping", description: "replies pong", inputSchema: { type: "object", properties: {} } },
  {
    name: "echo",
    description: "echoes the text back",
    // A union type, so the tests see a real schema go through the sanitizer.
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
];

const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });
// A server that connects cleanly and offers nothing. Rarer than a broken one and easier to miss,
// because every status the pool reports about it says it is fine.
const offered = process.env.MCP_ECHO_NO_TOOLS ? [] : tools;
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: offered }));
server.setRequestHandler(CallToolRequestSchema, (request) => ({
  content: [
    {
      type: "text",
      text: `${request.params.name}(${JSON.stringify(request.params.arguments ?? {})})`,
    },
  ],
}));

// How the client introduced itself. Only the server ever sees which name arrived, and the pool
// and a probe deliberately use different ones, so it writes the name down for the tests.
if (process.env.MCP_ECHO_CLIENT_DUMP) {
  const dump = process.env.MCP_ECHO_CLIENT_DUMP;
  server.oninitialized = () => writeFileSync(dump, JSON.stringify(server.getClientVersion() ?? {}));
}

await server.connect(new StdioServerTransport());
