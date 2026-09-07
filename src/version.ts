import { createRequire } from "node:module";

/**
 * What this package calls itself in the `clientInfo` of a handshake it was given no name for.
 *
 * Both halves of that object were literals until a consumer noticed the version was one: every
 * server the pool dialled was told the client was at `0.1.0`, which is a plausible-looking lie
 * rather than a missing value. The name is still a literal because it is one — the version is
 * read from the package, since releases are cut by semantic-release, which bumps `package.json`
 * and nothing else, so a second copy written down here would be stale by the next one.
 */
export const DEFAULT_CLIENT_NAME = "agent-mcp-pool";

/** Reserved by semver as the version before any release, and read as "unset" by anything human. */
const UNKNOWN_VERSION = "0.0.0";

/** This package's own version, as npm installed it. */
export const POOL_VERSION: string = readVersion();

function readVersion(): string {
  try {
    // A require rather than an import: `rootDir` is `src`, so a static `../package.json` would
    // not compile, and the path holds either way — `src/version.ts` and `dist/version.js` are
    // both one directory below the manifest.
    const manifest = createRequire(import.meta.url)("../package.json") as { version?: string };
    return manifest.version ?? UNKNOWN_VERSION;
  } catch {
    // A bundler that inlined this module and left the manifest behind. An unknown version is
    // worth more than a throw at import time, from a package that was only being asked to
    // introduce itself.
    return UNKNOWN_VERSION;
  }
}
