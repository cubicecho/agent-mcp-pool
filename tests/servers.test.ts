// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${VAR}` in a plain string is the syntax under test.
import { expect, test } from "vitest";
import {
  fromMcpServersJson,
  sameConnection,
  serversWith,
  validateServerConfig,
} from "../src/servers.ts";
import type { McpServerState } from "../src/types.ts";

// `sameConnection` is tested in config.test.ts, beside the copy it exists to be compared against.

// --- importing mcpServers JSON ------------------------------------------------------------------

test("each named server becomes a row keyed by its name", () => {
  const rows = fromMcpServersJson({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "server-filesystem", "."], env: { ROOT: "/srv" } },
      notes: {
        type: "http",
        url: "https://notes.test/mcp",
        headers: { Authorization: "Bearer t" },
      },
    },
  });

  expect(rows).toEqual([
    {
      id: "fs",
      slug: "fs",
      label: "fs",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "server-filesystem", "."],
      env: { ROOT: "/srv" },
    },
    {
      id: "notes",
      slug: "notes",
      label: "notes",
      enabled: true,
      transport: "http",
      url: "https://notes.test/mcp",
      headers: { Authorization: "Bearer t" },
    },
  ]);
});

test("text is parsed, and every nesting a copy-paste arrives in is read", () => {
  const body = { command: "uvx", args: ["mcp-server-git"] };
  const whole = fromMcpServersJson(JSON.stringify({ mcpServers: { git: body } }));

  expect(fromMcpServersJson({ servers: { git: body } })).toEqual(whole);
  expect(fromMcpServersJson({ git: body })).toEqual(whole);
  expect(fromMcpServersJson(body, { name: "git" })).toEqual(whole);
});

test("a row imports only the fields its server wrote, and disabled is enabled: false", () => {
  const [row] = fromMcpServersJson({ git: { command: "uvx", disabled: true } });

  // An absent `args` stays absent rather than becoming `[]` — the same rule `copyConfig` keeps.
  expect(row).toEqual({
    id: "git",
    slug: "git",
    label: "git",
    enabled: false,
    transport: "stdio",
    command: "uvx",
  });
});

test("a url with no type is http, and every spelling of streamable http is", () => {
  for (const type of [undefined, "http", "streamable-http", "streamableHttp"]) {
    const [row] = fromMcpServersJson({ remote: { type, url: "https://x.test/mcp" } });
    expect(row?.transport, String(type)).toBe("http");
  }
  expect(fromMcpServersJson({ local: { type: "stdio", command: "node" } })[0]?.transport).toBe(
    "stdio",
  );
});

