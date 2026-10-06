import { inScope, scope } from "./config.ts";
import { errorMessage, McpPoolError } from "./errors.ts";
import {
  DEFAULT_HOOK_MAX_TOKENS,
  expandArgs,
  INJECT_EVENTS,
  INJECT_TIMEOUT_MS,
  readVeto,
  VETO_EVENTS,
} from "./hooks.ts";
import { labelOf, slugOf } from "./namespace.ts";
import { qualify } from "./naming.ts";
import type { CallOptions, PoolLog, RunHooksOptions } from "./options.ts";
import type { HookContext, HookEvent, HookOutcome, McpServerConfig, ToolHook } from "./types.ts";

/**
 * Running the hooks a pool's rows declare — the half of hooks that needs a connection.
 *
 * `hooks.ts` is the other half and a browser entry, so nothing that calls a tool can live there.
 * Apart from `pool.ts` because none of it is connection management: it reads the rows and makes
 * calls, through the same door any other caller of the pool uses.
 */

/** What the runner needs of the pool it runs for. */
export interface HookHost {
  /** Every row, in configuration order. */
  rows: Iterable<McpServerConfig>;
  /** Where a failed or skipped hook is logged. */
  log: PoolLog;
  /**
   * Calls a tool as the pool's `call()` does.
   *
   * @returns The text, and whether the tool sent none — which the text alone cannot say, since
   *   `call()` puts a placeholder where there was nothing.
   */
  call(
    qualifiedName: string,
    args: unknown,
    options: CallOptions,
  ): Promise<{ text: string; empty: boolean }>;
}

/**
 * `work`, or a rejection when the time or the signal runs out first.
 *
 * The request's own timeout and signal are passed to the SDK as well, which is what stops the
 * server's work; this is what bounds everything before the request — waking a server that is down
 * — which the SDK's timer never sees.
 */
function bounded<T>(work: Promise<T>, ms?: number, signal?: AbortSignal): Promise<T> {
  if (ms === undefined && !signal) return work;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(() => reject(new Error("aborted")));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    if (ms !== undefined) {
      timer = setTimeout(
        () =>
          finish(() =>
            reject(new McpPoolError("timeout", `timed out after ${ms}ms`, { timeoutMs: ms })),
          ),
        ms,
      );
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Runs every hook bound to `event`. What `McpPool.runHooks` does; documented there.
 *
 * @param host The pool's rows, its log, and its `call`.
 * @returns One outcome per hook considered, in configuration order. Never rejects.
 */
export async function runHooks(
  host: HookHost,
  event: HookEvent,
  context: HookContext,
  options: RunHooksOptions = {},
): Promise<HookOutcome[]> {
  const allowed = scope(options.servers);
  const full: HookContext = { ...context, now: context.now ?? new Date().toISOString() };
  const running: Promise<HookOutcome>[] = [];
  for (const row of host.rows) {
    if (!row.enabled || !inScope(allowed, row.id)) continue;
    for (const hook of row.hooks ?? []) {
      if (hook.on !== event || hook.enabled === false) continue;
      running.push(runHook(host, row, hook, full, options));
    }
  }
  return Promise.all(running);
}

/** One hook, start to outcome. Resolves on every path; `runHooks` relies on that. */
async function runHook(
  host: HookHost,
  row: McpServerConfig,
  hook: ToolHook,
  context: HookContext,
  { servers, signal, onNotice }: RunHooksOptions,
): Promise<HookOutcome> {
  const started = Date.now();
  const base = {
    serverId: row.id,
    label: labelOf(row),
    hookId: hook.id,
    event: hook.on,
    // Held to the events that can use it here as well as in `validateHooks`, since a row need
    // not have been through that: an `afterTurn` hook marked inject would otherwise be handed
    // to `contextBlocks` as though it had run in time.
    inject: Boolean(hook.inject) && INJECT_EVENTS.has(hook.on),
    maxTokens: hook.maxTokens ?? DEFAULT_HOOK_MAX_TOKENS,
  };
  // Held to its events for the same reason as `inject`, and the stakes are higher: a row that
  // never went through `validateHooks` must not be able to stall a compaction from `afterTurn`.
  const mayVeto = Boolean(hook.veto) && VETO_EVENTS.has(hook.on);
  const settle = (result: Pick<HookOutcome, "ok" | "text" | "error" | "skipped" | "veto">) => {
    const outcome: HookOutcome = { ...base, ...result, ms: Date.now() - started };
    if (!outcome.ok) {
      const notice = `${base.label}: ${hook.on} hook "${hook.id}" ${
        outcome.skipped ? "skipped" : "failed"
      }: ${outcome.error}`;
      host.log.info?.(`[mcp] ${notice}`);
      onNotice?.(notice, outcome);
    }
    return outcome;
  };

  if (signal?.aborted) return settle({ ok: false, skipped: true, error: "aborted before it ran" });
  const { args, missing } = expandArgs(hook.args, context);
  if (missing.length > 0) {
    const paths = missing.map((path) => `{{${path}}}`).join(", ");
    return settle({ ok: false, skipped: true, error: `no value for ${paths}` });
  }

  // By the event rather than by `inject`: a `beforeTurn` hook that injects nothing still holds
  // up the turn it runs in front of. A hook that can veto is waited on the same way — the
  // compaction does not start until it answers — so it gets that patience too.
  const waitedOn = INJECT_EVENTS.has(hook.on) || mayVeto;
  const timeoutMs = hook.timeoutMs ?? (waitedOn ? INJECT_TIMEOUT_MS : undefined);
  try {
    const { text, empty } = await bounded(
      host.call(qualify(slugOf(row), hook.tool), args, {
        servers,
        signal,
        timeoutMs,
        hidden: true,
      }),
      timeoutMs,
      signal,
    );
    // Only a call that came back can veto. A failure is no opinion — agent-core reads `ok:
    // false` as such — so a memory server that is down cannot stall every compaction.
    if (mayVeto) {
      const { veto, reason } = readVeto(text);
      if (veto) return settle({ ok: true, veto: true, text: reason });
    }
    // What `call()` answers for an empty result is for a model, which must be told something;
    // for a hook it is nothing to inject.
    return settle({ ok: true, text: empty ? undefined : text });
  } catch (error) {
    return settle({ ok: false, error: errorMessage(error) });
  }
}
