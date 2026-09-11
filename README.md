# @cubicecho/agent-mcp-pool

A pool of long-lived Model Context Protocol clients, exposing every connected server's tools to
an OpenAI-compatible agent loop as `<slug>__<tool name>`.

Connections are long-lived and shared across runs: a stdio server is a child process, and
spawning one per run would cost more than the run.

## Install

```sh
npm install @cubicecho/agent-mcp-pool @modelcontextprotocol/sdk
```

`@modelcontextprotocol/sdk` (`>=1.30`) is the one peer dependency, because `client()` hands back
the SDK's own `Client` and an `instanceof` against a second copy in the tree means nothing.
`openai` is **not** one: `tools()` returns `ToolDefinition`, which is declared here and assignable
to OpenAI's `ChatCompletionTool` because TypeScript is structural. It was a required peer for two
type positions that are erased at compile time, so a consumer proxying MCP and never calling a
model installed 24 MB to satisfy them. ESM only, Node >=22.

## The seam

The two servers this came from both did `import { db }` and read an `mcp_servers` table. The
pool now asks for its rows instead:

```ts
import { McpPool } from "@cubicecho/agent-mcp-pool";

export const mcp = new McpPool({
  load: () => db.select().from(mcpServers),
  clientName: "task-server",
  clientVersion: SERVER_VERSION,
});
```

`clientName` and `clientVersion` are the `clientInfo` of the MCP handshake — the whole of what a
dialled server learns about who is calling it, and so what it logs, gates a behaviour on, or
quotes back in a support channel. The version defaults to this package's own, read from its
manifest; set it beside the name, since a name that is yours next to a version that is the
pool's tells the server something untrue.

A stdio server may also name a `cwd`; absent, it inherits this process's. Several servers resolve
relative paths — a filesystem root, a sqlite file — against their working directory rather than
against an argument, and it counts as part of the connection: editing it restarts the child.

`sync(configs?)` reconciles against what it is given, or against `load` when given nothing.
`syncSoon()` debounces a reconcile past a transaction commit, and `flush()` pays one off early
for a reader that would otherwise be shown the pool as it stood before its own write.

`load` is optional: a consumer that owns its own configuration passes the rows every time instead.
On such a pool, a `sync()` or `reconnect(id)` with no configs has nothing to reconcile against and
is refused with a `no-configs` `McpPoolError` rather than treated as an empty set — reconciling
against nothing closes and forgets every server, and doing that because an argument was left off
is the most destructive thing this API could do by accident. `sync([])` still closes everything,
from a caller who said so.

## State

`state()` reports every configured server **in the order it was configured**, and hands back the
row it was configured from:

```ts
for (const { config, status, error, tools, pid, startedAt, instructions } of mcp.state()) {
  // config is a copy of the row you passed in, minus its credentials;
  // everything beside it is what the pool made of it, or what the server said for itself
}
```

Both halves exist so a consumer does not have to keep its own copy of the rows beside the pool's.
A UI that draws the edit form and the connection state as one line needs the row, and a shadow
map of the same rows goes stale the moment anything reconciles without going through it — which
`syncSoon()` and a `load`-driven `sync()` both do. The order is the caller's array rather than
`Map` insertion order for the same reason: entries are created by parallel connects, so without
this the operator's list reorders itself according to which child started quickest.

`id`, `slug` and `label` stay alongside `config` — those are the *effective* values the pool
actually used.

**`env` and `headers` are left out of it.** That UI is a browser, sending `state()` to it is the
shortest way to draw that line, and for a real server those two fields are an API key and an
`Authorization: Bearer` — so the default is the safe one, and the caller genuinely rendering the
edit form *server-side* is the one that asks:

```ts
mcp.state({ secrets: true }); // config carries env and headers again
```

`config` is a **copy** rather than the row itself. A caller that holds its rows and edits one in
place used to get a pool that never reconnected — `sameConnection` was being asked whether a row
differed from itself — while `state()` reported the edit as though the child had been restarted
for it.

