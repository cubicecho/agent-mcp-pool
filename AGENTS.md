# AGENTS.md — agent-mcp-pool

`@cubicecho/agent-mcp-pool` is a pool of long-lived Model Context Protocol clients for an agent
loop. A **server** is a row of configuration — a stdio command or an http url — that the pool
reconciles against the clients actually running; its **tools** are offered to a model as
`<slug>__<tool name>`; a **run** is one agent turn, optionally **scoped** to a subset of the
servers. It is a library, not a service: nothing listens on a port, and the consumer owns the
process and the rows.

Read [`README.md`](README.md) first — it holds the design decisions this file only summarises.
[`llms.txt`](llms.txt) is the generated index of the exports.

Single package, no workspaces: `src/` (the library), `tests/` (Vitest, booting a real stdio MCP
server out of `tests/fixtures/`), `scripts/` (the `prepare` guard and the `llms.txt` generator).

## Commands

```bash
# Quality — run all four before every commit; CI fails otherwise
npm run lint             # biome check .   (CI uses `npx biome ci .`)
npm run format           # biome check --write .
npm run typecheck        # tsc -p tsconfig.tests.json
npm test                 # vitest run
npm run coverage         # vitest run --coverage  (what CI runs; no threshold)

# Build
npm run build            # tsc -p tsconfig.build.json, then regenerates llms.txt
npm run llms             # llms.txt on its own
npm run llms:check       # fails if the committed llms.txt is stale
```

## Tech stack

| Choice | Why |
| --- | --- |
| **`@modelcontextprotocol/sdk` as a peer** | `client()` hands the consumer a real `Client`, so the SDK has to be *their* copy. Two copies in one process means two versions of the protocol and a type that does not match itself. |
| **No `openai` dependency at all** | `tools()` returns a locally declared `ToolDefinition`, assignable to `OpenAI.ChatCompletionTool` because TypeScript is structural. As a required peer it cost a consumer that never calls a model 24MB for two erased type positions; `openai` stays a devDependency, and a test annotation holds the two shapes together. |
| **Vitest over `node:test`** | The suites spawn real child processes and assert on what is left running afterwards; the `--coverage` integration is what found the untested http transport. |
| **`.ts` import specifiers** | With `rewriteRelativeImportExtensions`, source imports resolve as written and are rewritten on build — no `.js` that means `.ts`. |
| **A generated `llms.txt`** | A hand-written copy of an API surface drifts from the surface. CI fails on a diff rather than trusting anyone to remember. |

## Key conventions

**Absent scope is every server; empty scope is none.** `tools`, `catalog` and `call` all take an
optional set of ids, and the two cases must never collapse — "this agent has no servers linked"
is a real and correct state, and collapsing it silently gives a scoped run the whole pool.

**A qualified name is resolved whole, never split on `__`.** Names past 64 characters keep 57 of
them plus a hash of the whole, so the split of a shortened name is a tool its server never had.

**`tools()` and `catalog()` never connect a server. `call()` and `client()` do.** A cold server
offers nothing until something has used it; listing its tools without spawning it would need a
cached last-known list, which does not exist yet.

**Every use goes through `ensure()`.** It is the single door, so lazy connect and the idle clock
cannot disagree about what counts as a use.

**A reap is a success path, not a crash.** An idle-closed server goes to `idle` with no error and
no `failedAt`, so no backoff stands between it and the next call. Only a real failure sets
`error`.

**Reconciles are queued, never concurrent.** Two interleaving syncs both spawn a child for the
same edited server and the second orphans the first — a live process with nothing holding a
handle to close it.

**`tools/list` is drained, never read one page deep.** Page size is the server's choice, and a
tool left on page two is not merely unlisted — it is absent from `index`, so `call()` refuses it
as one that does not exist. `listAllTools` is the one walk; a `resources/list` or `prompts/list`
added later paginates the same way.

**`llms.txt` is generated and committed.** Edit the doc comment it came from, then `npm run
build`. CI fails on a diff.

## Standards

This repo follows [`ai_tools/standards/`](../standards/). In particular:

- [Project shape](../standards/conventions/project-shape.md)
- [TypeScript and npm scripts](../standards/conventions/typescript-and-scripts.md)
- [Code style](../standards/conventions/code-style.md) — including the comment rules this repo
  leans on hardest: prose that says *why*, kept terse, and `@param`/`@returns` on the exported
  surface wherever the signature does not already say it
- [Errors, logging and configuration](../standards/conventions/errors-logging-config.md)
- [Testing](../standards/conventions/testing.md)
- [Git and release](../standards/conventions/git-and-release.md) — Conventional Commits and
  semantic-release off `main`
- [Docker and CI](../standards/conventions/docker-and-ci.md)
- [MCP servers](../standards/conventions/mcp-servers.md)

Two standing divergences from the git standard, both by direction rather than drift: this repo
**rebases** feature branches onto `main` before merge, and commits carry AI attribution trailers.

## Finding code

Prefer an LSP (definitions, references) over grep when navigating.
