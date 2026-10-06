/** What of a tool `rankTools` reads. */
export interface SearchableTool {
  name: string;
  title?: string;
  description: string;
  /**
   * What its server is called. Worth the least: every tool of a server called `files` shares it,
   * so it can bring a server into a result and cannot order the tools inside one.
   */
  server?: string;
}

/** What a query word is worth by where it turned up. A name is chosen; a description rambles. */
const WEIGHT = { name: 3, title: 2, description: 1, server: 1 };

/** Below this a shared prefix is noise: `re` begins half the verbs a tool is named with. */
const MIN_PREFIX = 3;

/**
 * The words of a name or a sentence, lower-cased.
 *
 * Split on anything that is not a letter or a digit and on a camelCase hump, since tool names come
 * as `read_file`, `read-file`, `fs.read` and `readFile` and a query comes as none of them.
 */
export function searchWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A word without the ending English put on it, so `reads`, `reading` and `read` are one word.
 *
 * Three suffixes and no dictionary. It gets `status` wrong, and gets it wrong on both sides of
 * the comparison, which is all a match needs.
 */
function stem(word: string) {
  for (const suffix of ["ing", "ed", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_PREFIX) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

const stems = (text: string) => new Set(searchWords(text).map(stem));

/** 1 for the word itself, half for one that begins it or that it begins, 0 otherwise. */
function match(query: string, words: ReadonlySet<string>) {
  if (words.has(query)) return 1;
  if (query.length < MIN_PREFIX) return 0;
  for (const word of words) {
    if (word.length < MIN_PREFIX) continue;
    // `auth` finds `authenticate`, and `writ` — what is left of `writing` — finds `write`.
    if (word.startsWith(query) || query.startsWith(word)) return 0.5;
  }
  return 0;
}

/**
 * Ranks tools against a query by the words they share.
 *
 * Token overlap and nothing cleverer: each word of the query scores once, by the best place it
 * turned up — name over title over description, and the server's own name last. It is a shortlist for a prompt, where being
 * roughly right about thirty tools out of a hundred and forty is the whole job, and an embedding
 * would be a dependency and a model call to do it slightly better.
 *
 * @param query What the turn is about, in any words.
 * @param tools The tools to rank.
 * @returns The tools that share a word with the query, best first, ties in the order given.
 */
export function rankTools<T extends SearchableTool>(query: string, tools: readonly T[]): T[] {
  const wanted = [...stems(query)];
  if (wanted.length === 0) return [];
  const scored: { tool: T; score: number; at: number }[] = [];
  tools.forEach((tool, at) => {
    const name = stems(tool.name);
    const title = stems(tool.title ?? "");
    const description = stems(tool.description);
    const server = stems(tool.server ?? "");
    let score = 0;
    for (const word of wanted) {
      score += Math.max(
        WEIGHT.name * match(word, name),
        WEIGHT.title * match(word, title),
        WEIGHT.description * match(word, description),
        WEIGHT.server * match(word, server),
      );
    }
    if (score > 0) scored.push({ tool, score, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map(({ tool }) => tool);
}
