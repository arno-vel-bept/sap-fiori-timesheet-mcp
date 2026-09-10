import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { SessionCookie, SessionData } from "./session-store.js";
import { launchPersistentProfile, withBrowserInstalled } from "./browser.js";

/**
 * The endpoint a harvested session is validated and warmed against. It must be a tier the data
 * tools actually use: `/sap/bc/ui2/start_up` authenticates off the long-lived SSO2 ticket alone, so
 * it accepts a session that every `/sap/opu/odata/*` service still rejects — which is exactly how a
 * silent refresh could report success while every data call failed with "session expired".
 */
export const SAP_PROBE_PATH = "/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/";

/**
 * Supplies credentials on demand while the Microsoft Entra ID handshake runs.
 * Nothing is asked for up-front: the email is only requested when the email
 * page is shown, the password when the password page is shown, and so on.
 */
export interface CredentialProvider {
  getEmail(): Promise<string>;
  getPassword(): Promise<string>;
  /** Called when Entra asks for a one-time code. `prompt` carries the on-screen text (and the previous error, if any). */
  getOtp(prompt: string): Promise<string>;
  /** Called when Entra shows a "number matching" screen; the user must approve in the Authenticator app. */
  onNumberMatch?(number: string): Promise<void> | void;
  onStatus?(message: string): void;
}

export type LoginErrorCode =
  | "bad_email"
  | "bad_password"
  | "otp_rejected"
  | "timeout"
  | "unsupported_page"
  | "cancelled";

