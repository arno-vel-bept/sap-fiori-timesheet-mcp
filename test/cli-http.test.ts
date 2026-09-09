import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startFakeSap, type FakeSap } from "./fixtures/fake-sap.js";
import { runCli } from "../src/cli/main.js";
import { SessionStore } from "../src/auth/session-store.js";

let sap: FakeSap;
let env: Record<string, string>;
beforeAll(async () => {
  sap = await startFakeSap();
  const dir = mkdtempSync(join(tmpdir(), "xflow-cli-http-"));
  env = { XFLOW_LAUNCHPAD_URL: `${sap.baseUrl}/fiori/shells/abap/FioriLaunchpad.html#Shell-home`, XFLOW_SESSION_FILE: join(dir, "s.json") };
  await new SessionStore(env.XFLOW_SESSION_FILE).save({
    launchpadUrl: env.XFLOW_LAUNCHPAD_URL,
    createdAt: new Date().toISOString(),
    cookies: [{ name: "SAP_SESSIONID_X", value: "ok", domain: "127.0.0.1", path: "/", httpOnly: true }],
  });
});
afterAll(() => sap.close());

function io() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c.toString()));
  stderr.on("data", (c) => (err += c.toString()));
  return { stdin: new PassThrough(), stdout, stderr, out: () => out, err: () => err };
}

describe("whoami", () => {
  it("prints the SAP user resolved through the stored session", async () => {
    const t = io();
    expect(await runCli(["whoami"], { env, ...t })).toBe(0);
    expect(t.out()).toContain("AEXAMPLE");
    expect(t.out()).toContain("006");
  });

  it("explains when the session has expired (exit 3)", async () => {
    sap.expired = true;
    try {
      const t = io();
      expect(await runCli(["whoami"], { env, ...t })).toBe(3);
      expect(t.err()).toMatch(/expired|login/i);
    } finally {
      sap.expired = false;
    }
  });
});

describe("http get (raw access for exploration)", () => {
  it("prints JSON responses pretty-printed", async () => {
    const t = io();
    expect(await runCli(["http", "get", "/sap/opu/odata/sap/SVC/Entries"], { env, ...t })).toBe(0);
    expect(JSON.parse(t.out())).toEqual({ d: { results: [{ Id: "1" }] } });
  });

  it("prints non-JSON responses verbatim", async () => {
    const t = io();
    expect(await runCli(["http", "get", "/sap/opu/odata/sap/SVC/$metadata"], { env, ...t })).toBe(0);
    expect(t.out()).toContain("<edmx:Edmx/>");
  });

  it("supports --json output for machine consumption of errors", async () => {
    const t = io();
    expect(await runCli(["http", "get", "/sap/opu/odata/sap/BROKEN/Err"], { env, ...t })).toBe(4);
    expect(t.err()).toMatch(/Something is wrong/);
  });
});