`pid` and `startedAt` describe the connection rather than the configuration, so both are absent
unless one is up, and `pid` over http, which has no child. They are what make `ready` mean
something concrete to an operator: a pid finds a wedged child in `ps`, and a start time is how a
server that is quietly crash-looping is spotted, since `status` reads `ready` either side of a
restart.

`instructions` and `capabilities` are the rest of what `initialize` returned, and are absent for
the same reason — a server that is not connected has no handshake to report:

```ts
const guidance = mcp
  .state()
  .flatMap(({ label, instructions }) => (instructions ? [`## ${label}\n${instructions}`] : []))
  .join("\n\n"); // straight into a system prompt, synchronously, spawning nothing
```

`instructions` is what a server says about itself for a model to read — the things a tool
description has no room for, like "resolve the library id before querying docs" — so a system
prompt is where it belongs. It is reported here rather than left to `client()` because that door
*dials*: it connects an idle server by design, so under `lazy`, or with `idleTimeoutMs` set and a
server just reaped, building a prompt would spawn children. `capabilities` is what says whether
`resources/list` or `prompts/list` on a `client()` is worth attempting at all; without it the
choice is an error round trip per server per surface, or not offering the surface. Both are
reported under `indexTools: false` as well, unlike `tools` — they were already in hand, and the
consumer that turned indexing off is the one proxying the protocol.

## Scope

`tools`, `catalog` and `call` all take an optional set of server ids. **Absent means every
connected server; empty means none of them** — the two must not collapse, because "this agent
has no servers linked" is a real and correct state. `call` re-checks the scope rather than
trusting the definitions the caller was given: a model that has seen a tool name once will call
it again from memory.

`tools` names both of its own:

```ts
pool.tools({ names: ["echo__add"], servers: [agent.serverId] });
```

`tools(names, servers)` was two collections of strings in an order nothing could check, so a
transposition was not a type error — and its answer is an empty array, which is also the right
answer for a run scoped to servers that offer nothing. A consumer adopting the pool swapped them,
and the migration compiled, connected and offered its model no tools at all. `catalog(servers)`
stays positional: it has no two arguments that could be confused for each other. `call` takes
its scope as the third argument as before, or an object when it needs more:

```ts
pool.call("echo__add", input, { servers, signal, timeoutMs: 5000 });
```

## Hooks

A row can carry `hooks`: tool calls of its own that the host makes at points in a session, the way
Claude Code's hooks run at SessionStart or Stop — except a hook here is an MCP tool call and never
a command. Rows are edited from UIs, and a command hook would make "can edit the server list" the
same permission as "can run anything on the host".

The case it was written for is memory: a server that recalls before every turn and remembers
after it, without the model having to decide to call either.

```ts
const memory = {
  id: "zeromem",
  label: "Memory",
  // ...transport fields...
  // The model is not offered these; hooks may still call them.
  hiddenTools: ["zeromem_remember", "zeromem_forget_session"],
  hooks: [
    {
      id: "recall", on: "beforeTurn", tool: "zeromem_recall", inject: true, maxTokens: 800,
      args: { query: "{{prompt}}", exclude_session: "app:{{session.id}}", format: "text" },
    },
    {
      id: "remember", on: "afterTurn", tool: "zeromem_remember",
      args: { session_id: "app:{{session.id}}", turns: "{{turn.messages}}" },
    },
  ],
};

// Before the request:
const outcomes = await pool.runHooks("beforeTurn", { session: { id }, prompt }, { signal, onNotice });
const { text } = contextBlocks(outcomes); // <context source="Memory">…</context>, or ""

