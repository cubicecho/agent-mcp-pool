import { errorMessage } from "@cubicecho/agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTransport } from "./transport.ts";
import type { McpConnection, McpProbe } from "./types.ts";

/**
 * Connects to a config that may not be saved yet, lists its tools, and hangs up.
 *
 * This is what a "Test connection" button calls: a config is easy to get subtly wrong, and
 * finding out at 3am when the task runs is too late. The client is disposable — the pool keeps
 * the long-lived ones.
 */
export async function probe(
  config: McpConnection,
  clientName = "agent-mcp-pool",
): Promise<McpProbe> {
  const client = new Client({ name: `${clientName}-probe`, version: "0.1.0" });
  try {
    await client.connect(createTransport(config));
    const { tools } = await client.listTools();
    return {
      ok: true,
      error: "",
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error), tools: [] };
  } finally {
    await client.close().catch(() => {});
  }
}
