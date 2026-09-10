import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeIdp, type FakeIdp } from "./fixtures/fake-idp.js";
import { SessionManager, type LaunchContext } from "../src/auth/session-manager.js";
import { SessionStore } from "../src/auth/session-store.js";
import { SessionExpiredError } from "../src/sap/client.js";
import type { CredentialProvider } from "../src/auth/sso-login.js";

let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456" });
});
afterAll(() => idp.close());

/** What a person does in the browser window: types email, password and code. "Stay signed in?" is left to the tool. */
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

const creds: CredentialProvider = {
  getEmail: async () => "arno@example.com",
  getPassword: async () => "s3cret",
  getOtp: async () => "123456",
};

/** A launcher that records the requested modes but always runs headless (no windows during tests). */
function recordingLauncher() {
  const modes: boolean[] = [];
  const launch: LaunchContext = async (dir, o) => {
    modes.push(o.headless);
    return chromium.launchPersistentContext(dir, { headless: true });
  };
  return { launch, modes };
}

function fixture(over: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xflow-sm-"));
  const store = new SessionStore(join(dir, "session.json"));
  const launcher = recordingLauncher();
  const status: string[] = [];
  const manager = new SessionManager({
    launchpadUrl: idp.launchpadUrl,
    store,
    profileDir: join(dir, "profile"),
    launchContext: launcher.launch,
    silentTimeoutMs: 5_000,
    interactiveTimeoutMs: 20_000,
    validForMs: 0,
    onStatus: (m) => status.push(m),
    ...over,
  });
  return { dir, store, manager, launcher, status };
}

const since = (mark: number) => idp.requests.slice(mark);

