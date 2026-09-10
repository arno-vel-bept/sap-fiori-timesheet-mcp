import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFakeIdp, type FakeIdp } from "./fixtures/fake-idp.js";
import { ssoLogin, LoginError, type CredentialProvider } from "../src/auth/sso-login.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

const creds = (over: Partial<CredentialProvider> = {}): CredentialProvider => ({
  getEmail: vi.fn(async () => "arno@example.com"),
  getPassword: vi.fn(async () => "s3cret"),
  getOtp: vi.fn(async () => "123456"),
  onNumberMatch: vi.fn(async () => {}),
  onStatus: vi.fn(),
  ...over,
});

describe("ssoLogin against a fake Entra ID", () => {
  let idp: FakeIdp;
  beforeAll(async () => {
    idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456" });
  });
  afterAll(() => idp.close());

  it("walks email -> password -> otp -> stay-signed-in and returns launchpad cookies", async () => {
    const c = creds();
    const session = await ssoLogin(c, { launchpadUrl: idp.launchpadUrl, browser });

    const names = session.cookies.map((k) => k.name).sort();
    expect(names).toEqual(["MYSAPSSO2", "xflow_session"]);
    expect(session.launchpadUrl).toBe(idp.launchpadUrl);
    expect(session.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(c.getEmail).toHaveBeenCalledTimes(1);
    expect(c.getPassword).toHaveBeenCalledTimes(1);
    expect(c.getOtp).toHaveBeenCalledTimes(1);
    expect(idp.requests).toContain("POST /idp/kmsi");
  });

  it("re-prompts for the OTP when the first code is rejected", async () => {
    const getOtp = vi.fn().mockResolvedValueOnce("000000").mockResolvedValueOnce("123456");
    const c = creds({ getOtp });
    const session = await ssoLogin(c, { launchpadUrl: idp.launchpadUrl, browser });
    expect(getOtp).toHaveBeenCalledTimes(2);
    expect(getOtp.mock.calls[1][0]).toMatch(/didn't enter the expected verification code/i);
    expect(session.cookies.some((k) => k.name === "xflow_session")).toBe(true);
  });

  it("fails with a bad_password LoginError when the password is rejected", async () => {
    const c = creds({ getPassword: vi.fn(async () => "wrong") });
    await expect(ssoLogin(c, { launchpadUrl: idp.launchpadUrl, browser })).rejects.toMatchObject({
      name: "LoginError",
      code: "bad_password",
    } satisfies Partial<LoginError>);
  });

  it("fails with a bad_email LoginError when the account is unknown", async () => {
    const c = creds({ getEmail: vi.fn(async () => "nobody@example.com") });
    await expect(ssoLogin(c, { launchpadUrl: idp.launchpadUrl, browser })).rejects.toMatchObject({
      code: "bad_email",
    });
  });

  it("does not prompt at all when existing cookies already grant access", async () => {
    const c = creds();
    const session = await ssoLogin(c, {
      launchpadUrl: idp.launchpadUrl,
      browser,
      cookies: [{ name: "xflow_session", value: "ok", domain: "127.0.0.1", path: "/" }],
    });
    expect(c.getEmail).not.toHaveBeenCalled();
    expect(c.getPassword).not.toHaveBeenCalled();
    expect(session.cookies.some((k) => k.name === "xflow_session")).toBe(true);
  });
});

describe("ssoLogin with Authenticator number matching", () => {
  let idp: FakeIdp;
  beforeAll(async () => {
    idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "n/a", numberMatch: 42 });
  });
  afterAll(() => idp.close());

  it("reports the number to match and waits for approval instead of asking for a code", async () => {
    const c = creds();
    const session = await ssoLogin(c, { launchpadUrl: idp.launchpadUrl, browser });
    expect(c.onNumberMatch).toHaveBeenCalledWith("42");
    expect(c.getOtp).not.toHaveBeenCalled();
    expect(session.cookies.some((k) => k.name === "xflow_session")).toBe(true);
  });
});

