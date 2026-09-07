# @cubicecho/mcp-pool

A pool of long-lived Model Context Protocol clients, exposing every connected server's tools to
an OpenAI-compatible agent loop as `<slug>__<tool name>`.

Connections are long-lived and shared across runs: a stdio server is a child process, and
spawning one per run would cost more than the run.

## The seam

The two servers this came from both did `import { db }` and read an `mcp_servers` table. The
pool now asks for its rows instead:

```ts
import { McpPool } from "@cubicecho/mcp-pool";

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

## Where the merged behaviour came from

- The reconcile queue (`running`, `queue`, `syncSoon`, `flush`) is `task_server`'s. Without it,
  two syncs interleaving both spawn a child for the same edited server and the second orphans
  the first — a live process with nothing holding a handle to close it. `kanban_server` still
  has that race.
- The per-run server scoping is `kanban_server`'s idea with `task_server`'s signature.
