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
