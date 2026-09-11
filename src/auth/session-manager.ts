import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { launchPersistentProfile } from "./browser.js";
import { SessionStore, describeCookies, type SessionData } from "./session-store.js";
import {
  harvestSession,
  runHandshake,
  waitForLaunchpadOutcome,
  describeLaunchpadWait,
  LoginError,
  SAP_PROBE_PATH,
  type CredentialProvider,
  type LaunchpadWaitOutcome,
  type WarmUpResult,
} from "./sso-login.js";
import { SapClient, SessionExpiredError, describeExpiry, type SessionExpiryDetails } from "../sap/client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How the session was obtained. */
export type SessionMethod =
  /** the stored SAP cookies still answered the probe */
  | "cached"
  /** the identity provider recognised the persistent profile and re-issued the SAP session with no prompt */
  | "silent"
  /** the identity provider asked again and the form was driven with the given credentials (compatibility mode) */
  | "credentials"
  /** the user signed in on the identity provider's page in a browser window */
  | "interactive";

export interface EnsureSessionResult {
  method: SessionMethod;
  session: SessionData;
}

export interface EnsureSessionOptions {
  /** Open a browser window for the user when the identity provider needs a fresh sign-in (default false). */
  interactive?: boolean;
  /** Compatibility mode: drive the identity provider's form with these credentials before resorting to a window. */
  credentials?: CredentialProvider;
  signal?: AbortSignal;
}

export type LaunchContext = (profileDir: string, opts: { headless: boolean }) => Promise<BrowserContext>;

export interface SessionManagerOptions {
  launchpadUrl: string;
  store: SessionStore;
  /** Persistent browser profile that holds the identity provider's session cookie. */
  profileDir: string;
  /** Browser channel for the profile ("chromium" default, "chrome" for the installed Google Chrome). */
  channel?: string;
  language?: string;
  sapClient?: string;
  /** Opens the profile (tests inject one that never shows a window). */
  launchContext?: LaunchContext;
  /** Decides whether a stored session still works (default: GET on the timesheet OData service root). */
  probe?: (session: SessionData) => Promise<boolean>;
  /** How long the headless round trip may take before the identity provider is considered to need a person. Default 20s. */
  silentTimeoutMs?: number;
  /** How long the user gets to sign in in the window. Default 4 minutes. */
  interactiveTimeoutMs?: number;
  pollMs?: number;
  /** A successful probe is trusted for this long before probing again. Default 60s. */
  validForMs?: number;
  /** Pause between two harvest+probe attempts after the launchpad was reached. Default 750ms. */
  probeRetryMs?: number;
  /** How many harvest+probe attempts to make after the launchpad was reached. Default 4. */
  probeAttempts?: number;
  onStatus?: (message: string) => void;
  /** Called with the page shown to the user during an interactive sign-in (tests drive it like a person would). */
  onInteractivePage?: (page: Page) => void | Promise<void>;
}

/**
 * Liveness is checked against a service the data tools actually use, not `/sap/bc/ui2/start_up`:
 * that endpoint accepts a session the OData services may still reject (issue #5).
 */
const PROBE_PATH = SAP_PROBE_PATH;

const SIGN_IN_HINT =
  "Run `xflow-timesheet sso` (or call the sso_login tool) to sign in once in a browser window; after that the session is renewed silently.";

/**
 * Keeps an authenticated SAP session available with as little user interaction as possible.
 *
 * The SAP cookies are short-lived and stored in the session file for the plain HTTP client. The
 * identity provider's own cookie is long-lived and lives only inside a persistent browser profile:
 * when the SAP session is gone, a headless navigation through the profile lets the identity
 * provider re-issue it silently. Only when that fails does the user see a browser window.
 *
 * Every failure carries `details` (see SessionExpiryDetails): which request was refused, what SAP
 * answered, which cookies (names only) were involved, what the browser itself saw. Nothing is
 * swallowed on the way up, so a bug report can be written from the error alone.
 */
export class SessionManager {
  private inflight: Promise<EnsureSessionResult> | null = null;
  private validatedAt = 0;
  private readonly launch: LaunchContext;
  private readonly probeFn: (session: SessionData) => Promise<boolean>;
  private probeFailure: SessionExpiredError | null = null;

  constructor(private readonly opts: SessionManagerOptions) {
    this.launch =
      opts.launchContext ?? ((dir, o) => launchPersistentProfile(dir, { headless: o.headless, channel: opts.channel, onStatus: opts.onStatus }));
    this.probeFn = opts.probe ?? ((session) => this.defaultProbe(session));
  }

  get profileDir(): string {
    return this.opts.profileDir;
  }

  /** The error the last failed probe produced (why SAP refused the stored/exported cookies), if any. */
  get lastProbeFailure(): SessionExpiredError | null {
    return this.probeFailure;
  }

  /** Whether a browser profile (and so, probably, a remembered identity) exists on disk. */
  hasProfile(): boolean {
    return existsSync(this.opts.profileDir);
  }

