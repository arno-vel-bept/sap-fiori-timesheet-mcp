/**
 * Installs the package the way a teammate would — `npm pack` then `npm install -g`
 * into a temporary prefix — then exercises the installed binaries end to end
 * (doctor, install-mcp, and a live MCP stdio session). Slow (~1 min):
 *
 *   XFLOW_INSTALL_E2E=1 pnpm vitest run test/e2e/install.test.ts
 *
 * Note: `npm install -g git+<url>` is intentionally not tested/recommended here.
 * npm's global git-dependency install has a well-known issue where the package
 * ends up as a dangling symlink into a temp cache directory that npm deletes
 * right after (see npm/cli#2919 and related reports) — unrelated to this
 * package's build. The supported path is: clone, `npm install && npm run build`,
 * `npm link` (documented in the README).
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const enabled = process.env.XFLOW_INSTALL_E2E === "1";
/** vitest runs under pnpm, which exports npm_config_* that would leak into the npm we drive here. */
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k))) as Record<string, string>;

async function checkInstalled(prefix: string, home: string) {
  const bin = join(prefix, "bin", "xflow-timesheet");
  const mcpBin = join(prefix, "bin", "xflow-timesheet-mcp");
  expect(existsSync(bin)).toBe(true);
  expect(existsSync(mcpBin)).toBe(true);
  const env = { ...cleanEnv, HOME: home, XFLOW_SESSION_FILE: join(home, "s.json") };

  const doctor = await run(bin, ["doctor"], { env }).catch((e: { stdout: string }) => e);
  expect(doctor.stdout).toMatch(/Node/);
  expect(doctor.stdout).toMatch(/no session/);

  const inst = await run(bin, ["install-mcp", "--client", "claude-desktop"], { env });
  expect(inst.stdout).toMatch(/Added "xflow-timesheet"/);
  const cfgFile = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") {
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
    expect(cfg.mcpServers["xflow-timesheet"].args[0]).toMatch(/xflow-timesheet-mcp\.js$/);
  }

  const client = new Client({ name: "install-e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: mcpBin, args: [], env: env as Record<string, string> }));
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("std_fill");
  } finally {
    await client.close();
  }
}

describe.skipIf(!enabled)("installation as a teammate would do it", () => {
  it("npm pack + npm install -g works and the binaries run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-install-pack-"));
    await run("npm", ["run", "build"], { cwd: process.cwd(), env: cleanEnv });
    const { stdout } = await run("npm", ["pack", "--pack-destination", dir], { cwd: process.cwd(), env: cleanEnv });
    const tgz = join(dir, stdout.trim().split("\n").pop()!);
    const prefix = join(dir, "prefix");
    await run("npm", ["install", "-g", "--prefix", prefix, tgz], { env: cleanEnv });
    await checkInstalled(prefix, join(dir, "home"));
  }, 300_000);
});
