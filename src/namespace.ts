import type { McpServerConfig } from "./types.ts";

/**
 * What a server's tools are named under, and which server gets a name two of them want.
 *
 * Apart from `naming.ts` because that one hashes with `node:crypto`, and the form that validates a
 * row — `servers.ts`, a browser entry — has to agree with the pool about what a namespace is
 * without importing Node to do it.
 */

/**
 * The characters OpenAI allows in a function name, as the inside of a character class.
 *
 * Every qualified tool name is one, so this is both what a slug may be made of and what `qualify`
 * substitutes everything else down to. Two regexes spelling it separately is two rules.
 */
export const NAME_CHARS = "A-Za-z0-9_-";

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

/** What `namespaceOwners` settled. */
export interface NamespaceOwners {
  /** Each namespace in use, and the id of the one row whose tools answer under it. */
  owner: Map<string, string>;
  /** Each contested namespace, and the ids that lost it, in the order they were met. */
  shadowed: Map<string, string[]>;
}

/**
 * Which of the rows sharing a namespace owns it: the lowest id.
 *
 * By id because that is in the rows. The pool's entries are inserted as their handshakes finish,
 * concurrently, so their order is not the configured order — and a tie broken by position would
 * move the name whenever a server reconnected.
 *
 * @param rows Every row, whatever its status: a tie broken only among the connected ones is a tie
 *   broken by the idle clock.
 */
export function namespaceOwners(
  rows: Iterable<Pick<McpServerConfig, "id" | "slug">>,
): NamespaceOwners {
  const owner = new Map<string, string>();
  const shadowed = new Map<string, string[]>();
  for (const row of rows) {
    const slug = slugOf(row);
    const first = owner.get(slug);
    if (first === undefined) owner.set(slug, row.id);
    else {
      const [kept, lost] = first < row.id ? [first, row.id] : [row.id, first];
      owner.set(slug, kept);
      shadowed.set(slug, [...(shadowed.get(slug) ?? []), lost]);
    }
  }
  return { owner, shadowed };
}
