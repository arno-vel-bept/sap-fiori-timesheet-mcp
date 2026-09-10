import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeIdp, type FakeIdp } from "./fixtures/fake-idp.js";

let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456" });
});
afterAll(() => idp.close());

/** Drive the CLI inside a real pseudo-terminal using /usr/bin/expect. */
function runInPty(script: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("expect", ["-c", script], { cwd: process.cwd(), env: { ...process.env, TERM: "xterm" } });
    let output = "";
    child.stdout.on("data", (c) => (output += c.toString()));
    child.stderr.on("data", (c) => (output += c.toString()));
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe.skipIf(!existsSync("/usr/bin/expect"))("login prompts in a real TTY", () => {
  it("accepts email, hidden password and code typed at the terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-tty-"));
    const sessionFile = join(dir, "session.json");
    const script = `
      set timeout 60
      spawn pnpm exec tsx src/cli/run.ts login --launchpad-url ${idp.launchpadUrl} --session-file ${sessionFile} --profile-dir ${join(dir, "profile")}
      expect -re "Email: " { send "arno@example.com\\r" }
      expect -re "Password: " { send "s3cret\\r" }
      expect -re "code: " { send "123456\\r" }
      expect -re "Logged in"
      expect eof
      catch wait result
      exit [lindex $result 3]
    `;
    const { code, output } = await runInPty(script);
    expect(output, output).toMatch(/Logged in/);
    expect(output).not.toContain("s3cret");
    expect(code).toBe(0);
    expect(existsSync(sessionFile)).toBe(true);
  });
});
