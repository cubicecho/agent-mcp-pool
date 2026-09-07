import { isDeepStrictEqual } from "node:util";
import type { McpServerConfig } from "./types.ts";

/**
 * Questions about the configured rows themselves — no connection, no pool state.
 *
 * Both decide what happens to a live child process: whether an edited row is worth restarting
 * one for, and whether a run may reach it at all. They live here because neither needs anything
 * the class holds, and both are easier to test against a pair of plain objects.
 */

/**
 * Whether two rows describe the same live connection.
 *
 * Only the fields a child process is made of. This was once a `JSON.stringify` of the whole row,
 * which bounced a running server — losing whatever state it held — because someone fixed a typo
 * in its label.
 */
export function sameConnection(a: McpServerConfig, b: McpServerConfig) {
  return (
    a.enabled === b.enabled &&
    a.transport === b.transport &&
    a.command === b.command &&
    a.url === b.url &&
    // `null` and empty mean the same absence: a row moving between them reaches the same child
    // and must not restart it.
    (a.cwd ?? "") === (b.cwd ?? "") &&
    isDeepStrictEqual(a.args ?? [], b.args ?? []) &&
    isDeepStrictEqual(a.env ?? {}, b.env ?? {}) &&
    isDeepStrictEqual(a.headers ?? {}, b.headers ?? {})
  );
}

/**
 * A run's scope, as a set.
 *
 * `undefined` is every connected server; an empty scope is none of them, which is what an agent
 * with no servers linked to it wants. The two must not collapse into each other.
 */
export function scope(servers?: Iterable<string>): ReadonlySet<string> | undefined {
  return servers === undefined ? undefined : new Set(servers);
}
