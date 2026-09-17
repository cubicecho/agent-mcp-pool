import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { validateHooks } from "./hooks.ts";
import type {
  HttpServerConfig,
  McpServerConfig,
  McpServerState,
  StdioServerConfig,
} from "./types.ts";

/**
 * Questions about server rows that need neither a connection nor Node — for the form that edits one.
 *
 * Importable in a browser as `@cubicecho/agent-mcp-pool/servers`: nothing here, and nothing it
 * imports, reaches for a `node:` module or the SDK at runtime. Each UI that saved rows kept its
 * own copy of these because the package's only entry spawned children.
 */

export type {
  HttpServerConfig,
  McpServerConfig,
  McpServerState,
  ServerCapabilities,
  StdioServerConfig,
};

/**
 * Whether two rows describe the same live connection.
 *
 * Only the fields a child process is made of. This was once a `JSON.stringify` of the whole row,
 * which bounced a running server — losing whatever state it held — because someone fixed a typo
 * in its label. Exported so a host that decides for itself whether an edit reconnects agrees with
 * the pool that will do the reconnecting.
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
    sameJson(a.args ?? [], b.args ?? []) &&
    sameJson(a.env ?? {}, b.env ?? {})
  );
}

function sameHttp(a: HttpServerConfig, b: HttpServerConfig) {
  return a.url === b.url && sameJson(a.headers ?? {}, b.headers ?? {});
}

/**
 * Deep equality over JSON-shaped values: arrays in order, objects by key whatever the order.
 *
 * In place of `node:util`'s `isDeepStrictEqual`, which kept this module out of a browser for the
 * sake of comparing an argv and two string maps.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  );
}

/**
 * The connected servers that offer a capability — the filter every host wrote for itself.
 *
 * `ready` and not merely configured: `capabilities` is what the handshake returned, and a server
 * that is idle or down has not said anything this process can rely on.
 *
 * @param state What `McpPool.state()` returned.
 * @param capability A top-level key of the handshake's capabilities: `prompts`, `resources`, …
 */
export function serversWith(
  state: readonly McpServerState[],
  capability: keyof ServerCapabilities,
): McpServerState[] {
  return state.filter((server) => server.status === "ready" && server.capabilities?.[capability]);
}

/** What `fromMcpServersJson` needs besides the JSON. */
export interface McpServersJsonOptions {
  /**
   * Where `${VAR}` and `${VAR:-default}` are looked up. Defaults to `process.env` where there is
   * one and to nothing in a browser. A variable with no value and no default is left as written,
   * so the row shows an operator what still needs filling in rather than an empty string.
   */
  env?: Record<string, string | undefined>;
  /**
   * The id for a paste that is one server's body with no key around it. Without it such a paste
   * is refused: every row needs an id, and inventing one would collide with the next paste.
   */
  name?: string;
}

/** `${VAR}` or `${VAR:-default}`. */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Rows from the `mcpServers` JSON that Claude Desktop, Claude Code, Cursor and most server READMEs
 * describe a server with.
 *
 * Three nestings are read, since which one arrives depends on how much of a file was copied:
 * `{ "mcpServers": { "fs": { … } } }` (or VS Code's `servers`), `{ "fs": { … } }`, and a bare
 * `{ "command": … }` body, which takes its id from `options.name`. Each key becomes the row's `id`,
 * `slug` and `label`; a server's `disabled: true` becomes `enabled: false`.
 *
 * A server with a `url` and no `type` is http, since a stdio server has nothing to point at. `sse`
 * is refused rather than imported: the pool speaks streamable HTTP, and a row that can never connect
 * is worse than a paste that says why. Shape problems that still make a row — an empty command, a
 * key that is not a valid namespace — are left for `validateServerConfig`, so a form can show them
 * all at once.
 *
 * @param json The parsed JSON, or the text of it.
 * @returns One row per server, in the order the JSON lists them.
 * @throws `Error` when the text does not parse, holds no server, or names a transport the pool
 *   cannot reach.
 */
export function fromMcpServersJson(
  json: unknown,
  options: McpServersJsonOptions = {},
): McpServerConfig[] {
  const env = options.env ?? runtimeEnv();
  const parsed = typeof json === "string" ? parseText(json) : json;
  if (!isRecord(parsed)) throw new Error("an mcpServers config must be a JSON object");

  const servers = parsed.mcpServers ?? parsed.servers ?? parsed;
  if (!isRecord(servers)) throw new Error("mcpServers must be an object of named servers");

  const entries: [string, unknown][] = isBody(servers)
    ? [[options.name ?? "", servers]]
    : Object.entries(servers);
  if (entries.length === 0) throw new Error("no server found in that config");

  return entries.map(([key, body]) => {
    if (!key) throw new Error("a server's body with no name around it needs `name` for its id");
    if (!isRecord(body)) throw new Error(`server "${key}" must be an object`);
    return toRow(key, body, (text) => expand(text, env));
  });
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("that config is not valid JSON");
  }
}

