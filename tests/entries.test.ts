import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The entries a browser bundle imports. `tsconfig.browser.json` is the type-level half of this. */
const BROWSER_ENTRIES = { "./hooks": "hooks", "./servers": "servers" };

/**
 * Every module an entry reaches at runtime, following relative imports. A `import type` is erased,
 * so it is not followed and not counted.
 */
function runtimeImports(module: string, seen = new Map<string, string[]>()) {
  if (seen.has(module)) return seen;
  const source = readFileSync(join(root, "src", `${module}.ts`), "utf8");
  const specifiers = [...source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)";/gms)].map(
    (match) => match[1],
  );
  seen.set(module, specifiers);
  for (const specifier of specifiers) {
    const local = specifier.match(/^\.\/([\w-]+)\.ts$/);
    if (local) runtimeImports(local[1], seen);
  }
  return seen;
}

test("each browser entry is in the exports map, pointing at its module", () => {
  for (const [subpath, module] of Object.entries(BROWSER_ENTRIES)) {
    expect(pkg.exports[subpath], subpath).toEqual({
      types: `./dist/${module}.d.ts`,
      import: `./dist/${module}.js`,
    });
  }
});

/**
 * A bundler resolves what an entry imports, not what it uses, so one `node:` import anywhere in
 * the graph — or the SDK, whose root pulls in a stdio transport — fails a browser build outright.
 */
test("nothing a browser entry imports at runtime is Node or the SDK", () => {
  for (const module of Object.values(BROWSER_ENTRIES)) {
    for (const [from, specifiers] of runtimeImports(module)) {
      const foreign = specifiers.filter((specifier) => !specifier.startsWith("./"));
      expect(foreign, `${module} reaches ${from}.ts, which imports`).toEqual([]);
    }
  }
});

test("the runtime graph walk does see a value import", () => {
  // Without this, a regex that matched nothing would pass the test above for every module.
  expect(runtimeImports("servers").get("servers")).toEqual(["./hooks.ts"]);
});
