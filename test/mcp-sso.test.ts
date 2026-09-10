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
    sessionOptions: {
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
    const r = await call("session_status");
    expect(r.json()).toMatchObject({ loggedIn: false });
    expect(r.text).toMatch(/sso_login/);
    expect(modes.slice(launches)).toEqual([true]);

    const s = await call("sso_login");
    expect(s.res.isError, s.text).toBeFalsy();
    expect(s.json()).toMatchObject({ state: "done", method: "interactive" });
    expect(modes.slice(launches)).toEqual([true, true, false]);
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