/** Whether an object is one server's body rather than a map of named ones. */
const isBody = (value: Record<string, unknown>) =>
  "command" in value || "url" in value || "type" in value || "transport" in value;

function toRow(
  key: string,
  body: Record<string, unknown>,
  fill: (text: string) => string,
): McpServerConfig {
  const base = { id: key, slug: key, label: key, enabled: body.disabled !== true };
  const declared = body.type ?? body.transport;
  const url = typeof body.url === "string" ? fill(body.url) : undefined;

  if (declared === "stdio" || (declared === undefined && url === undefined)) {
    const row: StdioServerConfig = {
      ...base,
      transport: "stdio",
      command: typeof body.command === "string" ? fill(body.command) : "",
    };
    if (Array.isArray(body.args)) row.args = body.args.map((arg) => fillAny(arg, fill) as string);
    if (isRecord(body.env)) row.env = fillStrings(body.env, fill);
    if (typeof body.cwd === "string") row.cwd = fill(body.cwd);
    return row;
  }
  if (declared === undefined || HTTP_TYPES.has(String(declared))) {
    const row: HttpServerConfig = { ...base, transport: "http", url: url ?? "" };
    if (isRecord(body.headers)) row.headers = fillStrings(body.headers, fill);
    return row;
  }
  if (declared === "sse") {
    throw new Error(`server "${key}" is an SSE server; the pool connects over streamable HTTP`);
  }
  throw new Error(`server "${key}" has a type of ${JSON.stringify(declared)}, not stdio or http`);
}

/** Every spelling of streamable HTTP the configs in the wild use. */
const HTTP_TYPES = new Set(["http", "streamable-http", "streamableHttp", "streamable_http"]);

/** A string gets its placeholders filled; anything else passes through for the validator to see. */
const fillAny = (value: unknown, fill: (text: string) => string) =>
  typeof value === "string" ? fill(value) : value;

function fillStrings(record: Record<string, unknown>, fill: (text: string) => string) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, fillAny(value, fill)]),
  ) as Record<string, string>;
}

function expand(text: string, env: Record<string, string | undefined>) {
  return text.replace(PLACEHOLDER, (whole, name: string, fallback: string | undefined) => {
    const value = env[name];
    // `:-` is the shell's: an empty value takes the default too. Without one, empty is a value.
    if (fallback !== undefined) return value ? value : fallback;
    return value ?? whole;
  });
}

/**
 * `process.env` without naming `process`: this module is compiled with no Node types, so that a
 * browser import of it cannot quietly depend on one.
 */
