import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// One line per process started. The pool is supposed to keep one child per configured server,
// and nothing it exposes can tell one child from two — so the children say so themselves.
if (process.env.MCP_ECHO_SPAWN_LOG)
  appendFileSync(process.env.MCP_ECHO_SPAWN_LOG, `${process.pid}\n`);

// What this child actually inherited. Written to a file rather than reported through a tool, so
// a test can assert on the environment policy without the server choosing what to say about it.
if (process.env.MCP_ECHO_ENV_DUMP)
  writeFileSync(process.env.MCP_ECHO_ENV_DUMP, JSON.stringify(process.env));

// Where the child was started. A stdio server that resolves relative paths against its cwd — a
// filesystem root, a sqlite file — reaches different data depending on this, so a test has to be
// able to see it rather than infer it.
if (process.env.MCP_ECHO_CWD_DUMP) writeFileSync(process.env.MCP_ECHO_CWD_DUMP, process.cwd());

// Fails the way a misconfigured server does: one line of explanation on stderr, then a non-zero
// exit. Nothing the client sees says more than "the connection closed", which is the point.
// Fails the first time it is started and works afterwards, which is what a server recovering
// from a transient problem looks like. The marker file is the memory: a retry is a fresh process
// with no other way to know it is the second one.
if (process.env.MCP_ECHO_FAIL_ONCE && !existsSync(process.env.MCP_ECHO_FAIL_ONCE)) {
  writeFileSync(process.env.MCP_ECHO_FAIL_ONCE, "");
  process.stderr.write("failing once on purpose\n");
  process.exit(1);
}

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

const server = new Server(
  { name: "echo", version: "0.0.1" },
  // Resources as well as tools, because the pool's own surface reaches only the tools half and
  // a test for the raw client has to ask for something that surface cannot express.
  { capabilities: { tools: {}, resources: {} } },
);
// A server that connects cleanly and offers nothing. Rarer than a broken one and easier to miss,
// because every status the pool reports about it says it is fine.
const offered = process.env.MCP_ECHO_NO_TOOLS ? [] : tools;
// How many tools one `tools/list` answers with. Page size is the server's choice rather than the
// client's, so a server is free to send them a few at a time — and a client reading one page
// then reports fewer tools than the server has.
const pageSize = Number(process.env.MCP_ECHO_PAGE_SIZE ?? 0);

// How long each `tools/list` takes to answer. A server that is slow rather than wedged, which is
// the one that shows whether a connect timeout is a budget for the walk or a fresh allowance per
// page: every page answers inside a per-page limit, and the walk still runs past it.
const pageDelayMs = Number(process.env.MCP_ECHO_PAGE_DELAY_MS ?? 0);
const pageDelay = () =>
  pageDelayMs > 0 ? new Promise((resolve) => setTimeout(resolve, pageDelayMs)) : undefined;

// Answers `initialize` and then never answers `tools/list`. A server that fails to start is the
// easy case; this is the one that starts, so the client has a live child on the end of it, and
// then leaves the handshake half-finished.
if (process.env.MCP_ECHO_HANG_TOOLS) {
  server.setRequestHandler(ListToolsRequestSchema, () => new Promise(() => {}));
} else if (process.env.MCP_ECHO_STUCK_CURSOR) {
  // Hands back the cursor it was given, for ever. A client that follows cursors without noticing
  // pages forever, which is worse than either a short list or an error.
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: offered.slice(0, 1),
    nextCursor: "stuck",
  }));
} else if (pageSize > 0) {
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    await pageDelay();
    const start = Number(request.params?.cursor ?? 0);
    const next = start + pageSize;
    return {
      tools: offered.slice(start, next),
      ...(next < offered.length ? { nextCursor: String(next) } : {}),
    };
  });
} else {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await pageDelay();
    return { tools: offered };
  });
}
server.setRequestHandler(CallToolRequestSchema, (request) => {
  // A non-text content block on demand: what a tool returning a chart or a screenshot sends, and
  // what a result flattened to a string cannot carry.
  if (request.params.arguments?.image)
    return { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] };
  return {
    content: [
      {
        type: "text",
        text: `${request.params.name}(${JSON.stringify(request.params.arguments ?? {})})`,
      },
    ],
  };
});
server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [{ uri: "echo://greeting", name: "greeting", mimeType: "text/plain" }],
}));
server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
  contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "hello from a resource" }],
}));

// The SDK has one `oninitialized`, and two things here want it, so they queue rather than
// overwrite each other — a test setting both env vars would otherwise silently get only one.
const onInitialized = [];

// How the client introduced itself. Only the server ever sees which name arrived, and the pool
// and a probe deliberately use different ones, so it writes the name down for the tests.
if (process.env.MCP_ECHO_CLIENT_DUMP) {
  const dump = process.env.MCP_ECHO_CLIENT_DUMP;
  onInitialized.push(() => writeFileSync(dump, JSON.stringify(server.getClientVersion() ?? {})));
}

// Unprompted, the way a server that gained a tool at runtime announces it — and sent during
// startup, which is when a real server's `logging/message` arrives too. The SDK has no handler
// for either, so they reach a client only through its fallback.
if (process.env.MCP_ECHO_NOTIFY) {
  onInitialized.push(() => {
    server.notification({
      method: "notifications/tools/list_changed",
      params: { reason: process.env.MCP_ECHO_NOTIFY },
    });
  });
}

if (onInitialized.length > 0) {
  server.oninitialized = () => {
    for (const hook of onInitialized) hook();
  };
}

await server.connect(new StdioServerTransport());
