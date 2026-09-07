import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { errorMessage } from "./errors.ts";
import type { TransportOptions } from "./transport.ts";
import { createTransport, readStderrTail } from "./transport.ts";
import type { McpConnection, McpProbe } from "./types.ts";

/**
 * Connects to a config that may not be saved yet, lists its tools, and hangs up.
 *
 * What a "Test connection" button calls: a config is easy to get subtly wrong, and finding out
 * at 3am when the task runs is too late. The client is disposable — the pool keeps the
 * long-lived ones.
 */
export async function probe(
  config: McpConnection,
  clientName = "agent-mcp-pool",
  // The same environment policy as the pool: a probe that hands the child a different
  // environment answers a question nobody asked.
  options: TransportOptions = {},
): Promise<McpProbe> {
  const client = new Client({ name: `${clientName}-probe`, version: "0.1.0" });
  let stderrTail = () => "";
  try {
    const transport = createTransport(config, options);
    stderrTail = readStderrTail(transport);
    await client.connect(transport);
    const { tools } = await client.listTools();
    return {
      ok: true,
      error: "",
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
    };
  } catch (error) {
    return { ok: false, error: stderrTail() || errorMessage(error), tools: [] };
  } finally {
    await client.close().catch(() => {});
  }
}
