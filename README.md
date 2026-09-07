# @cubicecho/agent-mcp-pool

A pool of long-lived Model Context Protocol clients, exposing every connected server's tools to
an OpenAI-compatible agent loop as `<slug>__<tool name>`.

Connections are long-lived and shared across runs: a stdio server is a child process, and
spawning one per run would cost more than the run.

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

`sync(configs?)` reconciles against what it is given, or against `load` when given nothing.
`syncSoon()` debounces a reconcile past a transaction commit, and `flush()` pays one off early
for a reader that would otherwise be shown the pool as it stood before its own write.

## Scope

`tools`, `catalog` and `call` all take an optional set of server ids. **Absent means every
connected server; empty means none of them** — the two must not collapse, because "this agent
has no servers linked" is a real and correct state. `call` re-checks the scope rather than
trusting the definitions the caller was given: a model that has seen a tool name once will call
it again from memory.

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

## Past the agent surface

`tools()` returns OpenAI definitions and `call()` returns a string, because a string is what goes
back into a message array. A consumer that is proxying MCP rather than driving a model wants
neither, and wants resources, prompts, subscriptions and logging that a string was never going to
carry. `client(id)` hands back the connected client:

```ts
const { resources } = await (await pool.client(id)).listResources();
```

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

A failed server is then retried, which is the other half: `sync` leaves a *healthy* unchanged
server alone but treats a failed one as work to do, and `call` brings back a server that is
merely down rather than telling the model its tool does not exist. Both are held off by
`crashBackoffMs` (5s), or a server that cannot start would be respawned on every write.

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

Tools are `<slug>__<tool name>`, truncated to 64 characters for OpenAI's function-name limit, and
resolved by whole-string lookup rather than by splitting on `__` — the split of a truncated name
is a tool its server never had. **Known gap:** two tools that collide after truncation overwrite
each other in the index; there is a test pinning the behaviour.

`mcp-router` has a namespacing scheme that looks identical and is not: it splits names a *foreign*
MCP client invented, longest-prefix-first, and applies the same scheme to resource URIs and prompt
names. The two cannot be shared — unify on this truncation and its resource URIs corrupt.

## Where the merged behaviour came from

- The reconcile queue (`running`, `queue`, `syncSoon`, `flush`) is `task_server`'s. Without it,
  two syncs interleaving both spawn a child for the same edited server and the second orphans
  the first — a live process with nothing holding a handle to close it. `kanban_server` still
  has that race.
- The per-run server scoping is `kanban_server`'s idea with `task_server`'s signature.