export class LoginError extends Error {
  override readonly name = "LoginError";
  constructor(
    readonly code: LoginErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SsoLoginOptions {
  /** Full launchpad URL, e.g. https://xflow.bearingpoint.com/fiori/shells/abap/FioriLaunchpad.html#Shell-home */
  launchpadUrl: string;
  /** Reuse an existing browser (tests); otherwise one is launched. */
  browser?: Browser;
  headless?: boolean;
  /**
   * Run the handshake inside this persistent browser profile instead of a throw-away context, so the
   * identity provider's own session cookie is kept for later silent sign-ins (see SessionManager).
   * Takes precedence over `browser`.
   */
  profileDir?: string;
  /** Browser channel for `profileDir` launches ("chromium" default, or "chrome"). */
  channel?: string;
  /** Cookies to seed the browser with (e.g. a previous session) so the IdP may be skipped. */
  cookies?: SessionCookie[];
  /** Overall deadline for the handshake (default 4 minutes; 2FA approval can be slow). */
  timeoutMs?: number;
  /** Poll interval in ms (default 250). */
  pollMs?: number;
  /** When set, a screenshot + HTML of the current page are written here if the handshake fails or stalls. */
  debugDir?: string;
  /** How long an unrecognized page may show before it is reported (and dumped to debugDir). Default 3000. */
  unknownPageAfterMs?: number;
  /** Abort the handshake (e.g. on Ctrl-C); the page is dumped to debugDir first. */
  signal?: AbortSignal;
}

// Selectors of the Microsoft Entra ID (login.microsoftonline.com) login experience.
const SEL = {
  email: 'input[name="loginfmt"]',
  password: 'input[name="passwd"]',
  otp: 'input[name="otc"]',
  primaryButton: "#idSIButton9",
  otpSubmit: "#idSubmit_SAOTCC_Continue",
  usernameError: "#usernameError",
  passwordError: "#passwordError",
  otpError: "#idSpan_SAOTCC_Error_OTC",
  numberMatch: "#idRichContext_DisplaySign",
  otherAccountTile: "#otherTileText",
  proofUp: "#idSubmit_ProofUp_Redirect",
  /** "Verify your identity" method chooser and its tiles */
  proofs: "#idDiv_SAOTCS_Proofs",
  proofOtpTile: '#idDiv_SAOTCS_Proofs [data-value="PhoneAppOTP"]',
  proofNotificationTile: '#idDiv_SAOTCS_Proofs [data-value="PhoneAppNotification"]',
  proofAnyTile: "#idDiv_SAOTCS_Proofs [data-value]",
  /** "Use your password instead" link shown by passwordless-first tenants */
  switchToPassword: "#idA_PWD_SwitchToPassword",
  /** ADFS-style federated sign-in form */
  adfsPassword: "#passwordInput",
  adfsSubmit: "#submitButton",
  adfsError: "#errorText",
  /** "Stay signed in?" / "Rester connecté ?" — detected by its checkbox, which is language independent. */
  kmsi: "#KmsiCheckboxField",
} as const;

const LOGIN_UI = [
  SEL.email,
  SEL.password,
  SEL.otp,
  SEL.numberMatch,
  SEL.kmsi,
  SEL.otherAccountTile,
  SEL.proofUp,
  SEL.proofs,
  SEL.switchToPassword,
  SEL.adfsPassword,
  SEL.usernameError,
  SEL.passwordError,
];

const anyVisible = async (page: Page, selectors: readonly string[]) => {
  for (const s of selectors) if (await visible(page, s)) return true;
  return false;
};

const visible = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);

const text = async (page: Page, selector: string) =>
  (await page.locator(selector).first().textContent().catch(() => ""))?.trim() ?? "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives a (headless) Chromium through the SSO handshake until the Fiori
 * launchpad is reached, then returns the cookies scoped to the launchpad host.
 */
export async function ssoLogin(creds: CredentialProvider, opts: SsoLoginOptions): Promise<SessionData> {
  const status = (m: string) => creds.onStatus?.(m);
  const headless = opts.headless ?? true;
  let browser: Browser | null = null;
  let ownsBrowser = false;
  let context: BrowserContext;
  if (opts.profileDir) {
    context = await launchPersistentProfile(opts.profileDir, { headless, channel: opts.channel, onStatus: status });
  } else {
    browser = opts.browser ?? (await withBrowserInstalled(() => chromium.launch({ headless }), { onStatus: status }));
    ownsBrowser = !opts.browser;
    context = await browser.newContext();
  }
  try {
    if (opts.cookies?.length) await context.addCookies(opts.cookies.map(toPlaywrightCookie));
    const page = await context.newPage();
    status(`Opening ${opts.launchpadUrl}`);
    await page.goto(opts.launchpadUrl, { waitUntil: "domcontentloaded" });
    try {
      await runHandshake(page, creds, opts);
    } catch (err) {
      if (opts.debugDir) await dumpPage(page, opts.debugDir, status);
      if (err instanceof LoginError) throw err;
      const msg = (err as Error)?.message ?? String(err);
      if (/has been closed/i.test(msg)) throw new LoginError("cancelled", "The browser window was closed before the login completed.");
      throw new LoginError("unsupported_page", `Unexpected error during SSO login: ${msg}`);
    }
    status("Launchpad reached, collecting session cookies");
    return await harvestSession(page, opts.launchpadUrl, { warmUpPath: SAP_PROBE_PATH });
  } finally {
    await context.close().catch(() => {});
    if (ownsBrowser && browser) await browser.close().catch(() => {});
  }
}

/**
 * Once `page` sits on the launchpad: waits for late cookies (e.g. sap-usercontext) and returns the
 * cookies scoped to the launchpad host as a SessionData. Cookies of other hosts (the identity
 * provider's) are deliberately left out — they belong in the browser profile, not on disk.
 *
 * `warmUpPath` (a same-origin backend path) is fetched from the page first: `waitForLaunchpad()`
 * can return before the Fiori shell has hit the backend, so SAP has not yet promoted the freshly
 * issued security session into a full application session and the OData cookies are not in the jar
 * yet. Driving one real request finishes that promotion before the cookies are read.
 */
export async function harvestSession(page: Page, launchpadUrl: string, opts: { warmUpPath?: string } = {}): Promise<SessionData> {
  await page.waitForLoadState("load").catch(() => {});
  if (opts.warmUpPath !== undefined) await warmUpBackend(page, launchpadUrl, opts.warmUpPath);
  const host = new URL(launchpadUrl).hostname;
  const cookies = (await page.context().cookies()).filter((c) => domainMatches(host, c.domain)).map(fromPlaywrightCookie);
  return { launchpadUrl, createdAt: new Date().toISOString(), cookies };
}

/** Best-effort same-origin request from the page so SAP finishes issuing the app session; failures are ignored. */
async function warmUpBackend(page: Page, launchpadUrl: string, path: string): Promise<void> {
  const url = new URL(path, new URL(launchpadUrl).origin).toString();
  await page
    .evaluate(
      (u) => fetch(u, { headers: { accept: "application/json" }, credentials: "include" }).then(() => undefined, () => undefined),
      url,
    )
    .catch(() => {});
}

export interface WaitForLaunchpadOptions {
  launchpadUrl: string;
  timeoutMs: number;
  pollMs?: number;
  /**
   * Return false as soon as the identity provider shows something that needs a person (email,
   * password, code, Authenticator…) instead of waiting for the timeout. Used by the silent refresh.
   */
  giveUpOnLoginUi?: boolean;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}

/**
 * Waits, without typing anything, until `page` lands on the launchpad. The one prompt it answers
 * itself is "Stay signed in?" (Yes + "Don't show this again"), because that answer is what makes
 * the identity provider remember the browser profile. Returns false on timeout / login UI / abort.
 */
export async function waitForLaunchpad(page: Page, opts: WaitForLaunchpadOptions): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  const poll = opts.pollMs ?? 250;
  const origin = new URL(opts.launchpadUrl).origin;
  let answeredKmsi = false;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return false;
    if (await landedOnLaunchpad(page, origin)) return true;
    if (await visible(page, SEL.kmsi)) {
      if (!answeredKmsi) opts.onStatus?.("Answering 'Stay signed in?' with Yes");
      answeredKmsi = true;
      await answerKmsi(page);
      await sleep(poll);
      continue;
    }
    if (opts.giveUpOnLoginUi && (await anyVisible(page, LOGIN_UI))) return false;
    await sleep(poll);
  }
  return false;
}

