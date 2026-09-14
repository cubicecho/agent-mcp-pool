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
