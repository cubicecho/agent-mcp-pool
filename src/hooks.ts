import type { HookContext, HookEvent, HookOutcome, ToolHook } from "./types.ts";

/**
 * MCP tools as lifecycle hooks — the half that needs no connection.
 *
 * A row's `hooks` say "at this point in a session, call this tool of mine with these arguments".
 * What is here reads and checks those rows and shapes what came back; `McpPool.runHooks` is the
 * half that makes the calls. Split so a consumer can validate a row it is about to save, or build
 * the context block for a request, without a pool in reach.
 *
 * A hook is a tool call and nothing else — never a command. The consumers this was written for
 * edit their rows from a UI, and a hook that ran a shell line would make "can edit the server
 * list" the same permission as "can run anything on the host".
 */

/** Every event a hook can be bound to, in the order a session meets them. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "sessionStart",
  "beforeTurn",
  "afterTurn",
  "beforeCompact",
  "sessionEnd",
  "sessionDelete",
];

/**
 * What each event puts in its context, beyond the ones every event carries.
 *
 * The contract `validateHooks` holds a row to, so a template naming `{{reply}}` on `beforeTurn` —
 * where there is no reply yet — is refused when it is saved rather than skipped on every turn.
 */
const EVENT_VARS: Record<HookEvent, readonly string[]> = {
  sessionStart: ["prompt"],
  beforeTurn: ["prompt", "turn.index"],
  afterTurn: ["prompt", "reply", "turn.index", "turn.messages"],
  beforeCompact: ["compacting", "range.from", "range.through"],
  sessionEnd: ["status", "reply"],
  sessionDelete: [],
};

/** On every event. `vars.*` is too, but it is the host's own record, so it has no fixed list. */
const COMMON_VARS = ["session.id", "host", "now"] as const;

/**
 * The events whose output can reach the model. Only these two run before the request they would
 * be added to — anything later has nothing left to add context to.
 */
export const INJECT_EVENTS: ReadonlySet<HookEvent> = new Set(["sessionStart", "beforeTurn"]);

/**
 * How long an injecting hook gets when its row does not say.
 *
 * An injecting hook is on the path of the user's reply, so its patience is the user's: a memory
 * server that has not answered in three seconds costs more than the context it would have added.
 * The others run beside or after the turn, and get the call's ordinary timeout.
 */
export const INJECT_TIMEOUT_MS = 3000;

/** The cap on one hook's injected text when its row does not set `maxTokens`. */
export const DEFAULT_HOOK_MAX_TOKENS = 1000;

/**
 * The template paths an event offers, `vars.*` aside.
 *
 * @param event The event a hook is bound to.
 * @returns The dotted paths a `{{…}}` in that hook's `args` may name.
 */
export function hookVars(event: HookEvent): string[] {
  return [...COMMON_VARS, ...(EVENT_VARS[event] ?? [])];
}

/** A string that is one placeholder and nothing else: its value goes in raw. */
const WHOLE = /^\{\{\s*([\w.]+)\s*\}\}$/;
/** A placeholder anywhere in a string: its value goes in as text. */
const ANY = /\{\{\s*([\w.]+)\s*\}\}/g;

/** One dotted path into a context, or `undefined` where any step of it is absent. */
function lookup(context: HookContext, path: string): unknown {
  let at: unknown = context;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** Every value in a JSON-shaped tree, strings included, depth first. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) yield* strings(item);
}

/** Every path a hook's `args` names, each once. */
export function templatePaths(args: unknown): string[] {
  const paths = new Set<string>();
  for (const text of strings(args)) for (const match of text.matchAll(ANY)) paths.add(match[1]);
  return [...paths];
}

/** What `expandArgs` made of a hook's arguments. */
export interface ExpandedArgs {
  /** The arguments with every placeholder filled in. */
  args: unknown;
  /**
   * Paths the context had no value for. Non-empty means the hook should not run: a
   * `session_id: "app:{{session.id}}"` sent as `"app:"` files a turn under the wrong session,
   * which is worse than not filing it.
   */
  missing: string[];
}

/**
 * Fills a hook's `args` from its context.
 *
 * A string that is exactly one placeholder takes the value itself, so `"turns": "{{turn.messages}}"`
 * sends the array rather than its JSON — which is what a tool whose schema says `array` needs.
 * A placeholder inside a longer string is interpolated as text, with anything that is not already
 * a string written as JSON.
 *
 * @param args The hook's `args`. Absent is `{}`, which is what a tool with no arguments is sent.
 * @param context What the event carries.
 */
