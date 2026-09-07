import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConnection } from "./types.ts";

export function createTransport(config: McpConnection) {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error("a stdio server needs a command");
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // The child inherits our environment: an MCP server usually needs PATH to find itself.
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
    });
  }
  if (!config.url) throw new Error("an http server needs a url");
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers ?? {} },
  });
}
