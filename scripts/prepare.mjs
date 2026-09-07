/**
 * The `prepare` script, guarded so it only builds where a build is possible.
 *
 * `prepare` has to be the hook rather than `prepack`, because it is the only one that runs when
 * a consumer installs this package from a git URL — `prepack` leaves them a package whose
 * `exports` names a `dist/` that was never built (see 704ce92).
 *
 * The cost is that npm also registers `prepare` as an *install* script and re-runs it inside the
 * installed tree, where `files` has shipped no `tsconfig.build.json`, no `src`, and none of the
 * devDependencies the compiler needs. That re-run cannot succeed, and when a consumer approves
 * install scripts it does not merely fail — it takes the whole install down:
 *
 *     error TS5058: The specified path does not exist: 'tsconfig.build.json'
 *
 * Shipping the build inputs is not enough on its own: the installed tree still has no
 * `typescript` and no `@types/node`, so the same re-run fails on TS2688 instead. So the re-run is
 * skipped rather than satisfied. A tree with no build config is one that was installed, not one
 * that was checked out, and it already has the `dist` it was published with.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(new URL("../tsconfig.build.json", import.meta.url))) process.exit(0);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Inherited rather than captured: a failing build here is a real failure and its output is the
// only explanation anyone gets.
const { status } = spawnSync(npm, ["run", "build"], { stdio: "inherit" });
process.exit(status ?? 1);
