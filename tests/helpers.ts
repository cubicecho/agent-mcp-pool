import { fileURLToPath } from "node:url";
import type { StdioServerConfig } from "../src/types.ts";

/**
 * What the suites that want a real child share.
 *
 * Not `src/testing`: that is what a consumer imports, and its servers run in-process. These tests
 * are about the child itself — what is spawned, what is left running, what a crash leaves behind.
 */

/** The stdio server every such test spawns. Its behaviour is switched by `MCP_ECHO_*` in `env`. */
export const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url));

/** A row that starts `FIXTURE` under this Node, with whatever a test is about laid over it. */
export const echoRow = (over: Partial<StdioServerConfig> = {}): StdioServerConfig => ({
  id: "echo-1",
  slug: "echo",
  label: "Echo",
  enabled: true,
  transport: "stdio",
  command: process.execPath,
  args: [FIXTURE],
  ...over,
});
