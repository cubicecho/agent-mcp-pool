import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

/**
 * A countdown shared by a sequence of requests, so a timeout bounds the sequence rather than each
 * request in it.
 *
 * The SDK's `timeout` is per request, and a connect is never one request: `initialize`, then a
 * `tools/list` per page — and page size is the server's choice, so a hundred-tool server answering
 * ten at a time is eleven of them. Handing the same number to each makes the real ceiling
 * `timeout × (1 + pages)`, which is not something a consumer can pick a boot budget from: the page
 * count is not knowable in advance, and a server answering each page just inside the limit stalls
 * a reconcile for longer than the SDK's unset 60s the option was set to improve on.
 *
 * Time already spent is subtracted instead. A spent budget asks for `0` rather than skipping the
 * request, so an overrun fails as a timeout — a truncated tool list is a wrong answer that looks
 * right, and a tool missing from the index is one `call()` refuses as a tool that does not exist.
 *
 * @param timeoutMs The budget for the whole sequence. Absent or `null` leaves every request the
 *   SDK's own default, which is what a pool with no `connectTimeoutMs` set wants.
 * @returns What to pass the next request, recomputed on each call — always `undefined` when there
 *   is no budget, so it can be spread or passed straight through either way.
 */
export function requestBudget(timeoutMs?: number | null): () => RequestOptions | undefined {
  if (timeoutMs == null) return () => undefined;
  const deadline = Date.now() + timeoutMs;
  return () => ({ timeout: Math.max(0, deadline - Date.now()) });
}
