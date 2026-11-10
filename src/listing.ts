import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { requestBudget } from "./budget.ts";

/**
 * One tool as the SDK reports it, derived from the client rather than restated.
 *
 * `Tool` is exported from the SDK's types too, but the method's own return type is the one that
 * cannot drift from what `listTools` actually hands back.
 */
export type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/** One prompt as `prompts/list` reports it, derived from the client as `ListedTool` is. */
export type ListedPrompt = Awaited<ReturnType<Client["listPrompts"]>>["prompts"][number];

/** One resource as `resources/list` reports it. */
export type ListedResource = Awaited<ReturnType<Client["listResources"]>>["resources"][number];

/** One resource template as `resources/templates/list` reports it. */
export type ListedResourceTemplate = Awaited<
  ReturnType<Client["listResourceTemplates"]>
>["resourceTemplates"][number];

/**
 * More pages than a real tool list has, and the only bound on the walk when nothing set a timeout.
 *
 * The repeated-cursor check catches a server that pages in a circle. One minting a fresh cursor
 * every time walks past it — for ever, accumulating tools, with no error and no request that ever
 * outlives its own budget because each page answers promptly. A pool with no `connectTimeoutMs`
 * has nothing else to stop it.
 */
const MAX_PAGES = 1000;

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
 * @throws If the walk outlasts `timeout`, if the server repeats a cursor, or if it sends more
 *   pages than `MAX_PAGES` — the last two both being ways to page forever, one in a circle and one
 *   in a line. A truncated list is a wrong answer that looks right; a server that cannot paginate
 *   inside its budget should be visible as broken.
 */
export function listAllTools(client: Client, options?: RequestOptions): Promise<ListedTool[]> {
  return drain(
    "tools/list",
    (params, request) => client.listTools(params, request),
    "tools",
    options,
  );
}

/**
 * Every prompt a server offers, following `prompts/list`'s cursor to the end — `listAllTools`'
 * walk, guards and `timeout` reading, for the other list a host shows a person.
 *
 * A picker that read one page showed a paging server's first few templates as all of them, and
 * nothing on the page said more existed.
 *
 * @param client A connected client whose server declared `prompts`; the SDK refuses the request
 *   to one that did not.
 * @param options As for `listAllTools`.
 * @returns The pages concatenated, in the order the server sent them.
 * @throws As `listAllTools` does.
 */
export function listAllPrompts(client: Client, options?: RequestOptions): Promise<ListedPrompt[]> {
  return drain(
    "prompts/list",
    (params, request) => client.listPrompts(params, request),
    "prompts",
    options,
  );
}

/**
 * Every resource a server lists, following `resources/list`'s cursor to the end. See
 * `listAllPrompts`.
 *
 * @param client A connected client whose server declared `resources`.
 * @param options As for `listAllTools`.
 * @returns The pages concatenated, in the order the server sent them.
 * @throws As `listAllTools` does.
 */
export function listAllResources(
  client: Client,
  options?: RequestOptions,
): Promise<ListedResource[]> {
  return drain(
    "resources/list",
    (params, request) => client.listResources(params, request),
    "resources",
    options,
  );
}

/**
 * Every resource template a server offers, following `resources/templates/list`'s cursor to the
 * end. See `listAllPrompts`.
 *
 * @param client A connected client whose server declared `resources` — templates have no
 *   capability of their own.
 * @param options As for `listAllTools`.
 * @returns The pages concatenated, in the order the server sent them.
 * @throws As `listAllTools` does — including the server's own refusal, where it declared
 *   `resources` and implements no templates at all; `McpPool.resources()` reads that one as none.
 */
export function listAllResourceTemplates(
  client: Client,
  options?: RequestOptions,
): Promise<ListedResourceTemplate[]> {
  return drain(
    "resources/templates/list",
    (params, request) => client.listResourceTemplates(params, request),
    "resourceTemplates",
    options,
  );
}

/**
 * The one walk behind every `listAll*`, so the guards are written once and a fifth paginated list
 * cannot be added without them.
 *
 * @param method The request's name, for the errors.
 * @param list One page.
 * @param key Where the page keeps its items.
 */
async function drain<K extends string, T>(
  method: string,
  list: (
    params: { cursor?: string },
    options?: RequestOptions,
  ) => Promise<{ [key in K]: T[] } & { nextCursor?: string }>,
  key: K,
  options?: RequestOptions,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  // One countdown across the pages rather than the caller's number handed to each of them.
  const remaining = requestBudget(options?.timeout);
  let cursor: string | undefined;
  do {
    const page = await list({ cursor }, { ...options, ...remaining() });
    items.push(...page[key]);
    cursor = page.nextCursor;
    if (cursor === undefined) break;
    if (seen.has(cursor)) {
      throw new Error(`the server repeated the ${method} cursor "${cursor}"`);
    }
    seen.add(cursor);
    if (seen.size > MAX_PAGES) {
      throw new Error(`the server sent more than ${MAX_PAGES} pages of ${method}`);
    }
  } while (cursor);
  return items;
}