test("${VAR} is filled from the environment given, and left as written when it has no value", () => {
  const [stdio, http] = fromMcpServersJson(
    {
      local: {
        command: "${BIN}",
        args: ["--root", "${ROOT:-/tmp}", "${MISSING}"],
        env: { TOKEN: "${TOKEN}", EMPTY: "${EMPTY:-fallback}" },
        cwd: "${HOME}/notes",
      },
      remote: { url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    },
    { env: { BIN: "node", TOKEN: "t", EMPTY: "", HOME: "/home/me", HOST: "x.test" } },
  );

  expect(stdio).toMatchObject({
    command: "node",
    args: ["--root", "/tmp", "${MISSING}"],
    env: { TOKEN: "t", EMPTY: "fallback" },
    cwd: "/home/me/notes",
  });
  expect(http).toMatchObject({
    url: "https://x.test/mcp",
    headers: { Authorization: "Bearer t" },
  });
});

test("the environment defaults to this process's", () => {
  process.env.AGENT_MCP_POOL_TEST_VAR = "from-process";
  try {
    const [row] = fromMcpServersJson({ s: { command: "${AGENT_MCP_POOL_TEST_VAR}" } });
    expect(row).toMatchObject({ command: "from-process" });
  } finally {
    delete process.env.AGENT_MCP_POOL_TEST_VAR;
  }
});

test("a paste that cannot become rows says why", () => {
  expect(() => fromMcpServersJson("{ nope")).toThrow("not valid JSON");
  expect(() => fromMcpServersJson([])).toThrow("must be a JSON object");
  expect(() => fromMcpServersJson({ mcpServers: {} })).toThrow("no server found");
  expect(() => fromMcpServersJson({ mcpServers: [] })).toThrow("object of named servers");
  expect(() => fromMcpServersJson({ command: "npx" })).toThrow("needs `name`");
  expect(() => fromMcpServersJson({ fs: "npx" })).toThrow('server "fs" must be an object');
  // SSE is refused rather than imported as an http row that could never connect.
  expect(() => fromMcpServersJson({ old: { type: "sse", url: "https://x.test/sse" } })).toThrow(
    "SSE",
  );
  expect(() => fromMcpServersJson({ odd: { type: "websocket", url: "ws://x" } })).toThrow(
    '"websocket"',
  );
});

test("an imported row that is still wrong is left for the validator to name", () => {
  const [row] = fromMcpServersJson({ "my server": { command: "" } });

  expect(validateServerConfig(row)).toEqual([
    expect.stringMatching(/^"my server" cannot namespace tool names/),
    "needs a command",
  ]);
});

// --- validating a row ---------------------------------------------------------------------------

test("a well-formed row of either arm has nothing wrong with it", () => {
  expect(
    validateServerConfig({
      id: "fs",
      label: "Files",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: null,
      env: { A: "1" },
      idleTimeoutMs: 0,
      maxResultChars: 0,
      hooks: [{ id: "r", on: "beforeTurn", tool: "recall", inject: true }],
    }),
  ).toEqual([]);
  expect(
    validateServerConfig({
      id: "notes-1",
      slug: "notes",
      label: "",
      enabled: false,
      transport: "http",
      url: "http://localhost:3000/mcp",
      headers: null,
      hiddenTools: ["remember"],
    }),
  ).toEqual([]);
});

test("validation reports every problem with a row, including its hooks'", () => {
  expect(validateServerConfig("fs")).toEqual(["a server must be an object"]);
  expect(
    validateServerConfig({
      id: " ",
      transport: "stdio",
      command: 5,
      args: ["a", 1],
      env: { A: 1 },
      cwd: false,
      idleTimeoutMs: -1,
      connectTimeoutMs: 0,
      callTimeoutMs: 1.5,
      maxResultChars: "big",
      coerceArguments: "no",
      hiddenTools: "remember",
      hooks: [{ id: "h", on: "never", tool: "t" }],
    }),
  ).toEqual([
    "needs an id",
    "label must be a string",
    "enabled must be true or false",
    "needs a command",
    "args must be a list of strings",
    "env must be an object of strings",
    "cwd must be a string",
    "idleTimeoutMs must be a whole number, 0 or more",
    "connectTimeoutMs must be a positive whole number",
    "callTimeoutMs must be a positive whole number",
    "maxResultChars must be a whole number, 0 or more",
    "coerceArguments must be true or false",
    "hiddenTools must be a list of tool names",
    expect.stringMatching(/^hook "h": "never" is not an event/),
  ]);
});

test("an http row needs a url that is http, and a transport has to be one of the two", () => {
  const row = { id: "r", label: "R", enabled: true };

  expect(validateServerConfig({ ...row, transport: "http" })).toEqual(["needs a url"]);
  expect(validateServerConfig({ ...row, transport: "http", url: "notes.test/mcp" })).toEqual([
    '"notes.test/mcp" is not an http or https url',
  ]);
  expect(validateServerConfig({ ...row, transport: "http", url: "file:///etc/passwd" })).toEqual([
    '"file:///etc/passwd" is not an http or https url',
  ]);
  expect(
    validateServerConfig({ ...row, transport: "http", url: "https://x.test", headers: [] }),
  ).toEqual(["headers must be an object of strings"]);
  expect(validateServerConfig({ ...row, transport: "sse", url: "https://x.test" })).toEqual([
    'transport must be "stdio" or "http"',
  ]);
});

test("the namespace checked is the effective one: the slug, or the id when there is none", () => {
  const row = { label: "", enabled: true, transport: "stdio", command: "node" };

  // A slug fixes an id that could not name tools, which is what the message tells an operator.
  expect(validateServerConfig({ ...row, id: "a b", slug: "ab" })).toEqual([]);
  expect(validateServerConfig({ ...row, id: "ab", slug: "a.b" })).toEqual([
    expect.stringMatching(/^"a\.b" cannot namespace/),
  ]);
});

// --- capability filter --------------------------------------------------------------------------

const server = (over: Partial<McpServerState>): McpServerState =>
  ({
    id: "s",
    slug: "s",
    label: "S",
    config: { id: "s", label: "S", enabled: true, transport: "stdio", command: "node" },
    status: "ready",
    error: "",
    tools: [],
    ...over,
  }) as McpServerState;

test("serversWith is the connected servers whose handshake offered the capability", () => {
  const prompts = server({ id: "prompts", capabilities: { prompts: {} } });
  const both = server({ id: "both", capabilities: { prompts: {}, resources: {} } });
  const tools = server({ id: "tools", capabilities: { tools: {} } });
  // Idle with a capability left over is not a server this process can ask right now.
  const idle = server({ id: "idle", status: "idle", capabilities: { prompts: {} } });
  const bare = server({ id: "bare" });
  const state = [prompts, both, tools, idle, bare];

  expect(serversWith(state, "prompts")).toEqual([prompts, both]);
  expect(serversWith(state, "resources")).toEqual([both]);
  expect(serversWith([], "prompts")).toEqual([]);
});

test("sameConnection is exported for a host that decides for itself whether an edit reconnects", () => {
  const row = { id: "a", label: "A", enabled: true, transport: "http", url: "https://x" } as const;
  expect(sameConnection(row, { ...row, label: "renamed" })).toBe(true);
  expect(sameConnection(row, { ...row, headers: { A: "1" } })).toBe(false);
});