// After the reply — not awaited, and not on the turn's signal:
void pool.runHooks("afterTurn", { session: { id }, prompt, reply, turn: { index, messages } });
```

The pool never fires a hook itself — only the host knows when a turn starts. It supplies the runner,
so every host runs the same rows the same way.

| Event | Runs | Context beyond `session.id`, `host`, `now`, `vars.*` | `inject` |
|---|---|---|---|
| `sessionStart` | before a session's first turn | `prompt` | yes |
| `beforeTurn` | before each turn's request | `prompt`, `turn.index` | yes |
| `afterTurn` | once a turn has its reply | `prompt`, `reply`, `turn.index`, `turn.messages` | no |
| `beforeCompact` | before old messages are summarised away | `compacting`, `range.from`, `range.through` | no |
| `sessionEnd` | when a run that ends, ends | `status`, `reply` | no |
| `sessionDelete` | when the host deletes a session | — | no |

- **Templates.** A string that is exactly `"{{path}}"` becomes the value itself, so an array or a
  number goes through as one. `{{path}}` inside a longer string is interpolated as text. A path the
  context has no value for skips the hook: a `session_id` sent as `"app:"` would file a turn under
  the wrong session.
- **Validation.** `validateHooks(row.hooks)` reports an unknown event, a placeholder the event
  does not offer, `inject` on an event that runs too late, and duplicate ids. Run it when the row is
  saved.
- **Never rejects.** A failed call, a timeout, an abort and a skipped hook each come back as an
  outcome with `ok: false`, and are passed to `onNotice`. A memory server that is down costs the
  turn its recall, not the turn.
- **At once, in order.** An event's hooks run in parallel, and their outcomes come back in
  configuration order.
- **Bounded.** A hook gets its `timeoutMs`. Otherwise it gets 3s on `sessionStart` and `beforeTurn`,
  because the user is waiting on those, and the SDK's timeout everywhere else. The bound covers
  waking a server that is down as well as the request itself.
- **Read and add only.** A hook cannot veto a turn or rewrite it. What it returns reaches the model
  only through `contextBlocks`. That function caps each block at its hook's `maxTokens` (1000 by
  default) and the total at 2000.

`hiddenTools` is the other half. A hidden tool is left out of `tools()` and `catalog()`, and
`call()` refuses it as one that does not exist, unless the caller passes `{ hidden: true }`. Hooks
pass it. `state()` still reports hidden tools, marked `hidden`, so a form can offer to unhide them.
Both fields are read at call time, so an edit applies without a reconnect.

## Lifecycle

Eager and long-lived by default: `sync()` connects every enabled server and holds the connection,
because for an agent loop spawning one child per run costs more than the run.

A gateway has the opposite pressure — dozens of installed servers, most idle most of the time —
so the lifecycle is a policy rather than a fixed behaviour:

```ts
new McpPool({
  load,
  lazy: true,             // sync() registers entries; the child waits for a use
  idleTimeoutMs: 300_000, // close a server after five minutes without one
});
```

A registered-but-unconnected server sits at `idle`, which is neither `disabled` (switched off) nor
`error` (tried, failed, waiting out a backoff). `call()` and `client()` start it; **`tools()` and
`catalog()` do not**, so a cold server offers nothing until something has used it. Listing a cold
server's tools without spawning it needs a cached last-known tool list, which is its own change.

`idleTimeoutMs` resets on every use, and `McpServerConfig.idleTimeoutMs` overrides it per server —
`0` opts one out entirely. A reap is a **success** path, not a crash: the server goes back to
`idle` with no error and no backoff, so the next call reconnects immediately rather than waiting
out a penalty for something that did not go wrong. Both options absent is exactly today's
behaviour.

### Stopping and restarting one server

`shutdown()` is every server and forgets them, and `sync()` only closes what the configs dropped.
One server on its own is `stop()` and `reconnect()`:

```ts
await pool.stop(id);      // close the child, keep the row: `idle`, no error, no backoff
await pool.reconnect(id); // close it and dial again, changed or not
```

`stop()` is the reap path reached by a person instead of a clock, which is why it lands on `idle`
rather than a status of its own: `idle` already means registered, no child, nothing wrong. Nothing
stands between a stopped server and the next `call()` or `client()`, including the backoff a crash
would have armed — so "restart this wedged server" is a `stop()` and then a use, and an operator
uninstalling a server can close its child before the row leaves disk rather than racing a live
process holding files open. It stays stopped in the meantime: `reconcile` steps over an `idle`
entry whether or not the pool is lazy, so the next write to the server table will not dial it.

`reconnect()` is the unconditional one, `lazy` included. It used to drop the entry and let the
reconcile rebuild it, and a lazy reconcile registers an entry and waits for a use — so on a lazy
pool it *stopped* the server it was asked to restart, and the caller found out on whichever later
call spawned a child. Which of the two things the method did depended on a constructor flag set
somewhere else entirely; now the two pools mean the same by it. A disabled row is still not
started: it is off for a reason a reconnect does not overrule.

### Not indexing at all

The drain that fills the index is the pool doing its job for an agent loop, and pure cost for a
gateway that proxies `tools/list` through from the client that asked. `indexTools: false` skips it:

```ts
new McpPool({ load, lazy: true, indexTools: false });
```

What that buys is a round trip per page off the first request that spawns a server — a lazy
gateway pays the spawn on a user-facing request, and against a server that pages ten at a time the
walk is several more before the request it actually made is even sent. It also stops holding a
second copy of every tool for nobody, and stops a server that answers `initialize` and then wedges
on `tools/list` from failing to connect at all: that one is still good for a `resources/read`.

The index is then empty for ever, so `tools()`, `catalog()` and `state().tools` are empty and
`call()` refuses every name — without waking anything, since connecting a server could not index
it either. `client()` is the surface that remains, and `probe()` is unaffected: a probe exists to
report what a config offers.

## Past the agent surface

`tools()` returns OpenAI definitions and `call()` returns a string, because a string is what goes
back into a message array. A consumer that is proxying MCP rather than driving a model wants
neither, and wants resources, prompts, subscriptions and logging that a string was never going to
carry. `client(id)` hands back the connected client:

```ts
const { resources } = await (await pool.client(id)).listResources();
```

`listAllTools(client, options?)` is the other half a raw client needs: `tools/list` is paginated,
the page size is the **server's** choice rather than the caller's, and a tool left on page two is
not merely unlisted — it is absent from the index, so `call()` refuses it as one that does not
exist. The pool and `probe()` both drain the cursor; a consumer driving the client itself wants
the same walk rather than one `listTools`. A `timeout` in `options` bounds that walk rather than
each page of it, for the reason above; everything else in `options` is passed to every page.

`resultText` is the flattening `call()` does, exported separately: MCP answers with a list of
content blocks and a message array holds one string. A consumer driving the client itself and
still putting the answer in front of a model wants the same rule rather than its own. A block that
came with text arrives as that text, wherever that block keeps it, and what has none is *named*
rather than dropped — so a model that asked for a screenshot is told it got one instead of being
handed an empty string and left to conclude the call failed:

| Block | Flattened to |
| --- | --- |
| `text` | its `text` |
| `resource`, text arm | the resource's own `text` — a file the server read is an answer, not a placeholder |
| `resource`, blob arm | `[resource <uri> content]`, keeping the uri a follow-up call needs |
| `resource_link` | `[resource_link <uri> — <name>: <description>]`, since the uri is what makes a link followable |
| `image`, `audio`, anything else | `[<type> content]` |

A result with no content at all but a `structuredContent` — what a server with an `outputSchema`
tends to answer with — is flattened to that structure as JSON, rather than reaching the model as
`call()`'s `"(no output)"`. Text blocks win where there are any: they are what the server wrote
for a reader.

Everything else the pool does applies unchanged — reconcile, the queue, crash detection with the
stderr tail, backoff, retry-on-use. A server that is merely down is retried first, the same as
`call()` does; a disabled one is refused, because off is not the same as out of scope. **It
bypasses the scope check by construction:** that guard defends against a model calling a name it
remembers, and a caller holding a server id is not a model.

## Failure

A stdio server is a child process, and child processes die. The pool watches for it: an
unexpected close moves the server to `error`, drops its tools from the index so the model is not
offered tools whose process is gone, and records what the child last wrote to **stderr** — which
for a server that failed to start is usually the only useful explanation ("no module named
mcp_server_git" rather than "MCP error -32000: Connection closed").

Every refusal from `client()` and `call()` is an `McpPoolError` with a `code`, because the
message alone cannot separate the two that matter most:

```ts
try {
  await pool.client(id);
} catch (error) {
  if (error instanceof McpPoolError) respond(status[error.code], error.detail);
}
```

`unknown-server`, `disabled`, `backoff` (a failure recent enough that nothing was dialled — with
`retryAt` for when one will be) and `connect-failed` (dialled just now, and could not — with the
child's stderr in `detail`). `call()` adds `unknown-tool` and `out-of-scope`, which deliberately
**share their message**: a run must not learn that a server it was not scoped to exists. The
messages are unchanged from the plain `Error`s these replaced. `sync()` and `reconnect()` have one
of their own, `no-configs` — see [the seam](#the-seam).

A failed server is then retried, which is the other half: `sync` leaves a *healthy* unchanged
server alone but treats a failed one as work to do, and `call` brings back a server that is
merely down rather than telling the model its tool does not exist. Both are held off by
`crashBackoffMs` (5s), or a server that cannot start would be respawned on every write.

## Timeouts

`connectTimeoutMs` caps how long a server gets to answer `initialize` and `tools/list`. The SDK
already applies its own 60s, so this is not about an unbounded hang — it is about how long a boot
is willing to stall. `sync` connects in parallel, but one wedged server still holds the whole
reconcile open for the full timeout, so the number to pick is the one your startup can afford,
not the one a healthy server needs.

Unset is the SDK's 60s, which is a ceiling rather than a budget.

It is one budget for the **whole connect**, not a fresh allowance per request: `initialize` and
every page of `tools/list` spend the same clock, and what is left when the handshake finishes is
what the walk gets. Page size is the server's choice — a hundred-tool server answering ten at a
time is eleven requests — so a per-request bound would really have been `connectTimeoutMs × (1 +
pages)`, which is not a number a startup budget can be picked from without knowing a server's page
count in advance. A connect that runs out fails as a timeout rather than keeping the pages it
managed: a tool missing from the index is one `call()` refuses as a tool that does not exist, and
a short list is a wrong answer that looks right.

`McpServerConfig.connectTimeoutMs` overrides it per server, the way `idleTimeoutMs` does, because
connect cost is a property of the server rather than of the pool:

```ts
{ id: "git",  command: "node", args: ["./node_modules/.bin/git-mcp"] } // up in milliseconds
{ id: "docs", command: "uvx", args: ["some-mcp-server@latest"], connectTimeoutMs: 120_000 }
```

`uvx` on a cold cache resolves and downloads a package before it says anything. One pool-wide
number has to be the maximum of those, which leaves the fast server with no useful bound — the
wedged `node` child this option exists to catch still hangs for the two minutes the slow one
legitimately needs. `null` or absent is the pool's number, which is what every row that predates
the field says; unlike `idleTimeoutMs` there is no special `0`, which is simply a server given no
time at all.

The row is re-read on every reconcile, so a consumer whose configuration is hand-editable does not
need a restart to change it. An edited timeout does not bounce a running child — it is read at
connect time, so it applies to the next one.

## Probing

A config is easy to get subtly wrong, and finding out at 3am when the task runs is too late.
`probe()` connects a config that may not be saved yet, lists its tools, and hangs up:

```ts
const { ok, error, tools, instructions } = await mcp.probe(row); // { ok: false, error: "no module named …" }
```

`instructions` is there for the same reason `tools` is: "Test connection" is where an operator
finds out what a row actually offers, and what its tools are *for* is the half a tool list does
not show. Empty where the server sent none, or where the dial never got that far.

It reports rather than throws, and `error` is the child's **stderr** where there is one — the same
tail that makes a failed server diagnosable above, which is the whole difference between "no
module named mcp_server_git" and "MCP error -32000: Connection closed".

Going through the pool is what binds the client identity, the `childEnv` policy and the timeout to
whatever this pool uses, so the probe dials the way the pool will. Every consumer that called the
free `probe()` wrote that wrapper itself, and one that bound them differently showed up only in a
remote server's logs. The free function stays exported for a caller with no pool, and takes that
identity as one argument — `probe(row, "my-gateway")` for the name alone, or
`probe(row, { name: "my-gateway", version: "1.4.0" })` for both. A `-probe` suffix is appended to
whichever name arrives, so a server's log tells a test connection apart from a real one.

`probeTimeoutMs` overrides `connectTimeoutMs` for probes alone, defaulting to it. The two have
different audiences: a reconcile of thirty servers at boot can afford to be patient, and a person
who has just pressed "Test connection" cannot. A row's own `connectTimeoutMs` outranks both: a
server that needs two minutes to start needs them behind the button too, or the button reports a
failure for a server that works.

The free `probe()` reads that row too, having no pool to ask — `probe(row)` waits as long as the
row says. Its `timeoutMs` option outranks the row, since a number passed at the call site is a
decision about that one probe, and neither set leaves the SDK's 60s:

```ts
await probe(row);                          // the row's connectTimeoutMs, else the SDK's 60s
await probe(row, "my-gateway", { timeoutMs: 5_000 }); // this probe, whatever the row says
```

## Logging

The pool logs — a server's tool count on connect, what it wrote on the way out, a name nothing
offers — and by default it logs to `console`. A consumer wondering why MCP chatter is in its
stdout wants `log`:

```ts
import { McpPool, type PoolLog } from "@cubicecho/agent-mcp-pool";

