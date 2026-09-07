import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

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
 * @param options Passed to every page, so a timeout bounds each request rather than the walk.
 * @returns The pages concatenated, in the order the server sent them.
 * @throws If the server repeats a cursor, which would otherwise page forever. A truncated list is
 *   a wrong answer that looks right; a server that cannot paginate should be visible as broken.
 */
export async function listAllTools(
  client: Client,
  options?: RequestOptions,
): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools({ cursor }, options);
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
