import { createHash } from "node:crypto";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { truncateText } from "./results.ts";
import type { McpServerConfig, ToolDefinition } from "./types.ts";

/** Between a server's namespace and its tool's own name, in every name the model sees. */
export const SEPARATOR = "__";

/** OpenAI rejects a function name longer than this, so every qualified name has to fit. */
const NAME_LIMIT = 64;

/**
 * Hex characters of the disambiguating hash on a truncated name.
 *
 * Six is 24 bits — a collision needs thousands of over-long names on one pool — while leaving
 * most of the readable prefix intact.
 */
const HASH_LENGTH = 6;

/**
 * One tool of one connected server, in every shape anything asks for it.
 *
 * The OpenAI definition is built once rather than per request: the agent loop rebuilds its tool
 * array on every iteration, and the schema behind it cannot change without the connection being
 * torn down and remade.
 */
export interface PooledTool {
  /** As the server named it — what `state()` reports and what a call is sent back under. */
  name: string;
  description: string;
  /** The server's own JSON Schema, kept so a rename can rebuild the definition without asking
   * for the schemas again. */
  parameters: Record<string, unknown>;
  /** The server's display name for the tool, where it sent one. Never what the model calls. */
  title?: string;
  /** The server's hints about the tool: read-only, destructive, idempotent, open-world. */
  annotations?: ToolAnnotations;
  /** The JSON Schema the server promises its `structuredContent` matches. */
  outputSchema?: Record<string, unknown>;
  /** The tool's `_meta`, passed through for a consumer that knows what a server puts there. */
  meta?: Record<string, unknown>;
  /** `<slug>__<name>`: what the model sees, and what it calls. */
  qualified: string;
  definition: ToolDefinition;
}

/**
 * The namespace this server's tools live under: its `slug`, or its `id` when it has none.
 *
 * Every read of the field has to agree — a `qualify` defaulting to the id and a `wake` prefix
 * test reading the raw field would build names one of them could not recognise. Empty falls back
 * too, since an empty slug would qualify a tool as `__name`.
 */
export function slugOf(config: Pick<McpServerConfig, "id" | "slug">) {
  return config.slug || config.id;
}

/**
 * What an operator calls this server: its `label`, or the namespace its tools live under.
 *
 * The same fallback as `slugOf` and for the same reason — it was written out at each site that
 * needed it, and the site that forgot showed an operator an empty name for a server the model
 * was being told about by its slug.
 */
export function labelOf(config: Pick<McpServerConfig, "id" | "slug" | "label">) {
  return config.label || slugOf(config);
}

/**
 * Every character OpenAI's `^[a-zA-Z0-9_-]{1,64}$` rejects, which is a wider set than MCP's own
 * rule for a tool name: a server is free to call a tool `fs.read`, and the dot reaches
 * `function.name` unaltered.
 */
const DISALLOWED = /[^A-Za-z0-9_-]/g;

/**
 * The one place a tool's wire name is built, so `call` and `tools` agree.
 *
 * Two rules, in this order. Anything outside OpenAI's character set becomes `_`, since a name the
 * API refuses is not a name — the whole tool array is rejected, so one server naming a tool
 * `fs.read` takes down every other server's tools with it. Then the 64-character limit: plain
 * truncation made two tools sharing a 64-character prefix collapse onto one key, and the second
 * silently replaced the first in the index, so the model was offered a name that dispatched to the
 * wrong tool. An over-long name gives up its tail to a hash instead.
 *
 * The hash is of the name as the server gave it, before the substitution, so `a.b` and `a_b` stay
 * distinct when they are truncated. Under the limit they do not, which is what `reindex` reports;
 * there is no shorter name that is both legal and unique, and a mangled name the model can call is
 * worth more than a legal one nobody can read.
 */
export function qualify(slug: string, tool: string) {
  const built = `${slug}${SEPARATOR}${tool}`;
  const full = built.replace(DISALLOWED, "_");
  if (full.length <= NAME_LIMIT) return full;
  const digest = createHash("sha256").update(built).digest("hex").slice(0, HASH_LENGTH);
  return `${full.slice(0, NAME_LIMIT - HASH_LENGTH - 1)}_${digest}`;
}

/** The shape `qualify` leaves behind when it truncates: the hash it ends every long name with. */
const TRUNCATED_TAIL = new RegExp(`_[0-9a-f]{${HASH_LENGTH}}$`);

/**
 * Whether `qualified` could be a name this slug produced.
 *
 * For a name the pool does not recognise — a tool on a server that is not connected yet, or one
 * the model invented — this is the only sound way to ask which server it would belong to.
 * Splitting the name back into slug and tool is not: `qualify` truncates a long name, and the
 * split of a truncated one names a tool that never existed.
 *
 * A name that was not truncated still carries its whole slug, so the prefix settles it. A
 * truncated name is `NAME_LIMIT` characters ending in its hash, and a slug long enough to be cut
 * into lost its own tail as well — so only its head is there to compare.
 *
 * The prefix is substituted the same way `qualify` builds it. A slug is meant to have passed
 * `validateServerConfig`, which allows no character this touches, but the pool does not enforce
 * that — and a `wake` comparing a raw prefix against a substituted name would never match, so a
 * cold server with an unusual slug could never be woken by one of its own tool names.
 */
export function couldQualify(slug: string, qualified: string) {
  const prefix = `${slug}${SEPARATOR}`.replace(DISALLOWED, "_");
  if (qualified.startsWith(prefix)) return true;
  if (qualified.length !== NAME_LIMIT || !TRUNCATED_TAIL.test(qualified)) return false;
  return prefix.startsWith(qualified.slice(0, NAME_LIMIT - HASH_LENGTH - 1));
}

/**
 * Everything about a tool that its server's name decides.
 *
 * One place, because `connect` builds these and `relabel` rebuilds them; when the two drift, the
 * model calls a name the pool no longer indexes.
 *
 * @param maxDescriptionChars A cap on the description in `definition`, prefix included — see
 *   `McpPoolOptions.maxDescriptionChars`. `PooledTool.description` keeps the server's own text
 *   either way, the way `name` keeps the server's own name.
 */
export function pooledTool(
  config: McpServerConfig,
  tool: Omit<PooledTool, "qualified" | "definition">,
  maxDescriptionChars?: number,
): PooledTool {
  const slug = slugOf(config);
  const qualified = qualify(slug, tool.name);
  // Picked rather than spread: `relabel` hands back a whole `PooledTool`, and its old `definition`
  // must not outlive the name it was built under.
  const { name, description, parameters, title, annotations, outputSchema, meta } = tool;
  return {
    name,
    description,
    parameters,
    ...(title !== undefined ? { title } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(meta !== undefined ? { meta } : {}),
    qualified,
    // Frozen because `tools()` hands this very object out rather than a copy — the agent loop
    // rebuilds its tool array every iteration, and copying every schema each time to guard
    // against an edit nobody makes is the wrong trade. Frozen, an edit that would have silently
    // rewritten what every later run is offered fails at the edit instead. Shallow on purpose:
    // `parameters` is the server's own schema, passed through untouched, and deep-freezing an
    // arbitrary object costs a walk per tool for a case nobody has hit.
    definition: Object.freeze({
      type: "function",
      function: Object.freeze({
        name: qualified,
        description: truncateText(
          `[${labelOf(config)}] ${tool.description}`.trim(),
          maxDescriptionChars,
        ),
        parameters: tool.parameters,
      }),
    }),
  };
}
