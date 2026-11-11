import { afterEach, expect, test, vi } from "vitest";
import type { McpPool } from "../src/pool.ts";
import { echoServer, makePool, memoryRow } from "../src/testing/index.ts";

let pool: McpPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

const servers = { echo: () => echoServer() };

test("a server's elicitation reaches onElicit with its server id, and the answer goes back", async () => {
  const onElicit = vi.fn(async () => ({ action: "accept" as const, content: { name: "Ada" } }));
  pool = makePool({ servers, onElicit });
  await pool.sync([memoryRow("echo")]);
  const text = await pool.call("echo__echo", { elicit: "Who is asking?" });
  expect(JSON.parse(text.replace(/^elicit\((.*)\)$/s, "$1"))).toEqual({
    action: "accept",
    content: { name: "Ada" },
  });
  expect(onElicit).toHaveBeenCalledWith(
    "echo",
    expect.objectContaining({ message: "Who is asking?", requestedSchema: expect.any(Object) }),
    { signal: expect.any(AbortSignal) },
  );
});

test("a handler that throws is logged and answered cancel", async () => {
  const error = vi.fn();
  pool = makePool({
    servers,
    log: { error },
    onElicit: () => {
      throw new Error("no prompt here");
    },
  });
  await pool.sync([memoryRow("echo")]);
  const text = await pool.call("echo__echo", { elicit: "anyone?" });
  expect(text).toBe('elicit({"action":"cancel"})');
  expect(error).toHaveBeenCalledWith(
    expect.stringMatching(/echo: elicitation handler threw: no prompt here/),
  );
});

test("without onElicit the pool declares no capability and the server refuses to ask", async () => {
  pool = makePool({ servers });
  await pool.sync([memoryRow("echo")]);
  await expect(pool.call("echo__echo", { elicit: "hello?" })).rejects.toThrow(/does not support/);
});

const answered = (text: string) => JSON.parse(text.replace(/^elicit\((.*)\)$/s, "$1"));

test("a call's own onElicit answers what that call causes, with no pool-wide handler", async () => {
  pool = makePool({ servers, elicitation: true });
  await pool.sync([memoryRow("echo")]);
  const onElicit = vi.fn(async () => ({ action: "accept" as const, content: { name: "Grace" } }));
  const text = await pool.call("echo__echo", { elicit: "Who is asking?" }, { onElicit });
  expect(answered(text)).toEqual({ action: "accept", content: { name: "Grace" } });
  expect(onElicit).toHaveBeenCalledWith(
    "echo",
    expect.objectContaining({ message: "Who is asking?" }),
    { signal: expect.any(AbortSignal) },
  );
});

test("a call's own onElicit is asked ahead of the pool-wide one", async () => {
  const wide = vi.fn(async () => ({ action: "decline" as const }));
  pool = makePool({ servers, onElicit: wide });
  await pool.sync([memoryRow("echo")]);
  const own = vi.fn(async () => ({ action: "accept" as const, content: { name: "Ada" } }));
  const text = await pool.call("echo__echo", { elicit: "mine?" }, { onElicit: own });
  expect(answered(text).action).toBe("accept");
  expect(own).toHaveBeenCalledOnce();
  expect(wide).not.toHaveBeenCalled();
});

test("with two calls in flight the elicitation goes to the pool-wide handler, not either call", async () => {
  const wide = vi.fn(async () => ({ action: "accept" as const, content: { name: "pool" } }));
  pool = makePool({ servers, onElicit: wide });
  await pool.sync([memoryRow("echo")]);
  const own = vi.fn(async () => ({ action: "accept" as const, content: { name: "call" } }));
  const other = pool.call("echo__echo", { sleepMs: 300 }, { onElicit: own });
  await new Promise((done) => setTimeout(done, 50));
  const text = await pool.call("echo__echo", { elicit: "whose?" }, { onElicit: own });
  await other;
  expect(answered(text)).toEqual({ action: "accept", content: { name: "pool" } });
  expect(wide).toHaveBeenCalledOnce();
  expect(own).not.toHaveBeenCalled();
});

test("an elicitation nobody can be named for is declined when only calls answer", async () => {
  pool = makePool({ servers, elicitation: true });
  await pool.sync([memoryRow("echo")]);
  const own = vi.fn(async () => ({ action: "accept" as const, content: { name: "call" } }));
  const other = pool.call("echo__echo", { sleepMs: 300 }, { onElicit: own });
  await new Promise((done) => setTimeout(done, 50));
  const text = await pool.call("echo__echo", { elicit: "whose?" }, { onElicit: own });
  await other;
  expect(answered(text)).toEqual({ action: "decline" });
  expect(own).not.toHaveBeenCalled();
  // A call with no handler of its own, alone on the connection, is declined too.
  expect(answered(await pool.call("echo__echo", { elicit: "anyone?" }))).toEqual({
    action: "decline",
  });
});

test("a person who has not answered by the call's timeout is cancelled, and their signal aborts", async () => {
  pool = makePool({ servers, elicitation: true });
  await pool.sync([memoryRow("echo")]);
  let seen: AbortSignal | undefined;
  const onElicit = vi.fn((_id: string, _params: unknown, { signal }: { signal: AbortSignal }) => {
    seen = signal;
    return new Promise<never>(() => {});
  });
  await expect(
    pool.call("echo__echo", { elicit: "still there?" }, { onElicit, timeoutMs: 200 }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(onElicit).toHaveBeenCalledOnce();
  expect(seen?.aborted).toBe(true);
});

test("a call's handler that throws is logged and answered cancel", async () => {
  const error = vi.fn();
  pool = makePool({ servers, elicitation: true, log: { error } });
  await pool.sync([memoryRow("echo")]);
  const text = await pool.call(
    "echo__echo",
    { elicit: "anyone?" },
    {
      onElicit: () => {
        throw new Error("no prompt here");
      },
    },
  );
  expect(text).toBe('elicit({"action":"cancel"})');
  expect(error).toHaveBeenCalledWith(
    expect.stringMatching(/echo: elicitation handler threw: no prompt here/),
  );
});
