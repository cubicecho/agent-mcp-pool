import { createHash } from "node:crypto";
import type OpenAI from "openai";
import type { McpServerConfig } from "./types.ts";

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
  /** `<slug>__<name>`: what the model sees, and what it calls. */
  qualified: string;
  definition: OpenAI.ChatCompletionTool;
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
 * The one place a tool's wire name is built, so `call` and `tools` agree.
 *
 * Plain truncation at OpenAI's 64-character limit made two tools sharing a 64-character prefix
 * collapse onto one key, and the second silently replaced the first in the index — so the model
 * was offered a name that dispatched to the wrong tool. An over-long name now gives up its tail
 * to a hash of the whole name, which is what tells the two apart. Names that already fit are
 * untouched.
 */
export function qualify(slug: string, tool: string) {
  const full = `${slug}${SEPARATOR}${tool}`;
  if (full.length <= NAME_LIMIT) return full;
  const digest = createHash("sha256").update(full).digest("hex").slice(0, HASH_LENGTH);
  return `${full.slice(0, NAME_LIMIT - HASH_LENGTH - 1)}_${digest}`;
}

/**
 * Everything about a tool that its server's name decides.
 *
 * One place, because `connect` builds these and `relabel` rebuilds them; when the two drift, the
 * model calls a name the pool no longer indexes.
 */
export function pooledTool(
  config: McpServerConfig,
  tool: { name: string; description: string; parameters: Record<string, unknown> },
): PooledTool {
  const slug = slugOf(config);
  const label = config.label || slug;
  const qualified = qualify(slug, tool.name);
  return {
    ...tool,
    qualified,
    definition: {
      type: "function",
      function: {
        name: qualified,
        description: `[${label}] ${tool.description}`.trim(),
        parameters: tool.parameters,
      },
    },
  };
}
