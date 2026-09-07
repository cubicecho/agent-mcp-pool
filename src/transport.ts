import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConnection } from "./types.ts";

/** How much of a child's stderr is kept. Enough for a stack trace, bounded for a chatty server. */
const STDERR_TAIL_LIMIT = 4000;

/**
 * A short allowlist of variables a stdio child usually cannot start without.
 *
 * A starting point for `McpPoolOptions.childEnv`, not the default — narrowing breaks any server
 * that quietly relies on a variable this list omits. Pass it once you know what yours need.
 */
export const MINIMAL_CHILD_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "NODE_ENV",
  "LANG",
  "TERM",
  "UV_CACHE_DIR",
  "UV_PYTHON_INSTALL_DIR",
];

/** Whichever transport a config asks for. */
export type PoolTransport = ReturnType<typeof createTransport>;

/** What a transport takes beyond the config itself. */
export interface TransportOptions {
  /**
   * Which of this process's own environment variables a stdio child inherits.
   *
   * Absent means all of them, which is why this option exists: an MCP server is third-party code,
   * and a full inherit hands it every API key this process was started with. Per-server `env` is
   * applied on top either way.
   */
  childEnv?: readonly string[];
}

/**
 * The transport a config asks for, stdio or streamable HTTP, ready to connect.
 *
 * Exported because the pool is not the only thing that dials: `probe` uses it on a config that is
 * not saved yet, and a consumer proxying MCP wants the pool's construction rather than a second,
 * subtly different one.
 *
 * @param config The connection half of a row. `transport` picks the arm; the field that arm needs
 *   — `command` or `url` — must be set, or this throws.
 * @param options `childEnv`, which narrows what a stdio child inherits. Ignored over http.
 * @returns An unconnected transport. Over stdio the child is not spawned until `connect`.
 */
export function createTransport(config: McpConnection, options: TransportOptions = {}) {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error("a stdio server needs a command");
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...inheritedEnv(options.childEnv), ...(config.env ?? {}) },
      // Undefined rather than null when unset: the SDK reads an explicit null as a cwd.
      cwd: config.cwd ?? undefined,
      // Piped, not inherited: what a failing server wrote on the way out is usually the only
      // explanation, and `inherit` sends it to this process's console where no status page can
      // quote it. Something must then read it (see `readStderrTail`) or the pipe fills.
      stderr: "pipe",
    });
  }
  if (!config.url) throw new Error("an http server needs a url");
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers ?? {} },
  });
}

/** The variables to hand a child, before the server's own `env` is layered on. */
function inheritedEnv(allowed?: readonly string[]): Record<string, string> {
  const env = process.env;
  if (!allowed) return { ...env } as Record<string, string>;
  const picked: Record<string, string> = {};
  for (const key of allowed) {
    const value = env[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

/**
 * Starts collecting a stdio child's stderr, and returns a reader for the last of it.
 *
 * Safe to call before connecting — the SDK hands back its `PassThrough` as soon as the transport
 * exists, which matters because a server that dies during startup does all its talking then.
 * Attaching also keeps the pipe drained. A no-op for an http transport.
 *
 * @param transport From `createTransport`, connected or not.
 * @returns A reader for the last 4000 characters written, trimmed — always empty over http.
 */
export function readStderrTail(transport: PoolTransport): () => string {
  let tail = "";
  // Narrowed rather than optional-chained: an http transport has no `stderr` property at all,
  // and an optional parameter type would accept anything at the call site.
  const stderr = "stderr" in transport ? transport.stderr : null;
  stderr?.on("data", (chunk: unknown) => {
    tail = (tail + String(chunk)).slice(-STDERR_TAIL_LIMIT);
  });
  return () => tail.trim();
}