describe("ssoLogin diagnostics", () => {
  it("fails with unsupported_page on the 'More information required' interstitial and dumps the page to debugDir", async () => {
    const { mkdtempSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456", proofUp: true });
    try {
      const dir = mkdtempSync(join(tmpdir(), "xflow-debug-"));
      await expect(ssoLogin(creds(), { launchpadUrl: idp.launchpadUrl, browser, debugDir: dir })).rejects.toMatchObject({
        code: "unsupported_page",
        message: expect.stringMatching(/more information/i),
      });
      const files = readdirSync(dir);
      expect(files.some((f) => f.endsWith(".png"))).toBe(true);
      expect(files.some((f) => f.endsWith(".html"))).toBe(true);
    } finally {
      await idp.close();
    }
  });
});

describe("ssoLogin on pages it does not know", () => {
  it("reports the unrecognized page, dumps it to debugDir, and carries on once the page moves", async () => {
    const { mkdtempSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456", unknownInterstitialMs: 3500 });
    try {
      const dir = mkdtempSync(join(tmpdir(), "xflow-debug-"));
      const c = creds();
      const session = await ssoLogin(c, { launchpadUrl: idp.launchpadUrl, browser, debugDir: dir, unknownPageAfterMs: 1000 });
      expect(session.cookies.some((k) => k.name === "xflow_session")).toBe(true);
      const statuses = (c.onStatus as ReturnType<typeof vi.fn>).mock.calls.map((a) => String(a[0]));
      expect(statuses.some((m) => /unrecognized page/i.test(m) && /Please wait/.test(m))).toBe(true);
      expect(readdirSync(dir).some((f) => f.endsWith(".html"))).toBe(true);
    } finally {
      await idp.close();
    }
  });
});

describe("ssoLogin with the 'Verify your identity' method chooser", () => {
  it("picks the verification-code method and continues", async () => {
    const idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456", methodChooser: true });
    try {
      const c = creds();
      const session = await ssoLogin(c, { launchpadUrl: idp.launchpadUrl, browser });
      expect(c.getOtp).toHaveBeenCalledTimes(1);
      expect(session.cookies.some((k) => k.name === "xflow_session")).toBe(true);
    } finally {
      await idp.close();
    }
  });
});

describe("ssoLogin through an ADFS-style federated form", () => {
  it("fills #passwordInput and clicks #submitButton", async () => {
    const idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456", adfs: true });
    try {
      const c = creds();
      const session = await ssoLogin(c, { launchpadUrl: idp.launchpadUrl, browser });
      expect(c.getPassword).toHaveBeenCalledTimes(1);
      expect(session.cookies.some((k) => k.name === "xflow_session")).toBe(true);
    } finally {
      await idp.close();
    }
  });

  it("maps #errorText to bad_password", async () => {
    const idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456", adfs: true });
    try {
      await expect(
        ssoLogin(creds({ getPassword: vi.fn(async () => "wrong") }), { launchpadUrl: idp.launchpadUrl, browser }),
      ).rejects.toMatchObject({ code: "bad_password", message: expect.stringMatching(/incorrect/i) });
    } finally {
      await idp.close();
    }
  });
});

describe("ssoLogin cancellation", () => {
  it("stops with code 'cancelled' and dumps the page when the AbortSignal fires", async () => {
    const { mkdtempSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456", unknownInterstitialMs: 60_000 });
    try {
      const dir = mkdtempSync(join(tmpdir(), "xflow-debug-"));
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 1500);
      await expect(
        ssoLogin(creds(), { launchpadUrl: idp.launchpadUrl, browser, debugDir: dir, signal: ac.signal }),
      ).rejects.toMatchObject({ code: "cancelled" });
      expect(readdirSync(dir).some((f) => f.endsWith(".png"))).toBe(true);
    } finally {
      await idp.close();
    }
  });
});

describe("ssoLogin inside a persistent browser profile", () => {
  it("keeps the identity provider's cookie in the profile, so a later run needs no credentials at all", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456" });
    try {
      const profileDir = join(mkdtempSync(join(tmpdir(), "xflow-profile-")), "profile");
      const first = creds();
      const session = await ssoLogin(first, { launchpadUrl: idp.launchpadUrl, profileDir });
      expect(first.getOtp).toHaveBeenCalledTimes(1);
      expect(session.cookies.map((k) => k.name).sort()).toEqual(["MYSAPSSO2", "xflow_session"]);

      idp.expireSapSession();
      const mark = idp.requests.length;
      const second = creds();
      const again = await ssoLogin(second, { launchpadUrl: idp.launchpadUrl, profileDir });
      expect(second.getEmail).not.toHaveBeenCalled();
      expect(second.getPassword).not.toHaveBeenCalled();
      expect(second.getOtp).not.toHaveBeenCalled();
      expect(idp.requests.slice(mark).filter((r) => r.startsWith("POST /idp/"))).toEqual([]);
      expect(again.cookies.find((k) => k.name === "xflow_session")?.value).not.toBe(session.cookies.find((k) => k.name === "xflow_session")?.value);
    } finally {
      await idp.close();
    }
  });
});
