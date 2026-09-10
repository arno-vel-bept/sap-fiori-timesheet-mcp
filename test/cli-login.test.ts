import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startFakeIdp, type FakeIdp } from "./fixtures/fake-idp.js";
import { runCli } from "../src/cli/main.js";
import { SessionStore } from "../src/auth/session-store.js";

let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456" });
});
afterAll(() => idp.close());

function io(answers: string[]) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c.toString()));
  stderr.on("data", (c) => {
    err += c.toString();
    const next = answers.shift();
    if (next !== undefined) setImmediate(() => stdin.write(next + "\n"));
  });
  return { stdin, stdout, stderr, out: () => out, err: () => err };
}

describe("xflow-timesheet login (CLI)", () => {
  it("logs in with credentials from env and stores the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-cli-"));
    const sessionFile = join(dir, "session.json");
    const t = io(["123456"]); // only the OTP is prompted
    const code = await runCli(["login"], {
      env: { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: sessionFile, XFLOW_PROFILE_DIR: join(dir, "profile"), XFLOW_EMAIL: "arno@example.com", XFLOW_PASSWORD: "s3cret" },
      ...t,
    });
    expect(code).toBe(0);
    const saved = await new SessionStore(sessionFile).load();
    expect(saved?.cookies.map((c) => c.name).sort()).toEqual(["MYSAPSSO2", "xflow_session"]);
    expect(t.out()).toMatch(/logged in/i);
    expect(t.err()).toMatch(/code/i);
  });

  it("prompts for email and password when not provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-cli-"));
    const t = io(["arno@example.com", "s3cret", "123456"]);
    const code = await runCli(["login"], {
      env: { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: join(dir, "s.json"), XFLOW_PROFILE_DIR: join(dir, "profile") },
      ...t,
    });
    expect(code).toBe(0);
    expect(t.err()).not.toContain("s3cret");
  });

  it("reports session status and logs out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-cli-"));
    const env = { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: join(dir, "s.json"), XFLOW_PROFILE_DIR: join(dir, "profile") };
    let t = io([]);
    expect(await runCli(["session", "status"], { env, ...t })).toBe(1);
    expect(t.out()).toMatch(/no session/i);

    t = io([]);
    await runCli(["login", "--email", "arno@example.com", "--password", "s3cret", "--otp", "123456"], { env, ...t });
    t = io([]);
    expect(await runCli(["session", "status"], { env, ...t })).toBe(0);
    expect(t.out()).toMatch(/xflow_session/);

    t = io([]);
    expect(await runCli(["logout"], { env, ...t })).toBe(0);
    t = io([]);
    expect(await runCli(["session", "status"], { env, ...t })).toBe(1);
  });

  it("accepts short flags -e / -p / -o", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-cli-"));
    const t = io([]);
    const code = await runCli(["login", "-e", "arno@example.com", "-p", "s3cret", "-o", "123456"], {
      env: { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: join(dir, "s.json"), XFLOW_PROFILE_DIR: join(dir, "profile") },
      ...t,
    });
    expect(code).toBe(0);
    expect(t.out()).toMatch(/logged in/i);
  });

  it("exits non-zero with the IdP message on a wrong password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-cli-"));
    const t = io([]);
    const code = await runCli(["login", "--email", "arno@example.com", "--password", "bad"], {
      env: { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: join(dir, "s.json"), XFLOW_PROFILE_DIR: join(dir, "profile") },
      ...t,
    });
    expect(code).toBe(2);
    expect(t.err()).toMatch(/incorrect/i);
  });
});

describe("xflow-timesheet sso (persistent browser profile)", () => {
  it("renews the session silently from a remembered identity, and whoami renews it on its own too", async () => {
    const { ssoLogin } = await import("../src/auth/sso-login.js");
    const dir = mkdtempSync(join(tmpdir(), "xflow-cli-sso-"));
    const profileDir = join(dir, "profile");
    const env = { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: join(dir, "s.json"), XFLOW_PROFILE_DIR: profileDir };
    // remember the identity once (credential login into the profile), then let the SAP session die
    await ssoLogin({ getEmail: async () => "arno@example.com", getPassword: async () => "s3cret", getOtp: async () => "123456" }, { launchpadUrl: idp.launchpadUrl, profileDir });
    idp.expireSapSession();

    let t = io([]);
    const mark = idp.requests.length;
    expect(await runCli(["sso", "--no-interactive"], { env, ...t })).toBe(0);
    expect(t.out()).toMatch(/silent/i);
    expect(idp.requests.slice(mark).filter((r) => r.startsWith("POST /idp/"))).toEqual([]);

    idp.expireSapSession();
    t = io([]);
    expect(await runCli(["whoami"], { env, ...t })).toBe(0);
    expect(t.out()).toMatch(/User\s+8765432/);
    expect(t.err()).toMatch(/renewed/i);

    t = io([]);
    expect(await runCli(["session", "status"], { env, ...t })).toBe(0);
    expect(t.out()).toMatch(/identity.*remembered/i);
  });

  it("fails with exit code 3 and a hint when the identity is not remembered and no window may open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-cli-sso-"));
    const env = { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: join(dir, "s.json"), XFLOW_PROFILE_DIR: join(dir, "profile") };
    const t = io([]);
    expect(await runCli(["sso", "--no-interactive"], { env, ...t })).toBe(3);
    expect(t.err()).toMatch(/xflow-timesheet sso/);
  });

  it("logout --forget-identity removes the browser profile as well", async () => {
    const { ssoLogin } = await import("../src/auth/sso-login.js");
    const { existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "xflow-cli-sso-"));
    const profileDir = join(dir, "profile");
    const env = { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: join(dir, "s.json"), XFLOW_PROFILE_DIR: profileDir };
    await ssoLogin({ getEmail: async () => "arno@example.com", getPassword: async () => "s3cret", getOtp: async () => "123456" }, { launchpadUrl: idp.launchpadUrl, profileDir });
    expect(existsSync(profileDir)).toBe(true);
    let t = io([]);
    expect(await runCli(["logout"], { env, ...t })).toBe(0);
    expect(existsSync(profileDir)).toBe(true);
    t = io([]);
    expect(await runCli(["logout", "--forget-identity"], { env, ...t })).toBe(0);
    expect(existsSync(profileDir)).toBe(false);
    expect(t.out()).toMatch(/identity/i);
  });
});
