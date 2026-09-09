// Shared by the launchers: compile on first launch when dist/ is missing (global git install).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function ensureBuilt() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(join(root, "dist", "cli", "run.js"))) return;
  const r = spawnSync(process.execPath, [join(root, "scripts", "build.mjs"), "--fetch", "--stderr"], { stdio: "inherit" });
  if (r.status !== 0) {
    process.stderr.write("xflow-timesheet: build failed; run `npm run build` in the package directory\n");
    process.exit(r.status ?? 1);
  }
}
