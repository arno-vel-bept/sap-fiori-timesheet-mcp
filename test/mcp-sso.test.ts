import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Page } from "playwright";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startFakeIdp, type FakeIdp } from "./fixtures/fake-idp.js";
import { SessionStore } from "../src/auth/session-store.js";
import { createMcpServer } from "../src/mcp/server.js";

let idp: FakeIdp;
let client: Client;
let sessionFile: string;
let profileDir: string;
const modes: boolean[] = [];
const logLines: string[] = [];

async function actLikeTheUser(page: Page) {
  await page.locator('input[name="loginfmt"]').fill("arno@example.com");
  await page.locator("#idSIButton9").click();
  await page.waitForURL(/\/idp\/email/);
  await page.locator('input[name="passwd"]').fill("s3cret");
  await page.locator("#idSIButton9").click();
  await page.waitForURL(/\/idp\/password/);
  await page.locator('input[name="otc"]').fill("123456");
  await page.locator("#idSubmit_SAOTCC_Continue").click();
}

beforeAll(async () => {
  idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456" });
  const dir = mkdtempSync(join(tmpdir(), "xflow-mcp-sso-"));
  sessionFile = join(dir, "session.json");
  profileDir = join(dir, "profile");
  const server = createMcpServer({
    env: { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: sessionFile, XFLOW_PROFILE_DIR: profileDir },
    log: (line) => logLines.push(line),
    sessionOptions: {
      probeRetryMs: 20,
      launchContext: async (d, o) => {
        modes.push(o.headless);
        return chromium.launchPersistentContext(d, { headless: true });
      },
      onInteractivePage: (page) => void actLikeTheUser(page),
      silentTimeoutMs: 5_000,
      interactiveTimeoutMs: 20_000,
      validForMs: 0,
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});
afterAll(async () => {
  await client.close();
  await idp.close();
});

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return { res, text, json: () => JSON.parse(text) };
}

describe("MCP silent SSO through the persistent browser profile", () => {
  it("session_status without any session says so and points at sso_login, without opening a window", async () => {
    const r = await call("session_status");
    expect(r.res.isError).toBeFalsy();
    expect(r.json()).toMatchObject({ loggedIn: false, identityRemembered: false });
    expect(r.text).toMatch(/sso_login/);
    expect(modes.filter((m) => m === false)).toEqual([]);
  });

  it("sso_login signs in through a window the first time (the tool answers 'Stay signed in?' itself)", async () => {
    const launches = modes.length;
    const r = await call("sso_login");
    expect(r.res.isError, r.text).toBeFalsy();
    expect(r.json()).toMatchObject({ state: "done", method: "interactive", cookies: 2 });
    expect(modes.slice(launches)).toEqual([false]);
    expect(idp.kmsiBodies.at(-1)).toContain("DontShowAgain=true");
    expect(existsSync(profileDir)).toBe(true);
    expect(await new SessionStore(sessionFile).load()).not.toBeNull();
  });

  it("session_status reports the remembered identity", async () => {
    const r = await call("session_status");
    expect(r.json()).toMatchObject({ loggedIn: true, identityRemembered: true, user: { id: "8765432" } });
  });

  it("when the SAP session dies, a tool call renews it silently (headless, no form) before doing its work", async () => {
    idp.expireSapSession();
    const mark = idp.requests.length;
    const launches = modes.length;
    const r = await call("session_status");
    expect(r.json()).toMatchObject({ loggedIn: true, user: { id: "8765432" } });
    expect(modes.slice(launches)).toEqual([true]);
    expect(idp.requests.slice(mark).filter((x) => x.startsWith("POST /idp/"))).toEqual([]);
  });

  it("sso_login on a live session is a no-op reporting 'cached'", async () => {
    const r = await call("sso_login");
    expect(r.json()).toMatchObject({ state: "done", method: "cached" });
  });

  it("when the identity provider forgot the browser, ordinary tools fail with a hint instead of opening a window; sso_login opens it", async () => {
    idp.expireSapSession();
    idp.expireIdpSession();
    const launches = modes.length;
    logLines.length = 0;
    const r = await call("session_status");
    expect(r.json()).toMatchObject({ loggedIn: false, diagnostics: { kind: "needs_sign_in", silent: { reason: "login_ui" } } });
    expect(r.text).toMatch(/sso_login/);
    expect(modes.slice(launches)).toEqual([true]);
    // the same story reaches the host's log (stderr), so a bug report can quote it
    expect(logLines.some((l) => /auth: .*sign-in form/i.test(l))).toBe(true);
    expect(logLines.some((l) => /session_status: not logged in \(needs_sign_in\) .*needs a fresh sign-in/.test(l))).toBe(true);
    expect(logLines.some((l) => /^tool session_status ok \(\d+ms\)$/.test(l))).toBe(true);

    const d = await call("std_info");
    expect(d.res.isError).toBe(true);
    expect(d.text).toMatch(/needs a fresh sign-in/);
    expect(d.text).toMatch(/Diagnostics: \{/);
    expect(JSON.parse(d.text.split("Diagnostics: ")[1])).toMatchObject({ kind: "needs_sign_in" });

    const s = await call("sso_login");
    expect(s.res.isError, s.text).toBeFalsy();
    expect(s.json()).toMatchObject({ state: "done", method: "interactive" });
    // session_status and std_info each made one headless attempt; sso_login made one more, then opened the window
    expect(modes.slice(launches)).toEqual([true, true, true, false]);
  });

  it("login_start (credentials) also runs inside the profile, so the identity is remembered afterwards", async () => {
    idp.expireSapSession();
    idp.expireIdpSession();
    const r = await call("login_start", { email: "arno@example.com", password: "s3cret" });
    expect(r.json()).toMatchObject({ state: "otp_required" });
    const done = await call("login_submit_otp", { code: "123456" });
    expect(done.json()).toMatchObject({ state: "done" });

    idp.expireSapSession();
    const mark = idp.requests.length;
    const s = await call("sso_login");
    expect(s.json()).toMatchObject({ state: "done", method: "silent" });
    expect(idp.requests.slice(mark).filter((x) => x.startsWith("POST /idp/"))).toEqual([]);
  });

  it("issue #5: when the launchpad is reached but the OData tier rejects the cookies, session_status and the tools report the probe response instead of a bare 'do not authenticate'", async () => {
    idp.expireSapSession();
    idp.rejectOData(true);
    logLines.length = 0;
    try {
      const r = await call("session_status");
      const j = r.json();
      expect(j).toMatchObject({ loggedIn: false, diagnostics: { kind: "cookies_rejected", attempts: 4, probe: { status: 401 }, browser: { status: 401 } } });
      expect(j.reason).toMatch(/401 Unauthorized/);
      expect(j.reason).toMatch(/cookies exported: MYSAPSSO2, xflow_session/);
      expect(logLines.some((l) => /auth: .*401 Unauthorized/.test(l))).toBe(true);

      const d = await call("std_info");
      expect(d.res.isError).toBe(true);
      expect(d.text).toMatch(/401 Unauthorized/);
      expect(d.text).toMatch(/WWW-Authenticate/);
      // a rejected export is not retried blindly (the retry would just repeat the whole browser round trip)
      expect(logLines.filter((l) => /^tool std_info /.test(l))).toHaveLength(1);
    } finally {
      idp.rejectOData(false);
    }
    // back to normal: the next call renews silently
    const ok = await call("session_status");
    expect(ok.json()).toMatchObject({ loggedIn: true, cookies: ["MYSAPSSO2", "xflow_session"] });
  });

  it("logout keeps the identity unless asked to forget it", async () => {
    const r = await call("logout");
    expect(r.json()).toMatchObject({ loggedOut: true, identityForgotten: false });
    expect(existsSync(profileDir)).toBe(true);
    const s = await call("sso_login");
    expect(s.json()).toMatchObject({ state: "done", method: "silent" });

    const f = await call("logout", { forgetIdentity: true });
    expect(f.json()).toMatchObject({ loggedOut: true, identityForgotten: true });
    expect(existsSync(profileDir)).toBe(false);
    expect((await call("session_status")).json()).toMatchObject({ loggedIn: false, identityRemembered: false });
  });
});
