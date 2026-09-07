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
  /**
   * Working directory for a stdio child. Absent means this process's own.
   *
   * Optional because the three consumers that predate it store no such column and must keep
   * satisfying this type. Several real servers resolve relative paths — a filesystem root, a
   * sqlite file — against their cwd rather than against an argument, and a gateway that installs
   * each server into its own directory has nowhere else to say so.
   */
  cwd?: string | null;
  // streamable http
  url: string;
  headers: Record<string, string> | null;
}

/** What it takes to reach a server — the connection half of a row, without its identity. */
export type McpConnection = Pick<
  McpServerConfig,
  "transport" | "command" | "args" | "env" | "cwd" | "url" | "headers"
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

/**
 * One server's tools, without their JSON schemas — the cheap half of a tool definition.
 *
 * This mirrors `CatalogServer` in `@cubicecho/agent-core`, which is what that package's
 * on-demand tool loading reads. It is declared here rather than imported because the shape is
 * three fields and TypeScript is structural: `catalog()`'s return value satisfies agent-core's
 * interface without this package depending on it. Keep the two in step.
 */
export interface CatalogServer {
  id: string;
  label: string;
  tools: { name: string; description: string }[];
}