/** True when the page is on the launchpad origin, rendered, and shows no identity-provider UI. */
async function landedOnLaunchpad(page: Page, launchpadOrigin: string): Promise<boolean> {
  if (!page.url().startsWith(launchpadOrigin)) return false;
  // Make sure the document actually rendered (no pending redirect) and that no identity-provider
  // UI is showing (the IdP could share the origin).
  await page.waitForLoadState("load").catch(() => {});
  return page.url().startsWith(launchpadOrigin) && !(await anyVisible(page, LOGIN_UI));
}

/** "Stay signed in?": tick "Don't show this again" and answer Yes. */
async function answerKmsi(page: Page): Promise<void> {
  await page
    .locator(SEL.kmsi)
    .first()
    .check({ timeout: 2000 })
    .catch(() => {});
  await page
    .locator(SEL.primaryButton)
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
}

/** Drives the identity provider's pages with `creds` until `page` lands on the launchpad. */
export async function runHandshake(page: Page, creds: CredentialProvider, opts: Omit<SsoLoginOptions, "browser" | "headless" | "cookies" | "profileDir" | "channel">): Promise<void> {
  const status = (m: string) => creds.onStatus?.(m);
  const deadline = Date.now() + (opts.timeoutMs ?? 240_000);
  const poll = opts.pollMs ?? 250;
  const launchpadOrigin = new URL(opts.launchpadUrl).origin;
  let otpError = "";
  let announcedNumber = "";
  let lastStep = "";
  let unknownSince = 0;
  const reportedUnknown = new Set<string>();
  const dump = async () => {
    if (opts.debugDir) await dumpPage(page, opts.debugDir, status);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    unknownSince = 0;
    if (lastStep !== name) status(name);
    lastStep = name;
    await fn();
    await sleep(poll);
  };

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new LoginError("cancelled", "Login cancelled.");
    if (await landedOnLaunchpad(page, launchpadOrigin)) return;

    if (await visible(page, SEL.usernameError)) {
      throw new LoginError("bad_email", await text(page, SEL.usernameError));
    }
    if (await visible(page, SEL.passwordError)) {
      throw new LoginError("bad_password", await text(page, SEL.passwordError));
    }
    if ((await visible(page, SEL.adfsError)) && (await text(page, SEL.adfsError))) {
      throw new LoginError("bad_password", await text(page, SEL.adfsError));
    }

    if (await visible(page, SEL.proofUp)) {
      const body = (await page.locator("body").innerText().catch(() => ""))?.trim().split("\n")[0] ?? "";
      throw new LoginError(
        "unsupported_page",
        `Entra asks for additional account setup ("${body || "More information required"}"). Complete it once in a normal browser, then retry.`,
      );
    }
    if (await visible(page, SEL.kmsi)) {
      await step("Answering 'Stay signed in?' with Yes", () => answerKmsi(page));
      continue;
    }
    if (await visible(page, SEL.numberMatch)) {
      unknownSince = 0;
      const n = await text(page, SEL.numberMatch);
      if (n && n !== announcedNumber) {
        announcedNumber = n;
        status(`Approve the sign-in in your Authenticator app with number ${n}`);
        await creds.onNumberMatch?.(n);
      }
      await sleep(poll);
      continue;
    }
    if (await visible(page, SEL.otp)) {
      if (await visible(page, SEL.otpError)) {
        const err = await text(page, SEL.otpError);
        if (err !== otpError) otpError = err;
      }
      const promptText = [otpError, await page.locator("body").innerText().catch(() => "")]
        .filter(Boolean)
        .join("\n")
        .trim();
      await step("Entering one-time code", async () => {
        const code = await creds.getOtp(promptText);
        await page.locator(SEL.otp).first().fill(code);
        await page.locator(SEL.otpSubmit).first().click();
        await waitForChange(page, SEL.otp, [SEL.otpError], poll);
      });
      // Force re-reading the error on the next iteration if the same code page shows again.
      lastStep = "";
      continue;
    }
    // The email page also carries an off-screen password input, so the email field is checked
    // first and the password step only runs once no email field is showing.
    if (await visible(page, SEL.email)) {
      await step("Entering email", async () => {
        await page.locator(SEL.email).first().fill(await creds.getEmail());
        await page.locator(SEL.primaryButton).first().click();
        await waitForChange(page, SEL.email, [SEL.usernameError], poll);
      });
      continue;
    }
    if (await visible(page, SEL.password)) {
      await step("Entering password", async () => {
        await page.locator(SEL.password).first().fill(await creds.getPassword());
        await page.locator(SEL.primaryButton).first().click();
        await waitForChange(page, SEL.password, [SEL.passwordError], poll);
      });
      continue;
    }
    if (await visible(page, SEL.adfsPassword)) {
      await step("Entering password (federated sign-in form)", async () => {
        await page.locator(SEL.adfsPassword).first().fill(await creds.getPassword());
        await page.locator(SEL.adfsSubmit).first().click();
        await waitForChange(page, SEL.adfsPassword, [SEL.adfsError], poll);
      });
      continue;
    }
    if (await visible(page, SEL.switchToPassword)) {
      await step("Choosing 'Use your password instead'", () => page.locator(SEL.switchToPassword).first().click());
      continue;
    }
    if (await visible(page, SEL.proofs)) {
      await step("Choosing a verification method", async () => {
        for (const tile of [SEL.proofOtpTile, SEL.proofNotificationTile, SEL.proofAnyTile]) {
          if (await visible(page, tile)) {
            await page.locator(tile).first().click();
            return;
          }
        }
      });
      await waitForChange(page, SEL.proofs, [], poll);
      continue;
    }
    if (await visible(page, SEL.otherAccountTile)) {
      await step("Choosing 'Use another account'", () => page.locator(SEL.otherAccountTile).first().click());
      continue;
    }

    // Nothing matched: an interstitial, a redirect in flight, or a page this tool does not know.
    unknownSince ||= Date.now();
    if (Date.now() - unknownSince >= (opts.unknownPageAfterMs ?? 3000)) {
      const key = `${await page.title().catch(() => "")}|${page.url()}`;
      if (!reportedUnknown.has(key)) {
        reportedUnknown.add(key);
        const title = key.split("|")[0] || "(untitled)";
        status(`Waiting on unrecognized page "${title}" (${page.url()})`);
        await dump();
      }
    }
    await sleep(poll);
    continue;
  }
  const title = await page.title().catch(() => "");
  throw new LoginError("timeout", `Timed out during SSO login on "${title}" (${page.url()})`);
}