new McpPool({ load, log: { info: logger.debug, error: logger.warn } });
```

Both halves are optional, so `{}` is silence and `{ error: logger.warn }` keeps the failures and
drops the rest. `PoolLog` is exported so a consumer can declare one rather than infer it.

## Notifications

Anything a server sends that the SDK does not handle itself — `tools/list_changed`,
`resources/list_changed`, `prompts/list_changed`, `resources/updated`, `logging/message` — is
dropped unless someone is listening:

```ts
const stop = pool.onNotification((id, notification) => {
  if (notification.method === "notifications/tools/list_changed") reload(id);
});
```

The server id comes first because a listener hears from every server at once and the notification
does not say where it came from. The handler is installed before each connect and reinstalled on
a respawn, so a `logging/message` sent during a server's own startup is not missed. An agent loop
can ignore all of this — the index is rebuilt on `sync()` — but a consumer relaying the protocol
onward cannot.

## The child's environment

By default a stdio child inherits **all** of `process.env`, which is how the two servers this
came from did it. That hands third-party code every secret this process was started with, so
`childEnv` narrows it:

```ts
import { McpPool, MINIMAL_CHILD_ENV } from "@cubicecho/agent-mcp-pool";

new McpPool({ load, childEnv: MINIMAL_CHILD_ENV });
```

The permissive default is kept deliberately: narrowing breaks any server that quietly depends on
a variable the allowlist does not name, and the stderr tail above is what makes that diagnosable
when it happens.

## Naming

Tools are `<slug>__<tool name>`, capped at 64 characters for OpenAI's function-name limit, and
resolved by whole-string lookup rather than by splitting on `__` — the split of a shortened name
is a tool its server never had.

`slug` is optional and defaults to `id`. A consumer whose ids are already namespace-shaped has
nothing else to put in a slug column, and a second name beside such an id only gives an operator
a way to make the two disagree. `state()` reports the effective value, so a consumer that never
set one still sees what its tools are called.

A name that does not fit keeps its first 57 characters and spends the rest on `_` plus six hex
digits of a SHA-256 of the *whole* name. Truncating alone made two tools sharing a 64-character
prefix collapse onto one key, so the second silently replaced the first and the model was offered
a name that dispatched to the wrong tool. Names that already fit are returned byte-for-byte, so
nothing that was unambiguous before changes on the wire.

`mcp-router` has a namespacing scheme that looks identical and is not: it splits names a *foreign*
MCP client invented, longest-prefix-first, and applies the same scheme to resource URIs and prompt
names. The two cannot be shared — unify on this truncation and its resource URIs corrupt.

## Where the merged behaviour came from

- The reconcile queue (`running`, `queue`, `syncSoon`, `flush`) is `task_server`'s. Without it,
  two syncs interleaving both spawn a child for the same edited server and the second orphans
  the first — a live process with nothing holding a handle to close it. `kanban_server` still
  has that race.
- The per-run server scoping is `kanban_server`'s idea with `task_server`'s signature.
