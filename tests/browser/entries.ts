/**
 * Compiled by `tsconfig.browser.json`, with no Node types — never run. The compile pulls each
 * entry's whole import graph in with it; `tests/entries.test.ts` checks the runtime half, and that
 * the `exports` map points at these files.
 */
import {
  HOOK_EVENTS,
  type HookEvent,
  hookVars,
  INJECT_EVENTS,
  readVeto,
  type ToolHook,
  VETO_EVENTS,
  validateHooks,
} from "../../src/hooks.ts";
import {
  fromMcpServersJson,
  type McpServerConfig,
  sameConnection,
  serversWith,
  validateServerConfig,
} from "../../src/servers.ts";

const hook: ToolHook = { id: "recall", on: "beforeTurn", tool: "recall", inject: true };
const events: readonly HookEvent[] = HOOK_EVENTS;
const rows: McpServerConfig[] = fromMcpServersJson('{"mcpServers":{}}', { env: {} });

export const checked = [
  events.map(hookVars),
  INJECT_EVENTS.has(hook.on),
  VETO_EVENTS.has(hook.on),
  readVeto('{"veto":true}').veto,
  validateHooks([hook]),
  rows.map(validateServerConfig),
  rows.length > 1 && sameConnection(rows[0], rows[1]),
  serversWith([], "prompts"),
];