  /** Forget the last successful probe, so the next ensureSession() checks the session again. */
  invalidate(): void {
    this.validatedAt = 0;
  }

  ensureSession(o: EnsureSessionOptions = {}): Promise<EnsureSessionResult> {
    if (!this.inflight) {
      this.inflight = this.run(o).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Deletes the browser profile and the session file: the identity provider will ask for a sign-in again. */
  async forgetIdentity(): Promise<void> {
    this.invalidate();
    await this.opts.store.clear();
    await rm(this.opts.profileDir, { recursive: true, force: true });
  }

  private async run(o: EnsureSessionOptions): Promise<EnsureSessionResult> {
    // 1) Fast path: the stored SAP cookies still work.
    const stored = await this.opts.store.load();
    let storedRejected: SessionExpiryDetails | undefined;
    if (stored) {
      const validFor = this.opts.validForMs ?? 60_000;
      if (this.validatedAt && Date.now() - this.validatedAt < validFor) return { method: "cached", session: stored };
      if (await this.probeFn(stored)) {
        this.validatedAt = Date.now();
        return { method: "cached", session: stored };
      }
      storedRejected = this.probeFailure?.details;
      this.status(`Stored session (${describeCookies(stored.cookies).join(", ") || "no cookies"}, from ${stored.createdAt}) no longer works: ${this.probeFailure ? describeExpiry(this.probeFailure.details) : "probe failed"}`);
    } else {
      this.status(`No stored session at ${this.opts.store.file}`);
    }
    this.validatedAt = 0;

    // 2) Silent refresh: a headless round trip through the persistent profile. The identity
    //    provider may still know the browser and auto-POST a fresh assertion without any form.
    //    3) Compatibility: if it does ask, and credentials were given, fill the form headlessly.
    //
    //    Only worth a browser when there is an identity to reuse (a profile on disk) or credentials
    //    to type. With neither, launching would just navigate to the identity provider's sign-in
    //    form and wait — so skip straight to the interactive/needs-sign-in outcome instead.
    let silentOutcome: LaunchpadWaitOutcome | { reason: "no_profile" } = { reason: "no_profile" };
    const silent = this.hasProfile() || o.credentials ? await this.withProfile(true, async (page) => {
      this.status("Checking whether the identity provider still remembers this browser…");
      await page.goto(this.opts.launchpadUrl, { waitUntil: "domcontentloaded" });
      const outcome = await waitForLaunchpadOutcome(page, {
        launchpadUrl: this.opts.launchpadUrl,
        timeoutMs: this.opts.silentTimeoutMs ?? 20_000,
        pollMs: this.opts.pollMs,
        giveUpOnLoginUi: true,
        signal: o.signal,
        onStatus: this.opts.onStatus,
      });
      silentOutcome = outcome;
      if (outcome.landed) return this.finish(page, "silent");
      this.status(`Silent refresh gave up: ${describeLaunchpadWait(outcome)}`);
      if (!o.credentials) return null;
      this.status("The identity provider asks for a sign-in; using the given credentials");
      await runHandshake(page, o.credentials, { launchpadUrl: this.opts.launchpadUrl, pollMs: this.opts.pollMs, signal: o.signal });
      return this.finish(page, "credentials");
    }) : null;
    if (silent) return silent;

    if (!o.interactive) {
      const why =
        silentOutcome.reason === "no_profile"
          ? `there is no browser profile at ${this.opts.profileDir}, so no remembered identity to renew the session from`
          : `the silent refresh through the browser profile ${this.opts.profileDir} did not reach the launchpad: ${describeLaunchpadWait(silentOutcome)}`;
      const storedNote = storedRejected ? `; the stored session was refused first: ${describeExpiry(storedRejected)}` : "";
      throw new SessionExpiredError(`The identity provider needs a fresh sign-in (${why}${storedNote}). ${SIGN_IN_HINT}`, {
        kind: "needs_sign_in",
        profileDir: this.opts.profileDir,
        sessionFile: this.opts.store.file,
        silent: silentOutcome,
        storedSession: storedRejected,
      });
    }

    // 4) Interactive: the only step the user ever sees. Same profile, headed, and nothing is typed
    //    by the tool — the user signs in on the identity provider's genuine page.
    const interactive = await this.withProfile(false, async (page) => {
      this.status("Opening a browser window — please sign in there (the tool never sees your password).");
      await page.goto(this.opts.launchpadUrl, { waitUntil: "domcontentloaded" });
      void this.opts.onInteractivePage?.(page);
      const outcome = await waitForLaunchpadOutcome(page, {
        launchpadUrl: this.opts.launchpadUrl,
        timeoutMs: this.opts.interactiveTimeoutMs ?? 240_000,
        pollMs: this.opts.pollMs,
        signal: o.signal,
        onStatus: this.opts.onStatus,
      });
      if (!outcome.landed) {
        if (o.signal?.aborted) throw new LoginError("cancelled", `Sign-in cancelled (${describeLaunchpadWait(outcome)}).`);
        throw new LoginError("timeout", `Timed out waiting for the sign-in in the browser window: ${describeLaunchpadWait(outcome)}.`);
      }
      return this.finish(page, "interactive");
    });
    return interactive;
  }

  /** Opens the profile in the given mode, runs `fn` on a fresh page, and always releases the profile lock. */
  private async withProfile<T>(headless: boolean, fn: (page: Page) => Promise<T>): Promise<T> {
    const ctx = await this.launch(this.opts.profileDir, { headless });
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      try {
        return await fn(page);
      } catch (err) {
        if (err instanceof LoginError || err instanceof SessionExpiredError) throw err;
        const msg = (err as Error)?.message ?? String(err);
        if (/has been closed/i.test(msg)) throw new LoginError("cancelled", "The browser window was closed before the sign-in completed.");
        throw err;
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  /**
   * Exports the SAP cookies to the session file and confirms they authenticate a real data call.
   *
   * SAP promotes the freshly issued security session into a full application session
   * asynchronously, once the shell has talked to the backend. So each attempt first drives the
   * probe URL from inside the page (warm-up), then reads the cookie jar, then probes with the plain
   * HTTP client. A session that only /sap/bc/ui2/start_up would accept is never persisted as
   * "logged in"; when every attempt fails, the error says exactly what both sides saw.
   */
  private async finish(page: Page, method: SessionMethod): Promise<EnsureSessionResult> {
    this.status("Launchpad reached, storing the SAP session");
    const started = Date.now();
    const attempts = this.opts.probeAttempts ?? 4;
    let browser: WarmUpResult | undefined;
    const harvest = () => harvestSession(page, this.opts.launchpadUrl, { warmUpPath: PROBE_PATH, onWarmUp: (r) => (browser = r) });
    let session = await harvest();
    for (let attempt = 1; !(await this.probeFn(session)); attempt++) {
      const probe = this.probeFailure?.details;
      const exported = describeCookies(session.cookies);
      this.status(
        `Attempt ${attempt}/${attempts}: the exported cookies (${exported.join(", ") || "none"}) were refused: ${probe ? describeExpiry(probe) : "probe failed"}` +
          (browser ? `; the browser itself got ${describeWarmUp(browser)}` : ""),
      );
      if (attempt >= attempts) {
        // Kept on disk on purpose: the rejected cookies are evidence (names, paths, attributes).
        await this.opts.store.save(session);
        const elapsedMs = Date.now() - started;
        const summary =
          `Reached the launchpad, but the SAP cookies exported from the browser do not authenticate API calls ` +
          `(${attempts} attempts over ${(elapsedMs / 1000).toFixed(1)}s). ` +
          `Probe ${probe ? describeExpiry({ ...probe, cookiesSent: undefined, cookiesStored: undefined }) : "failed without details"}; ` +
          `cookies exported: ${exported.join(", ") || "none"}` +
          (probe?.cookiesSent && JSON.stringify(probe.cookiesSent) !== JSON.stringify(exported) ? ` (sent on the probe: ${probe.cookiesSent.join(", ") || "none"})` : "") +
          (browser ? `; the browser itself got ${describeWarmUp(browser)} for the same URL` : "") +
          `. The rejected cookies were kept in ${this.opts.store.file} for inspection. ${SIGN_IN_HINT}`;
        throw new SessionExpiredError(summary, {
          kind: "cookies_rejected",
          method: method,
          attempts,
          elapsedMs,
          probe,
          browser,
          cookiesStored: exported,
          sessionFile: this.opts.store.file,
          profileDir: this.opts.profileDir,
          launchpadUrl: this.opts.launchpadUrl,
          pageUrl: page.url(),
        });
      }
      this.status("Waiting for SAP to finish issuing the application session…");
      await sleep(this.opts.probeRetryMs ?? 750);
      session = await harvest();
    }
    await this.opts.store.save(session);
    this.validatedAt = Date.now();
    this.status(`Session stored (${describeCookies(session.cookies).join(", ")}); the probe ${PROBE_PATH} accepted it`);
    return { method, session };
  }

  private async defaultProbe(session: SessionData): Promise<boolean> {
    const client = new SapClient(session, { language: this.opts.language, sapClient: this.opts.sapClient });
    try {
      await client.getJson(PROBE_PATH);
      this.probeFailure = null;
      return true;
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        this.probeFailure = err;
        return false;
      }
      throw err;
    }
  }

  private status(message: string): void {
    this.opts.onStatus?.(message);
  }
}

function describeWarmUp(w: WarmUpResult): string {
  if (w.error) return `an error (${w.error})`;
  return `${w.status}${w.statusText ? ` ${w.statusText}` : ""}${w.contentType ? ` ${w.contentType}` : ""}${w.cookies.length ? `, holding ${w.cookies.join(", ")}` : ""}`;
}
