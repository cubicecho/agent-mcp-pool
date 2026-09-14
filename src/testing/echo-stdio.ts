/**
 * `echoServer()` over stdio, as a script: what `echoServerPath` points at.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { echoServer } from "./index.ts";

await echoServer({ instructions: process.env.MCP_ECHO_INSTRUCTIONS || undefined }).connect(
  new StdioServerTransport(),
);
