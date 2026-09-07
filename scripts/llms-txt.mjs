/**
 * Writes `llms.txt` from what `src/index.ts` actually exports.
 *
 * Generated because a hand-written copy of an API surface drifts from the surface. Fix anything
 * wrong here in the doc comment it came from.
 *
 * The parse is hand-rolled and small. TypeScript 7 is native and no longer ships the JS API this
 * would have used; the replacement sits under `typescript/unstable/*`, and `build` is what
 * `prepare` runs, so an unstable API breaking under a caret range would break publishing. Every
 * assumption below throws, so a source file that stops matching fails the build rather than
 * quietly emitting less.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

/**
 * Every doc comment in a file, paired with the line that follows it.
 *
 * That line is what says who the comment belongs to: a declaration means it documents that
 * declaration, a blank line means it documents the file. Both the one-line `/** text *\/`
 * spelling and the block form are read.
 *
 * @param source Full text of a `.ts` file.
 * @returns One `{ body, next }` per comment in source order, `body` stripped of its `*` margin.
 */
function docBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].indexOf("/**");
    if (open === -1) continue;
    const sameLineClose = lines[i].indexOf("*/", open + 3);
    if (sameLineClose !== -1) {
      blocks.push({
        body: [lines[i].slice(open + 3, sameLineClose).trim()],
        next: lines[i + 1] ?? "",
      });
      continue;
    }
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j].includes("*/"); j++)
      body.push(lines[j].replace(/^\s*\* ?/, ""));
    if (j === lines.length) throw new Error("unterminated doc comment");
    const tail = lines[j]
      .slice(0, lines[j].indexOf("*/"))
      .replace(/^\s*\* ?/, "")
      .trim();
    if (tail !== "") body.push(tail);
    blocks.push({ body, next: lines[j + 1] ?? "" });
    i = j;
  }
  return blocks;
}

/**
 * Blank-line-separated paragraphs of a comment body, each collapsed to one line.
 *
 * @param body Comment lines, as `docBlocks` returns them.
 */
function paragraphs(body) {
  const out = [];
  let current = [];
  for (const line of body) {
    if (line.trim() === "") {
      if (current.length > 0) out.push(current.join(" ").trim());
      current = [];
    } else current.push(line.trim());
  }
  if (current.length > 0) out.push(current.join(" ").trim());
  return out.filter((entry) => entry !== "");
}

/**
 * The name a line declares, for the declaration forms this source actually uses.
 *
 * @param line One line — in practice the `next` of a doc block.
 * @returns The declared name, or null when the line declares nothing exported.
 */
function declaredName(line) {
  const match = line.match(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  );
  return match?.[1] ?? null;
}

/**
 * First sentence of a comment body, as one line.
 *
 * `e.g.`, `i.e.`, `vs.`, `etc.` and `cf.` end a clause rather than a sentence, so the scan reads
 * past them instead of cutting a summary in half.
 *
 * @param body Comment lines, as `docBlocks` returns them.
 */
function summarize(body) {
  const text = paragraphs(body)[0] ?? "";
  if (text === "") return "";
  const match = text.match(/^(.*?[.!?])(?:\s|$)/s);
  if (!match) return text;
  let end = match[1];
  let rest = text.slice(end.length);
  while (/(?:^|\s)(?:e\.g|i\.e|vs|etc|cf)\.$/.test(end) && rest.trim() !== "") {
    const more = rest.match(/^(\s*.*?[.!?])(?:\s|$)/s);
    if (!more) return text;
    end += more[1];
    rest = rest.slice(more[1].length);
  }
  return end;
}

/**
 * Every `export ... from "..."` in the index, in order, with the names each one re-exports.
 *
 * The specifier is kept rather than only a local module name, because this index also re-exports
 * a type from the SDK — and a parser that skipped what it could not place would drop a public
 * export from the one file whose job is to list them. So an unread statement throws instead.
 *
 * @param indexSource Full text of `src/index.ts`.
 * @returns One entry per statement: `specifier`, `module` (null unless a local `./x.ts`), and
 *   `names`, each tagged with whether it is type-only.
 */
