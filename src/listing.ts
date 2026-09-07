import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { requestBudget } from "./budget.ts";

/**
 * One tool as the SDK reports it, derived from the client rather than restated.
 *
 * `Tool` is exported from the SDK's types too, but the method's own return type is the one that
 * cannot drift from what `listTools` actually hands back.
 */
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/**
 * Every tool a server offers, following `tools/list`'s cursor to the end.
 *
 * `tools/list` is paginated and the page size is the server's choice, so reading one page is not
 * a "very large server" edge case — a server is free to answer ten at a time. Everything past the
 * first page used to be dropped silently, and a dropped tool is worse than a short catalogue: it
 * is missing from the index, so `call()` refuses it as a tool that does not exist.
 *
 * @param client A connected client.
 * @param options Passed to every page, except that `timeout` bounds the walk rather than each
 *   page of it: the page count is the server's choice, so a per-page number is a ceiling the
 *   caller cannot compute in advance.
 * @returns The pages concatenated, in the order the server sent them.
 * @throws If the walk outlasts `timeout`, or if the server repeats a cursor, which would otherwise
 *   page forever. Either way a truncated list is a wrong answer that looks right; a server that
 *   cannot paginate inside its budget should be visible as broken.
 */
export async function listAllTools(
  client: Client,
  options?: RequestOptions,
): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  const seen = new Set<string>();
  // One countdown across the pages rather than the caller's number handed to each of them.
  const remaining = requestBudget(options?.timeout);
  let cursor: string | undefined;
  do {
    const page = await client.listTools({ cursor }, { ...options, ...remaining() });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor === undefined) break;
    if (seen.has(cursor)) {
      throw new Error(`the server repeated the tools/list cursor "${cursor}"`);
    }
    seen.add(cursor);
  } while (cursor);
  return tools;
}
