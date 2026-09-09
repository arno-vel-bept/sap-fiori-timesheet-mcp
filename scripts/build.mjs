#!/usr/bin/env node
/**
 * Build step used by `npm run build`, by `prepare`, and by the bin launchers when
 * dist/ is missing (global install straight from git: npm copies the clone into
 * place before running `prepare`, so nothing built there survives — npm/cli#2919).
 *
 *   node scripts/build.mjs           compile with node_modules/typescript; if TypeScript
 *                                    is not installed, print a notice and exit 0 (prepare)
 *   node scripts/build.mjs --fetch   …or compile with `npx -p typescript@<pinned> tsc`
 *                                    when TypeScript is missing (first launch of the bins)
 *
 * TypeScript 7's exports map hides bin/tsc from require.resolve, so it is located by path.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fetch = process.argv.includes("--fetch");
const quietStdout = process.argv.includes("--stderr"); // keep stdout clean (MCP over stdio)
const out = quietStdout ? process.stderr : process.stdout;
const log = (m) => out.write(`xflow-timesheet: ${m}\n`);

if (!existsSync(join(root, "src", "cli", "run.ts"))) {
  if (existsSync(join(root, "dist", "cli", "run.js"))) process.exit(0); // packaged tarball: nothing to do
  log("neither src/ nor dist/ present; cannot build");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const wanted = (pkg.devDependencies?.typescript ?? "latest").replace(/^[\^~]/, "");
const tscPath = join(root, "node_modules", "typescript", "bin", "tsc");
// npm_config_* inherited from an outer npm run would redirect npx/npm to the wrong prefix.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
const stdio = ["ignore", quietStdout ? process.stderr : "inherit", "inherit"];

let result;
if (existsSync(tscPath)) {
  result = spawnSync(process.execPath, [tscPath, "-p", "tsconfig.json"], { cwd: root, stdio, env });
} else if (fetch) {
  log(`compiling once with typescript@${wanted} (first launch after a git install)…`);
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  result = spawnSync(npx, ["--yes", "--package", `typescript@${wanted}`, "tsc", "-p", "tsconfig.json"], { cwd: root, stdio, env, shell: process.platform === "win32" });
} else {
  log("TypeScript not installed; skipping compile now — the CLI/MCP will compile itself on first launch");
  process.exit(0);
}
if (result.error) {
  log(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