describe("SessionManager.ensureSession", () => {
  afterEach(() => {
    // each test starts from a live identity provider
  });

  it("first run: the profile is empty, so it opens a window for the user, answers 'Stay signed in?' itself and stores the SAP cookies", async () => {
    const f = fixture({ onInteractivePage: (page) => void actLikeTheUser(page) });
    const mark = idp.requests.length;
    const res = await f.manager.ensureSession({ interactive: true });

    expect(res.method).toBe("interactive");
    expect(res.session.cookies.map((c) => c.name).sort()).toEqual(["MYSAPSSO2", "xflow_session"]);
    // only the launchpad host's cookies are exported; the IdP identity stays in the browser profile
    expect(res.session.cookies.some((c) => c.name === "idp_session")).toBe(false);
    expect(await f.store.load()).toEqual(res.session);
    // no identity yet, so no pointless headless attempt: straight to the headed window
    expect(f.launcher.modes).toEqual([false]);
    expect(since(mark)).toContain("POST /idp/kmsi");
    expect(idp.kmsiBodies.at(-1)).toContain("DontShowAgain=true");
    expect(existsSync(join(f.dir, "profile"))).toBe(true);
    // POSIX file modes only; Windows has no 0o700 equivalent.
    if (process.platform !== "win32") expect(statSync(join(f.dir, "profile")).mode & 0o777).toBe(0o700);
    expect(f.status.some((m) => /sign in/i.test(m) && /window/i.test(m))).toBe(true);
  });

  it("the stored identity survives a relaunch: when the SAP session dies, a headless round trip re-issues it without any form", async () => {
    const f = fixture({ onInteractivePage: (page) => void actLikeTheUser(page) });
    await f.manager.ensureSession({ interactive: true });
    const before = (await f.store.load())!.cookies.find((c) => c.name === "xflow_session")!.value;

    idp.expireSapSession();
    const mark = idp.requests.length;
    const res = await f.manager.ensureSession({ interactive: false });

    expect(res.method).toBe("silent");
    expect(f.launcher.modes).toEqual([false, true]);
    const seen = since(mark);
    expect(seen).toContain("GET /idp/login");
    expect(seen.filter((r) => r.startsWith("POST /idp/"))).toEqual([]);
    expect(seen).toContain("POST /sap/callback");
    const after = (await f.store.load())!.cookies.find((c) => c.name === "xflow_session")!.value;
    expect(after).not.toBe(before);
  });

  it("fast path: a session that still answers the probe is used as is, without launching a browser", async () => {
    const f = fixture({ onInteractivePage: (page) => void actLikeTheUser(page) });
    await f.manager.ensureSession({ interactive: true });
    const launches = f.launcher.modes.length;
    const mark = idp.requests.length;

    const res = await f.manager.ensureSession();
    expect(res.method).toBe("cached");
    expect(f.launcher.modes).toHaveLength(launches);
    expect(since(mark)).toEqual(["GET /sap/bc/ui2/start_up"]);
  });

  it("remembers a successful probe for validForMs and does not probe again within that window", async () => {
    const f = fixture({ onInteractivePage: (page) => void actLikeTheUser(page), validForMs: 60_000 });
    await f.manager.ensureSession({ interactive: true });
    const mark = idp.requests.length;
    await f.manager.ensureSession();
    await f.manager.ensureSession();
    expect(since(mark)).toEqual([]);
    f.manager.invalidate();
    await f.manager.ensureSession();
    expect(since(mark)).toEqual(["GET /sap/bc/ui2/start_up"]);
  });

  it("with no remembered identity and no window allowed, it fails immediately without launching a browser at all", async () => {
    const f = fixture();
    await expect(f.manager.ensureSession({ interactive: false })).rejects.toThrow(SessionExpiredError);
    expect(f.launcher.modes).toEqual([]);
  });

  it("when the IdP no longer knows the user and no window may be opened, it fails with a SessionExpiredError that names the way out", async () => {
    const f = fixture({ onInteractivePage: (page) => void actLikeTheUser(page) });
    await f.manager.ensureSession({ interactive: true });
    idp.expireSapSession();
    idp.expireIdpSession();
    const mark = idp.requests.length;

    await expect(f.manager.ensureSession({ interactive: false })).rejects.toThrow(SessionExpiredError);
    await expect(f.manager.ensureSession({ interactive: false })).rejects.toThrow(/sso/i);
    // each silent attempt gave up as soon as the sign-in form showed (no 5s wait) and posted nothing
    expect(since(mark).filter((r) => r.startsWith("POST /idp/"))).toEqual([]);
    expect(f.launcher.modes).toEqual([false, true, true]);
  });

  it("credentials (compatibility mode) drive the form headlessly when the IdP asks again, and the identity is persisted for later silent runs", async () => {
    const f = fixture();
    const mark = idp.requests.length;
    const res = await f.manager.ensureSession({ credentials: creds });
    expect(res.method).toBe("credentials");
    expect(f.launcher.modes).toEqual([true]);
    expect(since(mark)).toContain("POST /idp/password");

    idp.expireSapSession();
    const mark2 = idp.requests.length;
    const again = await f.manager.ensureSession();
    expect(again.method).toBe("silent");
    expect(since(mark2).filter((r) => r.startsWith("POST /idp/"))).toEqual([]);
  });

  it("forgetIdentity removes the profile and the session, so the next run needs a sign-in again", async () => {
    const f = fixture({ onInteractivePage: (page) => void actLikeTheUser(page) });
    await f.manager.ensureSession({ interactive: true });
    await f.manager.forgetIdentity();
    expect(existsSync(join(f.dir, "profile"))).toBe(false);
    expect(await f.store.load()).toBeNull();
    await expect(f.manager.ensureSession({ interactive: false })).rejects.toThrow(SessionExpiredError);
  });

  it("runs concurrent callers as a single flight over the profile", async () => {
    const f = fixture({ onInteractivePage: (page) => void actLikeTheUser(page) });
    const [a, b, c] = await Promise.all([f.manager.ensureSession({ interactive: true }), f.manager.ensureSession({ interactive: true }), f.manager.ensureSession({ interactive: true })]);
    expect(a.method).toBe("interactive");
    expect(b.session).toEqual(a.session);
    expect(c.session).toEqual(a.session);
    expect(f.launcher.modes).toEqual([false]);
  });

  it("reports a profile that is already open elsewhere instead of hanging (default launcher)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-sm-"));
    const profileDir = join(dir, "profile");
    const store = new SessionStore(join(dir, "session.json"));
    let other: BrowserContext | null = await chromium.launchPersistentContext(profileDir, { headless: true, channel: "chromium" });
    try {
      const manager = new SessionManager({ launchpadUrl: idp.launchpadUrl, store, profileDir, validForMs: 0, silentTimeoutMs: 5_000 });
      // The point is that a locked profile throws instead of hanging. On POSIX Chromium reports a
      // ProcessSingleton "already in use" error (mapped to ProfileLockedError); on Windows the
      // second launch delegates to the running instance and exits, surfacing as "browser has been
      // closed" — different text, still a throw, no hang.
      if (process.platform === "win32") await expect(manager.ensureSession()).rejects.toThrow();
      else await expect(manager.ensureSession()).rejects.toThrow(/already in use|another/i);
    } finally {
      await other.close();
      other = null;
    }
  });

  it("uses a custom probe when given", async () => {
    const probe = vi.fn(async () => true);
    const f = fixture({ probe });
    await f.store.save({ launchpadUrl: idp.launchpadUrl, createdAt: "2026-01-01T00:00:00.000Z", cookies: [{ name: "xflow_session", value: "stale", domain: "127.0.0.1", path: "/" }] });
    const res = await f.manager.ensureSession();
    expect(res.method).toBe("cached");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(f.launcher.modes).toEqual([]);
  });
});