function runtimeEnv(): Record<string, string | undefined> {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env ?? {};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The characters OpenAI allows in a function name, which every qualified tool name is. */
const NAMESPACE = /^[A-Za-z0-9_-]+$/;

/**
 * What is wrong with a row, for the form that saves it — before `sync()` is handed it.
 *
 * Reports shape rather than trusting a type: a row typed into a browser is not yet a
 * `McpServerConfig`, and every problem is listed rather than the first, so the form can mark each
 * field. Its `hooks` are checked by `validateHooks`, whose messages are included as they are.
 * Whether the server answers is not checked — that is `probe`.
 *
 * @param row A candidate row, of any shape.
 * @returns One message per problem. Empty means the row is fine.
 */
export function validateServerConfig(row: unknown): string[] {
  if (!isRecord(row)) return ["a server must be an object"];
  const errors: string[] = [];
  const optional = (field: string, ok: (value: unknown) => boolean, what: string) => {
    if (row[field] != null && !ok(row[field])) errors.push(`${field} must be ${what}`);
  };

  if (typeof row.id !== "string" || !row.id.trim()) errors.push("needs an id");
  optional("slug", (value) => typeof value === "string", "a string");
  const namespace = (typeof row.slug === "string" && row.slug) || row.id;
  if (typeof namespace === "string" && namespace.trim() && !NAMESPACE.test(namespace)) {
    errors.push(
      `"${namespace}" cannot namespace tool names: use letters, digits, _ and - (set a slug)`,
    );
  }
  if (typeof row.label !== "string") errors.push("label must be a string");
  if (typeof row.enabled !== "boolean") errors.push("enabled must be true or false");

  if (row.transport === "stdio") {
    if (typeof row.command !== "string" || !row.command.trim()) errors.push("needs a command");
    optional("args", (value) => Array.isArray(value) && value.every(isString), "a list of strings");
    optional("env", isStringRecord, "an object of strings");
    optional("cwd", isString, "a string");
  } else if (row.transport === "http") {
    if (typeof row.url !== "string" || !row.url.trim()) errors.push("needs a url");
    else if (!isHttpUrl(row.url)) errors.push(`"${row.url}" is not an http or https url`);
    optional("headers", isStringRecord, "an object of strings");
  } else {
    errors.push(`transport must be "stdio" or "http"`);
  }

  optional("idleTimeoutMs", (value) => wholeNumber(value, 0), "a whole number, 0 or more");
  optional("connectTimeoutMs", (value) => wholeNumber(value, 1), "a positive whole number");
  optional("callTimeoutMs", (value) => wholeNumber(value, 1), "a positive whole number");
  optional("maxResultChars", (value) => wholeNumber(value, 0), "a whole number, 0 or more");
  optional("coerceArguments", (value) => typeof value === "boolean", "true or false");
  optional(
    "hiddenTools",
    (value) => Array.isArray(value) && value.every(isString),
    "a list of tool names",
  );
  errors.push(...validateHooks(row.hooks));
  return errors;
}

/**
 * What is wrong with a whole list of rows, for the form that saves one into it.
 *
 * `validateServerConfig` sees one row and so cannot see the two problems that are properties of
 * the set: an `id` used twice, which the pool keys its entries on, and two rows whose effective
 * slug agrees, which namespaces both servers' tools identically. Neither is refused by `sync()` —
 * a pool that dropped every server over one duplicate row would punish the servers that were
 * fine — so a shadowed row instead offers the model nothing, and this is where an operator is
 * told before it gets that far.
 *
 * @param rows The candidate list, of any shape.
 * @returns Each row's own problems, prefixed with which row they are on, then the set's. Empty
 *   means the list is fine.
 */
export function validateServers(rows: unknown): string[] {
  if (!Array.isArray(rows)) return ["servers must be a list"];
  const errors: string[] = [];
  for (const [index, row] of rows.entries()) {
    const id = isRecord(row) && typeof row.id === "string" && row.id.trim() ? row.id : "";
    const name = id ? `server "${id}"` : `server ${index + 1}`;
    errors.push(...validateServerConfig(row).map((error) => `${name}: ${error}`));
  }

  // Only rows that named themselves can be reported as clashing; one with no usable id already
  // has an error of its own, and a second message about it would say nothing new.
  const ids = new Map<string, number>();
  const slugs = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim()) continue;
    ids.set(row.id, (ids.get(row.id) ?? 0) + 1);
    const slug = (typeof row.slug === "string" && row.slug) || row.id;
    const first = slugs.get(slug);
    if (first === undefined) slugs.set(slug, row.id);
    else if (first !== row.id) {
      errors.push(
        `servers "${first}" and "${row.id}" share the namespace "${slug}": ` +
          `their tools would answer to the same names (set a slug)`,
      );
    }
  }
  for (const [id, count] of ids) {
    if (count > 1) errors.push(`server "${id}": another server has that id`);
  }
  return errors;
}

const isString = (value: unknown) => typeof value === "string";

const isStringRecord = (value: unknown) => isRecord(value) && Object.values(value).every(isString);

const wholeNumber = (value: unknown, min: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min;

function isHttpUrl(text: string) {
  // `URL.canParse` is in every runtime this targets, browsers included; a parse that throws is
  // not a thing a validator should do.
  if (!URL.canParse(text)) return false;
  const { protocol } = new URL(text);
  return protocol === "http:" || protocol === "https:";
}
