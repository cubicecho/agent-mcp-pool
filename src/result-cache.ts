/** How a pool's result cache is bounded — see `McpPoolOptions.resultCache`. */
export interface ResultCacheOptions {
  /** How long an answer is good for. Default 30000; `0` is until something clears it. */
  ttlMs?: number;
  /** The most answers held at once, across every server. Default 256; `0` is no limit. */
  maxEntries?: number;
}

interface Held {
  serverId: string;
  text: string;
  at: number;
}

/**
 * What tools answered recently, so a call made twice is sent once.
 *
 * Bounded twice: by age, because the pool cannot see what changed behind a server, and by count,
 * because an answer is kept whole — before any `maxResultChars` — and a model that reads a
 * hundred files has asked for a hundred of them. The count is evicted least-recently-used.
 *
 * Deciding *what* may be cached is the pool's, not this class's; see `McpPool.call`.
 */
export class ResultCache {
  /** In order of last use, oldest first — a `Map` keeps insertion order, and a hit re-inserts. */
  private readonly held = new Map<string, Held>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  /**
   * @param options The bounds.
   * @param now The clock, for a test that would rather not wait.
   */
  constructor(
    { ttlMs = 30_000, maxEntries = 256 }: ResultCacheOptions = {},
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /** @returns The answer stored under `key`, or `undefined` if there is none or it has aged out. */
  get(key: string): string | undefined {
    const found = this.held.get(key);
    if (!found) return undefined;
    this.held.delete(key);
    if (this.ttlMs > 0 && this.now() - found.at >= this.ttlMs) return undefined;
    this.held.set(key, found);
    return found.text;
  }

  /**
   * Stores an answer, evicting the least recently used one if that is one too many.
   *
   * @param serverId Whose answer it is, so `clear` can drop a server's without parsing keys.
   */
  set(serverId: string, key: string, text: string) {
    this.held.delete(key);
    this.held.set(key, { serverId, text, at: this.now() });
    if (this.maxEntries <= 0) return;
    for (const oldest of this.held.keys()) {
      if (this.held.size <= this.maxEntries) break;
      this.held.delete(oldest);
    }
  }

  /** Drops every answer one server gave. */
  clear(serverId: string) {
    for (const [key, held] of this.held) if (held.serverId === serverId) this.held.delete(key);
  }

  /** How many answers are held, aged-out ones included until something asks for them. */
  get size() {
    return this.held.size;
  }
}
