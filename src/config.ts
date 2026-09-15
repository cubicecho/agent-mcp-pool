import type { McpServerConfig } from "./types.ts";

/**
 * The pool's handling of rows it has been given — no connection, no pool state.
 *
 * Kept apart from `servers.ts`, which answers questions a host asks about a row too: these two
 * are the pool's own business, and they live outside the class because neither needs anything it
 * holds and both are easier to test against plain objects.
 */

/**
 * The pool's own copy of a row, so the caller's object and the pool's record are separate things.
 *
 * `state()` used to hand back the caller's row and the entry used to hold it, which made both
 * writable from outside the pool: a caller that edits a row in place — a config-file loader that
 * parses once and hands out the same objects — got a `sameConnection` comparing a row against
 * itself, so the pool never reconnected, while `state()` reported the edit as though it had. The
 * child on the other end of the pipe was still the one started with the old arguments.
 *
 * Shallow but for the fields that are containers: the ones `sameConnection` reads by value, and
 * `hiddenTools` and `hooks`, which are read at call time and so must not change under the pool
 * either. A hook's `args` is arbitrary JSON, hence the clone.
 *
 * A branch per arm, because a row carries only its own transport's fields — and copying by arm is
 * what keeps it that way: a spread that rebuilt `headers` on a stdio row would put the other
 * arm's field back on it.
 */
export function copyConfig(config: McpServerConfig): McpServerConfig {
  // Kept as they came, so an absent `args` stays absent rather than becoming an empty array —
  // `sameConnection` treats the two the same, and `state()` should not invent a field.
  const copy: McpServerConfig =
    config.transport === "stdio"
      ? {
          ...config,
          args: config.args ? [...config.args] : config.args,
          env: config.env ? { ...config.env } : config.env,
        }
      : { ...config, headers: config.headers ? { ...config.headers } : config.headers };
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