function reexports(indexSource) {
  const found = [];
  const pattern = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)";/g;
  for (const [, blanketType, inner, specifier] of indexSource.matchAll(pattern)) {
    const names = inner
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .map((entry) => {
        const isType = Boolean(blanketType) || entry.startsWith("type ");
        return { name: entry.replace(/^type\s+/, ""), isType };
      });
    if (names.length === 0) throw new Error(`no names re-exported from ${specifier}`);
    const local = specifier.match(/^\.\/([\w-]+)\.ts$/);
    found.push({ specifier, module: local?.[1] ?? null, names });
  }
  if (found.length === 0) throw new Error("no re-exports found in src/index.ts — parser is stale");
  // Counted over the whole source, not per line: several of these statements span lines.
  const statements = indexSource.match(/export\s[^;]*?\sfrom\s"[^"]+";/g)?.length ?? 0;
  if (statements !== found.length)
    throw new Error(
      `src/index.ts has ${statements} re-exports and the parser read ${found.length}`,
    );
  return found;
}

const pkg = JSON.parse(read("package.json"));
const index = read("src/index.ts");

// The block at the top of index.ts, which describes the package rather than any one symbol.
const intro = docBlocks(index).find((block) => block.next.trim() === "");
if (!intro) throw new Error("src/index.ts has no leading module comment");

const out = [`# ${pkg.name}`, "", `> ${pkg.description}`, ""];
// The first paragraph restates the description directly above it; the rest is what a reader does
// not already have.
for (const paragraph of paragraphs(intro.body).slice(1)) out.push(paragraph, "");
const peers = Object.entries(pkg.peerDependencies).map(([name, range]) => `\`${name}\` ${range}`);
out.push(
  `Requires Node ${pkg.engines.node}, with ${peers.join(" and ")} as peer ${
    peers.length === 1 ? "dependency" : "dependencies"
  }. ESM only.`,
  "Full prose, worked examples and the reasoning behind each seam are in README.md; this file is the index.",
  "",
  "## Exports",
  "",
);

let total = 0;
let described = 0;
const undocumented = [];

for (const { specifier, module, names } of reexports(index)) {
  // A name from a dependency has no local source to read, and no gap either — the comment that
  // matters lives in that package. Listed anyway so the index stays complete.
  if (!module) {
    out.push(`### ${specifier}`, "");
    for (const { name, isType } of names) out.push(`- \`${name}\`${isType ? " (type)" : ""}`);
    out.push("");
    continue;
  }

  const source = read(`src/${module}.ts`);
  const blocks = docBlocks(source);

  const docs = new Map();
  for (const block of blocks) {
    const name = declaredName(block.next);
    if (name) docs.set(name, summarize(block.body));
  }
  // A block trailed by a blank line documents the file, not the declaration further down.
  const moduleDoc = blocks.find((block) => block.next.trim() === "");

  out.push(`### ${module}`, "");
  if (moduleDoc) out.push(summarize(moduleDoc.body), "");
  for (const { name, isType } of names) {
    const summary = docs.get(name);
    const label = isType ? `\`${name}\` (type)` : `\`${name}\``;
    out.push(summary ? `- ${label} — ${summary}` : `- ${label}`);
    total += 1;
    if (summary) described += 1;
    else undocumented.push(`${module}.${name}`);
  }
  out.push("");
}

const rendered = `${out
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trimEnd()}\n`;
const target = join(root, "llms.txt");

// `--check` is what CI runs. The file is committed, so an export added or a comment reworded
// without regenerating leaves a stale index, and noticing that by hand is what this replaces.
if (process.argv.includes("--check")) {
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (existing !== rendered) {
    console.error("llms.txt is out of date. Run `npm run llms` and commit the result.");
    process.exit(1);
  }
  console.log("llms.txt is up to date");
} else {
  writeFileSync(target, rendered);
  console.log(`llms.txt written: ${described}/${total} exports carry a description`);
  // Named rather than only counted: the gap is in the source, and this is the only thing
  // positioned to notice. Not an error — worth knowing, not worth failing a build over.
  if (undocumented.length > 0) console.log(`no doc comment: ${undocumented.join(", ")}`);
}