export function expandArgs(args: unknown, context: HookContext): ExpandedArgs {
  const missing = new Set<string>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const whole = WHOLE.exec(value);
      if (whole) {
        const found = lookup(context, whole[1]);
        if (found === undefined) missing.add(whole[1]);
        return found;
      }
      return value.replace(ANY, (_, path: string) => {
        const found = lookup(context, path);
        if (found === undefined) {
          missing.add(path);
          return "";
        }
        return typeof found === "string" ? found : JSON.stringify(found);
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return { args: walk(args ?? {}), missing: [...missing] };
}

const positive = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * What is wrong with a row's hooks, for the form that saves them.
 *
 * Everything that can be known without a connection: an event that does not exist, a placeholder
 * the event does not offer, `inject` where nothing would read it, an id used twice. Whether the
 * tool exists is not checked — the server may not be connected, and a row saved before its server
 * is up is ordinary.
 *
 * @param hooks The row's `hooks`. Absent is none, which is valid.
 * @returns One message per problem, naming the hook. Empty means the hooks are fine.
 */
export function validateHooks(hooks: readonly ToolHook[] | null | undefined): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const [index, hook] of (hooks ?? []).entries()) {
    const name = hook.id ? `hook "${hook.id}"` : `hook ${index + 1}`;
    if (!hook.id?.trim()) errors.push(`${name}: needs an id`);
    else if (ids.has(hook.id)) errors.push(`${name}: another hook on this server has that id`);
    ids.add(hook.id);

    if (!hook.tool?.trim()) errors.push(`${name}: needs a tool`);
    if (!HOOK_EVENTS.includes(hook.on)) {
      errors.push(`${name}: "${hook.on}" is not an event (one of ${HOOK_EVENTS.join(", ")})`);
      continue;
    }
    if (hook.inject && !INJECT_EVENTS.has(hook.on)) {
      errors.push(`${name}: only sessionStart and beforeTurn can inject; ${hook.on} runs too late`);
    }
    if (hook.maxTokens != null && !positive(hook.maxTokens)) {
      errors.push(`${name}: maxTokens must be a positive whole number`);
    }
    if (hook.timeoutMs != null && !positive(hook.timeoutMs)) {
      errors.push(`${name}: timeoutMs must be a positive whole number`);
    }
    const offered = hookVars(hook.on);
    for (const path of templatePaths(hook.args)) {
      if (offered.includes(path) || path.startsWith("vars.")) continue;
      errors.push(`${name}: ${hook.on} has no {{${path}}} (it offers ${offered.join(", ")})`);
    }
  }
  return errors;
}

/**
 * Tokens in a string, as agent-core's `estimateTokens` counts them.
 *
 * Four characters a token, which is rough and deliberately the same rough: a cap measured one way
 * here and another in the request budget would let the two disagree about whether it fit.
 */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const attribute = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** What `contextBlocks` built, and what each hook contributed to it. */
export interface ContextBlocks {
  /** The blocks, blank-line separated; empty when no hook had anything to add. */
  text: string;
  /** One entry per hook whose output made it in, in the order it appears. */
  injected: { serverId: string; hookId: string; tokens: number }[];
}

/**
 * The injecting hooks' output, as context for the model.
 *
 * Each one is wrapped in `<context source="…">` naming the server it came from, so a model reading
 * a recalled line can tell it is a memory rather than something the user said. Each is held to its
 * own hook's `maxTokens`, and the whole to `maxTokens` here: a hook with a generous cap on a server
 * that returns a page cannot crowd out the conversation it was meant to inform. Blocks past the
 * total are dropped whole rather than cut to a stub.
 *
 * @param outcomes What `runHooks` returned. Failed, empty and non-injecting ones are skipped.
 * @param options `maxTokens` across every block together; 2000 if not given.
 */
export function contextBlocks(
  outcomes: readonly HookOutcome[],
  { maxTokens = 2000 }: { maxTokens?: number } = {},
): ContextBlocks {
  const blocks: string[] = [];
  const injected: ContextBlocks["injected"] = [];
  let remaining = maxTokens;
  for (const outcome of outcomes) {
    if (!outcome.ok || !outcome.inject) continue;
    let text = outcome.text?.trim();
    if (!text) continue;
    const cap = Math.min(outcome.maxTokens, remaining);
    if (cap <= 0) break;
    if (estimateTokens(text) > cap) text = `${text.slice(0, cap * 4 - 1).trimEnd()}…`;
    const tokens = estimateTokens(text);
    remaining -= tokens;
    blocks.push(`<context source="${attribute(outcome.label)}">\n${text}\n</context>`);
    injected.push({ serverId: outcome.serverId, hookId: outcome.hookId, tokens });
  }
  return { text: blocks.join("\n\n"), injected };
}
