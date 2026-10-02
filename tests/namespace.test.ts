import { expect, test } from "vitest";
import { NAME_CHARS, namespaceOwners } from "../src/namespace.ts";

test("a namespace nobody contests is owned by the row that has it", () => {
  const { owner, shadowed } = namespaceOwners([{ id: "a", slug: "fs" }, { id: "b" }]);
  expect([...owner]).toEqual([
    ["fs", "a"],
    ["b", "b"],
  ]);
  expect(shadowed.size).toBe(0);
});

test("a contested namespace goes to the lowest id, whatever order the rows come in", () => {
  const rows = [
    { id: "c", slug: "fs" },
    { id: "a", slug: "fs" },
    { id: "b", slug: "fs" },
  ];
  for (const order of [rows, [...rows].reverse()]) {
    const { owner, shadowed } = namespaceOwners(order);
    expect(owner.get("fs")).toBe("a");
    expect([...(shadowed.get("fs") ?? [])].sort()).toEqual(["b", "c"]);
  }
});

test("a row with no slug contests the namespace its id names", () => {
  const { owner, shadowed } = namespaceOwners([{ id: "fs" }, { id: "a", slug: "fs" }]);
  expect(owner.get("fs")).toBe("a");
  expect(shadowed.get("fs")).toEqual(["fs"]);
});

test("the allowed characters are a character class body", () => {
  expect(new RegExp(`^[${NAME_CHARS}]+$`).test("fs_read-2")).toBe(true);
  expect(new RegExp(`^[${NAME_CHARS}]+$`).test("fs.read")).toBe(false);
});
