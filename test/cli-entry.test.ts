import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// On Windows `pnpm` is a `.cmd` shim, which execFile/spawn will not run without a shell.
const run = (cmd: string, args: string[], opts: Parameters<typeof execFileAsync>[2] = {}) =>
  execFileAsync(cmd, args, { cwd: process.cwd(), shell: process.platform === "win32", ...opts });

describe("CLI entry point", () => {
  it("prints usage when executed as a script (pnpm cli --help)", async () => {
    const { stdout } = await run("pnpm", ["exec", "tsx", "src/cli/run.ts", "--help"], { cwd: process.cwd() });
    expect(stdout).toMatch(/Usage: xflow-timesheet/);
    expect(stdout).toMatch(/login/);
  });

  it("prints the package version", async () => {
    const { stdout } = await run("pnpm", ["exec", "tsx", "src/cli/run.ts", "--version"], { cwd: process.cwd() });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports a missing session with exit code 1", async () => {
    await expect(
      run("pnpm", ["exec", "tsx", "src/cli/run.ts", "session", "status", "--session-file", "/nonexistent/s.json"]),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(/no session/i) });
  });
});
