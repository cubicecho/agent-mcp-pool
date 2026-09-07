/**
 * A pool of long-lived Model Context Protocol clients for an agent loop.
 *
 * What is here is the connection management: reconciling a set of configured servers against
 * the clients actually running, naming their tools so a model can call them, and refusing a
 * call to a server the run was not scoped to. Where the configuration comes from is the
 * caller's — see `McpPoolOptions.load`.
 */

// Re-exported so a consumer can type an `onNotification` listener without depending on the SDK's
// module layout, which this package pins through its peer dependency anyway.
export type { Notification } from "@modelcontextprotocol/sdk/types.js";
export { McpPool, type McpPoolOptions } from "./pool.ts";
export { probe } from "./probe.ts";
export {
  createTransport,
  MINIMAL_CHILD_ENV,
  readStderrTail,
  type TransportOptions,
} from "./transport.ts";
export type {
  CatalogServer,
  McpConnection,
  McpProbe,
  McpServerConfig,
  McpServerState,
  McpStatus,
} from "./types.ts";
