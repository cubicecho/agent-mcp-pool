import { isDeepStrictEqual } from "node:util";
import type { HttpServerConfig, McpServerConfig, StdioServerConfig } from "./types.ts";

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
  if (a.enabled !== b.enabled || a.transport !== b.transport) return false;
  // Narrowing `a` tells TypeScript nothing about `b` — it cannot correlate two discriminants it
  // checked separately — so `b` is asserted once, here, where the equality above has already
  // established which arm it is.
  return a.transport === "stdio"
    ? sameStdio(a, b as StdioServerConfig)
    : sameHttp(a, b as HttpServerConfig);
}

/** `null` and empty mean the same absence: a row moving between them reaches the same child. */
function sameStdio(a: StdioServerConfig, b: StdioServerConfig) {
  return (
    a.command === b.command &&
    (a.cwd ?? "") === (b.cwd ?? "") &&
    isDeepStrictEqual(a.args ?? [], b.args ?? []) &&
    isDeepStrictEqual(a.env ?? {}, b.env ?? {})
  );
}

function sameHttp(a: HttpServerConfig, b: HttpServerConfig) {
  return a.url === b.url && isDeepStrictEqual(a.headers ?? {}, b.headers ?? {});
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
