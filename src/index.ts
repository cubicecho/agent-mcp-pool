/**
 * A pool of long-lived Model Context Protocol clients for an agent loop.
 *
 * What is here is connection management: reconciling configured servers against the clients
 * actually running, naming their tools so a model can call them, and refusing a call to a server
 * the run was not scoped to. Where the configuration comes from is the caller's — see
 * `McpPoolOptions.load`.
 */

// Re-exported so a consumer can type an `onNotification` listener, or the capabilities `state()`
// reports, without depending on the SDK's module layout — which this package pins through its
// peer dependency anyway.
export type { Notification, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
export { McpPoolError, type McpPoolErrorCode, type McpPoolErrorOptions } from "./errors.ts";
export {
  type ContextBlocks,
  contextBlocks,
  DEFAULT_HOOK_MAX_TOKENS,
  type ExpandedArgs,
  expandArgs,
  HOOK_EVENTS,
  hookVars,
  INJECT_EVENTS,
  INJECT_TIMEOUT_MS,
  templatePaths,
  validateHooks,
} from "./hooks.ts";
export { listAllTools } from "./listing.ts";
export {
  type CallOptions,
  McpPool,
  type McpPoolOptions,
  type PoolLog,
  type RunHooksOptions,
  type StateOptions,
  type ToolsOptions,
} from "./pool.ts";
export { type ProbeOptions, probe } from "./probe.ts";
export { resultText } from "./results.ts";
export {
  createTransport,
  MINIMAL_CHILD_ENV,
  readStderrTail,
  type TransportOptions,
} from "./transport.ts";
export type {
  CatalogServer,
  ClientIdentity,
  HookContext,
  HookEvent,
  HookMessage,
  HookOutcome,
  HttpServerConfig,
  McpConnection,
  McpProbe,
  McpServerConfig,
  McpServerPublicConfig,
  McpServerState,
  McpStatus,
  StdioServerConfig,
  ToolDefinition,
  ToolHook,
} from "./types.ts";
