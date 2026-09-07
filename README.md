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
});
```

A stdio server may also name a `cwd`; absent, it inherits this process's. Several servers resolve
relative paths — a filesystem root, a sqlite file — against their working directory rather than
against an argument, and it counts as part of the connection: editing it restarts the child.

`sync(configs?)` reconciles against what it is given, or against `load` when given nothing.
`syncSoon()` debounces a reconcile past a transaction commit, and `flush()` pays one off early
for a reader that would otherwise be shown the pool as it stood before its own write.

## State

`state()` reports every configured server **in the order it was configured**, and hands back the
row it was configured from:

```ts
for (const { config, status, error, tools, pid, startedAt } of mcp.state()) {
  // config is a copy of the row you passed in, minus its credentials;
  // status/error/tools/pid/startedAt are what the pool made of it
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
and `call(name, input, servers)` stay positional: neither has two arguments that could be
confused for each other.

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

### Reconnecting one server

`sync()` leaves an unchanged row alone, so it is no use on a server that has wedged.
`reconnect()` is the unconditional one: it closes the child and dials again, changed or not,
`lazy` included. It used to drop the entry and let the reconcile rebuild it, and a lazy reconcile registers an entry and waits for a use — so on a lazy
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
the same walk rather than one `listTools`.

`resultText` is the flattening `call()` does, exported separately: MCP answers with a list of
content blocks and a message array holds one string. A consumer driving the client itself and
still putting the answer in front of a model wants the same rule rather than its own — everything
that is not text is *named* (`[image content]`) rather than dropped, so a model that asked for a
screenshot is told it got one instead of being handed an empty string and left to conclude the
call failed.

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
messages are unchanged from the plain `Error`s these replaced.

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

## Probing

A config is easy to get subtly wrong, and finding out at 3am when the task runs is too late.
`probe()` connects a config that may not be saved yet, lists its tools, and hangs up:

```ts
const { ok, error, tools } = await mcp.probe(row); // { ok: false, error: "no module named …" }
```

It reports rather than throws, and `error` is the child's **stderr** where there is one — the same
tail that makes a failed server diagnosable above, which is the whole difference between "no
module named mcp_server_git" and "MCP error -32000: Connection closed".

Going through the pool is what binds the client name, the `childEnv` policy and the timeout to
whatever this pool uses, so the probe dials the way the pool will. Every consumer that called the
free `probe()` wrote that wrapper itself, and one that bound them differently showed up only in a
remote server's logs. The free function stays exported for a caller with no pool.

`probeTimeoutMs` overrides `connectTimeoutMs` for probes alone, defaulting to it. The two have
different audiences: a reconcile of thirty servers at boot can afford to be patient, and a person
who has just pressed "Test connection" cannot.

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
