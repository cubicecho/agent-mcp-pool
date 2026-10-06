import { createHash } from "node:crypto";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson } from "./shape.ts";
import type { McpServerConfig } from "./types.ts";

/** What of a tool `toolsFingerprint` reads — the fields `tools/list` sends them under. */
export interface FingerprintedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

/**
 * A stable hash of what a server says its tools are, for noticing when that changes.
 *
 * A server whose descriptions move after an operator approved them is the "rug pull" of the MCP
 * security write-ups, and a consumer can only notice one if it has something to compare against:
 * store this when a server is approved, and warn when `state()` reports another.
 *
 * Over each tool's name, description, input schema and annotations. Annotations because a tool
 * that keeps its description and flips `destructiveHint` is the same attack, and a host that
 * auto-approves on the hint is the one it works on. Not over `title`, `outputSchema` or `_meta`,
 * which change what a person sees and not what a model is told or a host decides.
 *
 * Order-independent twice over: tools are sorted by name and every object's keys are sorted, so a
 * server that lists the same tools in another order, or prints a schema's keys in another, has not
 * changed. An absent description and an empty one are the same, and so are an absent schema and
 * the bare object the pool sends in its place.
 *
 * @param tools The server's tools under its own names — a `tools/list` result as it came.
 * @returns 64 hex characters of SHA-256.
 */
export function toolsFingerprint(tools: readonly FingerprintedTool[]): string {
  const tuples = tools
    .map(({ name, description, inputSchema, annotations }) => [
      name,
      description ?? "",
      inputSchema ?? { type: "object" },
      annotations ?? null,
    ])
    .sort(([a], [b]) => (a === b ? 0 : (a as string) < (b as string) ? -1 : 1));
  return createHash("sha256").update(canonicalJson(tuples)).digest("hex");
}

/**
 * A hash of the fields a connection is made of — the ones `sameConnection` compares.
 *
 * What a cached tool list is stamped with, so one fetched over another command or another url is
 * not offered as this row's. A hash rather than the fields because two of them are `env` and
 * `headers`: a tool cache is a table somebody will read, and it has no business holding an API key.
 *
 * `enabled` is left out, unlike in `sameConnection`: switching a server off and on again restarts
 * it, and does not change what it offers.
 */
export function connectionFingerprint(config: McpServerConfig): string {
  const reached =
    config.transport === "stdio"
      ? [config.command, config.cwd ?? "", config.args ?? [], config.env ?? {}]
      : [config.url, config.headers ?? {}];
  return createHash("sha256")
    .update(canonicalJson([config.transport, ...reached]))
    .digest("hex");
}
