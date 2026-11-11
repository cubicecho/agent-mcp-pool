/**
 * A pool of long-lived Model Context Protocol clients for an agent loop.
 *
 * What is here is connection management: reconciling configured servers against the clients
 * actually running, naming their tools so a model can call them, and refusing a call to a server
 * the run was not scoped to. Where the configuration comes from is the caller's — see
 * `McpPoolOptions.load`.
 */

// Re-exported so a consumer can type an `onNotification` or `onElicit` listener, a row's
// `logLevel`, or the capabilities `state()` reports, without depending on the SDK's module layout — which this
// package pins through its peer dependency anyway.
export type {
  CallToolResult,
  ElicitRequestParams,
  ElicitResult,
  LoggingLevel,
  Notification,
  Prompt,
  PromptReference,
  Resource,
  ResourceTemplate,
  ResourceTemplateReference,
  ServerCapabilities,
  Tool,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
export { type CoercedArguments, coerceArguments } from "./arguments.ts";
export {
  httpStatusFor,
  McpPoolError,
  type McpPoolErrorCode,
  type McpPoolErrorOptions,
} from "./errors.ts";
export { type FingerprintedTool, toolsFingerprint } from "./fingerprint.ts";
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
  readVeto,
  templatePaths,
  VETO_EVENTS,
  validateHooks,
} from "./hooks.ts";
export {
  type ListedPrompt,
  type ListedResource,
  type ListedResourceTemplate,
  type ListedTool,
  listAllPrompts,
  listAllResources,
  listAllResourceTemplates,
  listAllTools,
} from "./listing.ts";
export type {
  CallOptions,
  DescribeOptions,
  ElicitHandler,
  ListingOptions,
  McpPoolOptions,
  PoolLog,
  ReadResourceOptions,
  RunHooksOptions,
  SafetyOptions,
  SearchOptions,
  ServerRequestOptions,
  StateOptions,
  ToolsOptions,
} from "./options.ts";
export { McpPool } from "./pool.ts";
export { type ProbeOptions, probe } from "./probe.ts";
export type { ResultCacheOptions } from "./result-cache.ts";
export {
  promptText,
  resourceContentsText,
  resultLinks,
  resultText,
  truncateText,
} from "./results.ts";
export { rankTools, type SearchableTool } from "./search.ts";
export {
  fromMcpServersJson,
  LOG_LEVELS,
  type McpServersJsonOptions,
  sameConnection,
  serversWith,
  validateServerConfig,
  validateServers,
} from "./servers.ts";
export {
  createTransport,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  keepAliveFetch,
  MINIMAL_CHILD_ENV,
  readStderrTail,
  sessionLost,
  type TransportFactory,
  type TransportOptions,
} from "./transport.ts";
export type {
  CachedTools,
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
  PoolCloseReason,
  PoolEvent,
  ResourceLink,
  ResourceText,
  ServerLogEntry,
  ServerPrompts,
  ServerResources,
  StdioServerConfig,
  ToolAnswer,
  ToolDefinition,
  ToolHook,
  ToolInfo,
  ToolSafety,
  ToolsCache,
} from "./types.ts";
