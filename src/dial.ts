import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { requestBudget } from "./budget.ts";
import { listAllTools } from "./listing.ts";

/**
 * The handshake and the tool list, on one clock.
 *
 * The pool's connect and a probe both make these requests, and the rule they share is the one that
 * is easy to lose when it is written twice: `timeoutMs` is a deadline for the sequence, not an
 * allowance per request — see `requestBudget`. A dial that hands the same number to `initialize`
 * and to each page waits `timeout × (1 + pages)`, and the page count is the server's choice.
 *
 * @param client A client that has not connected yet. Left connected, whatever the list did.
 * @param transport What to connect it over. The caller keeps it — for a stdio child's stderr and
 *   pid, which are read before and after this.
 * @param options `timeoutMs` bounds the handshake and every page together; absent or `null` leaves
 *   each request the SDK's own default. `listTools: false` stops at the handshake, for a pool that
 *   does not index — see `McpPoolOptions.indexTools`.
 * @returns Every page of the server's tools, or none where the list was not asked for.
 */
export async function dial(
  client: Client,
  transport: Transport,
  { timeoutMs, listTools = true }: { timeoutMs?: number | null; listTools?: boolean } = {},
) {
  const remaining = requestBudget(timeoutMs);
  await client.connect(transport, remaining());
  // Every page: a tool that landed on page two is missing from the index, and `call()` then
  // refuses it as a tool that does not exist — and a probe that under-reports shows a person
  // fewer tools than the server has.
  return listTools ? listAllTools(client, remaining()) : [];
}
