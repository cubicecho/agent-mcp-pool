/**
 * A configured MCP server, as this package needs it.
 *
 * The three servers that consume this each store these rows differently — two as a Drizzle
 * `mcp_servers` table, one as a zod-validated config object — but the nine fields are the same
 * nine in all three, so the type is declared here and satisfied structurally. A consumer passes
 * its own rows straight in; nothing here imports a schema.
 */
export interface McpServerConfig {
  id: string;
  /** Namespace for this server's tools: the model sees `<slug>__<tool name>`. */
  slug: string;
  label: string;
  enabled: boolean;
  transport: "stdio" | "http";
  // stdio
  command: string;
  args: string[] | null;
  env: Record<string, string> | null;
  // streamable http
  url: string;
  headers: Record<string, string> | null;
}

/** What it takes to reach a server — the connection half of a row, without its identity. */
export type McpConnection = Pick<
  McpServerConfig,
  "transport" | "command" | "args" | "env" | "url" | "headers"
>;

export type McpStatus = "disabled" | "connecting" | "ready" | "error";

/** One connected server as an operator sees it. */
export interface McpServerState {
  id: string;
  slug: string;
  label: string;
  status: McpStatus;
  error: string;
  tools: { name: string; description: string }[];
}

export interface McpProbe {
  ok: boolean;
  error: string;
  tools: { name: string; description: string }[];
}
