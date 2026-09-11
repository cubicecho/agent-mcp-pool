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
 * The pool's own copy of a row, so the caller's object and the pool's record are separate things.
 *
 * `state()` used to hand back the caller's row and the entry used to hold it, which made both
 * writable from outside the pool: a caller that edits a row in place — a config-file loader that
 * parses once and hands out the same objects — got a `sameConnection` comparing a row against
 * itself, so the pool never reconnected, while `state()` reported the edit as though it had. The
 * child on the other end of the pipe was still the one started with the old arguments.
 *
 * Shallow but for the fields that are containers: the three `sameConnection` reads by value, and
 * `hiddenTools` and `hooks`, which are read at call time and so must not change under the pool
 * either. A hook's `args` is arbitrary JSON, hence the clone.
 */
export function copyConfig(config: McpServerConfig): McpServerConfig {
  const copy: McpServerConfig = {
    ...config,
    // Kept as they came, so an absent `args` stays absent rather than becoming an empty array —
    // `sameConnection` treats the two the same, and `state()` should not invent a field.
    args: config.args ? [...config.args] : config.args,
    env: config.env ? { ...config.env } : config.env,
    headers: config.headers ? { ...config.headers } : config.headers,
  };
  if (config.hiddenTools) copy.hiddenTools = [...config.hiddenTools];
  if (config.hooks) copy.hooks = structuredClone(config.hooks);
  return copy;
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
