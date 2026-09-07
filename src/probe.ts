import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { errorMessage } from "./errors.ts";
import { listAllTools } from "./listing.ts";
import type { TransportOptions } from "./transport.ts";
import { createTransport, readStderrTail } from "./transport.ts";
import type { ClientIdentity, McpConnection, McpProbe } from "./types.ts";
import { DEFAULT_CLIENT_NAME, POOL_VERSION } from "./version.ts";

/** What a probe takes from the caller: the child's environment, and its patience. */
export interface ProbeOptions extends TransportOptions {
  /**
   * How long to wait for the server to answer `initialize` and `tools/list`.
   *
   * Unset leaves the SDK's own 60s default, which is a ceiling rather than a budget: a person is
   * watching a spinner, and a minute of it tells them nothing the tenth second did not.
   */
  timeoutMs?: number;
}

/**
 * Connects to a config that may not be saved yet, lists its tools, and hangs up.
 *
 * What a "Test connection" button calls: a config is easy to get subtly wrong, and finding out
 * at 3am when the task runs is too late. The client is disposable — the pool keeps the
 * long-lived ones.
 *
 * @param config The server to dial. Nothing is stored, so it need not be saved first.
 * @param client How this process introduces itself; `-probe` is appended to the name. A bare
 *   string is the name alone, and reports this package's own version beside it.
 * @param options `childEnv` narrows a stdio child's inheritance, `timeoutMs` bounds the wait.
 * @returns Never throws — a failure is `{ ok: false }` carrying the child's stderr where there is
 *   any, since that is usually the only real explanation.
 */
export async function probe(
  config: McpConnection,
  client: string | ClientIdentity = DEFAULT_CLIENT_NAME,
  // The same environment policy as the pool: a probe that hands the child a different
  // environment answers a question nobody asked.
  { timeoutMs, ...transportOptions }: ProbeOptions = {},
): Promise<McpProbe> {
  // One argument rather than a name and a version side by side: two adjacent strings are two
  // arguments a caller can transpose, and a probe under `1.4.0-probe/my-gateway` is a mistake
  // only the dialled server ever sees.
  const identity = typeof client === "string" ? { name: client } : client;
  const mcpClient = new Client({
    name: `${identity.name}-probe`,
    version: identity.version ?? POOL_VERSION,
  });
  let stderrTail = () => "";
  try {
    const transport = createTransport(config, transportOptions);
    stderrTail = readStderrTail(transport);
    // Both requests, not just the dial: a server that completes the handshake and then wedges on
    // `tools/list` is exactly the kind of misconfiguration a probe is asked about.
    const timeout = timeoutMs === undefined ? undefined : { timeout: timeoutMs };
    await mcpClient.connect(transport, timeout);
    // Every page of them: a probe that under-reports shows a person fewer tools than the server
    // has, which is the same wrong answer the pool used to give.
    const tools = await listAllTools(mcpClient, timeout);
    return {
      ok: true,
      error: "",
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
    };
  } catch (error) {
    return { ok: false, error: stderrTail() || errorMessage(error), tools: [] };
  } finally {
    await mcpClient.close().catch(() => {});
  }
}