/**
 * After submitting a form, wait until the submitted input disappears, an error for it appears, or
 * ~15s pass. Only error selectors are accepted as "expected": Entra pre-renders inputs of later
 * steps off-screen, so waiting for a positive follow-up would return immediately.
 */
async function waitForChange(page: Page, submitted: string, expected: readonly string[], poll: number): Promise<void> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (!(await visible(page, submitted))) return;
    for (const sel of expected) if (await visible(page, sel)) return;
    await sleep(poll);
  }
}

async function dumpPage(page: Page, dir: string, status: (m: string) => void): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await page.screenshot({ path: join(dir, `sso-${stamp}.png`), fullPage: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, `sso-${stamp}.html`), await page.content());
    status(`Saved diagnostics to ${dir}`);
  } catch {
    /* diagnostics are best effort */
  }
}

function domainMatches(host: string, cookieDomain: string): boolean {
  const d = cookieDomain.replace(/^\./, "");
  return host === d || host.endsWith(`.${d}`);
}

type PwCookie = Parameters<BrowserContext["addCookies"]>[0][number];

function toPlaywrightCookie(c: SessionCookie): PwCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite ?? "Lax",
  };
}

function fromPlaywrightCookie(c: Awaited<ReturnType<BrowserContext["cookies"]>>[number]): SessionCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  };
}
