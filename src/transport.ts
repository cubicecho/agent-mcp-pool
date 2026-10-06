import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Agent } from "undici";
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

/**
 * How long an idle connection to an http server is kept, in ms, where the server does not say.
 *
 * Node's own `fetch` gives up on one after 4s, and an agent thinks for longer than that between
 * two tool calls: every call after a pause then pays a TCP and TLS handshake first, which against
 * a remote server was 300ms measured where a kept connection took 30.
 */
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 30_000;

/**
 * A `fetch` that keeps its idle connections for longer than Node's 4s.
 *
 * What `createTransport` dials an http server with unless it is handed another, and exported for a
 * consumer that wants a different number — or the same connections under requests of its own.
 * Each call makes its own set of connections, so make one and share it.
 *
 * A server that answers with a `Keep-Alive: timeout=N` header is taken at its word instead, and
 * Node's own http server sends `timeout=5` unless told otherwise. The number here is for the ones
 * that say nothing, which a server behind nginx or a load balancer usually does.
 *
 * @param timeoutMs How long a connection may sit idle before it is closed.
 * @returns A `fetch` for `TransportOptions.fetch`. Its idle sockets do not hold the process open.
 */
export function keepAliveFetch(timeoutMs: number = DEFAULT_KEEP_ALIVE_TIMEOUT_MS): FetchLike {
  const dispatcher = new Agent({ keepAliveTimeout: timeoutMs });
  // Node's `fetch` takes a dispatcher its DOM-shaped `RequestInit` does not declare.
  return (url, init) => fetch(url, { ...init, dispatcher } as RequestInit);
}

/** The `fetch` every transport shares by default. Made on first use: a stdio-only pool has none. */
let sharedFetch: FetchLike | undefined;

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
  /**
   * What an http transport makes its requests with. Defaults to `keepAliveFetch()`, shared by
   * every transport built without one.
   *
   * The seam for a proxy, a recorded response or a longer keep-alive, without replacing the whole
   * transport through `createTransport`. Ignored over stdio.
   */
  fetch?: FetchLike;
}

/**
 * What builds the transport for one connection, where the pool's own construction is not wanted.
 *
 * The seam a test uses to hand the pool one end of an in-memory pair instead of spawning a child —
 * see `@cubicecho/agent-mcp-pool/testing` — and where a consumer plugs a transport the pool does
 * not know, such as a socket or a worker. `createTransport` is the default.
 *
 * @param config The row being dialled, as the pool holds it.
 * @param options The pool's environment policy and its `fetch`, for a factory that still spawns
 *   or still dials.
 * @returns An unconnected transport. A factory that throws fails the connect like a child that
 *   would not start.
 */
export type TransportFactory = (config: McpConnection, options: TransportOptions) => Transport;

/**
 * The transport a config asks for, stdio or streamable HTTP, ready to connect.
 *
 * Exported because the pool is not the only thing that dials: `probe` uses it on a config that is
 * not saved yet, and a consumer proxying MCP wants the pool's construction rather than a second,
 * subtly different one.
 *
 * @param config The connection half of a row. `transport` picks the arm; the field that arm needs
 *   — `command` or `url` — must be set, or this throws. The type requires it, so a TypeScript
 *   consumer cannot reach these throws; they are for a JavaScript one, and for a row that came
 *   out of a database column that allows null.
 * @param options `childEnv`, which narrows what a stdio child inherits, and `fetch`, which an
 *   http transport makes its requests with. Each is ignored by the other arm.
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
  sharedFetch ??= keepAliveFetch();
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers ?? {} },
    fetch: options.fetch ?? sharedFetch,
  });
}

/**
 * Whether a request failed because the server no longer has the session it was sent on.
 *
 * A streamable HTTP server that restarts, or reaps a session it took for abandoned, goes on
 * answering — so the transport never closes, the pool never hears of it, and every request after
 * that is refused for as long as the client is kept. Two refusals mean it: `404` to a session id
 * the server does not know, which the spec says to answer with a new session, and `400` to a
 * request carrying none, from a server that was stateless when this client joined and has come
 * back wanting one. A `400` to a client that does hold a session is about the request instead.
 *
 * Both are sent before the server dispatches anything, so the request did not run and sending it
 * again on a new connection cannot run it twice.
 *
 * @param transport The transport the request went out on. Read structurally, as a
 *   `TransportFactory`'s is whatever it built.
 * @param error What the request rejected with.
 * @returns True where a new connection is the remedy. Always false over stdio.
 */
export function sessionLost(transport: Transport | undefined, error: unknown): boolean {
  if (!(error instanceof StreamableHTTPError)) return false;
  return transport?.sessionId === undefined ? error.code === 400 : error.code === 404;
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
 * @param transport From `createTransport` or a `TransportFactory`, connected or not.
 * @returns A reader for the last 4000 characters written, trimmed — always empty for a transport
 *   with no `stderr` stream, which is every one but stdio.
 */
export function readStderrTail(transport: Transport | PoolTransport): () => string {
  let tail = "";
  // Read structurally: a factory's transport is whatever it built, so the only question worth
  // asking is whether it has a stream to listen to.
  const stderr = "stderr" in transport ? (transport as { stderr?: unknown }).stderr : null;
  if (!isEmitter(stderr)) return () => tail;
  stderr.on("data", (chunk: unknown) => {
    tail = (tail + String(chunk)).slice(-STDERR_TAIL_LIMIT);
  });
  return () => tail.trim();
}

/** Whether a value can be listened to — the one thing `readStderrTail` needs of a stream. */
const isEmitter = (
  value: unknown,
): value is { on(event: string, listener: (chunk: unknown) => void): unknown } =>
  typeof (value as { on?: unknown } | null)?.on === "function";
