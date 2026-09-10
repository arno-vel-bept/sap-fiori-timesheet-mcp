import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { launchPersistentProfile } from "./browser.js";
import { SessionStore, type SessionData } from "./session-store.js";
import { harvestSession, runHandshake, waitForLaunchpad, LoginError, type CredentialProvider } from "./sso-login.js";
import { SapClient, SessionExpiredError } from "../sap/client.js";

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
  /** Decides whether a stored session still works (default: GET /sap/bc/ui2/start_up). */
  probe?: (session: SessionData) => Promise<boolean>;
  /** How long the headless round trip may take before the identity provider is considered to need a person. Default 20s. */
  silentTimeoutMs?: number;
  /** How long the user gets to sign in in the window. Default 4 minutes. */
  interactiveTimeoutMs?: number;
  pollMs?: number;
  /** A successful probe is trusted for this long before probing again. Default 60s. */
  validForMs?: number;
  onStatus?: (message: string) => void;
  /** Called with the page shown to the user during an interactive sign-in (tests drive it like a person would). */
  onInteractivePage?: (page: Page) => void | Promise<void>;
}

const PROBE_PATH = "/sap/bc/ui2/start_up";

/**
 * Keeps an authenticated SAP session available with as little user interaction as possible.
 *
 * The SAP cookies are short-lived and stored in the session file for the plain HTTP client. The
 * identity provider's own cookie is long-lived and lives only inside a persistent browser profile:
 * when the SAP session is gone, a headless navigation through the profile lets the identity
 * provider re-issue it silently. Only when that fails does the user see a browser window.
 */
export class SessionManager {
  private inflight: Promise<EnsureSessionResult> | null = null;
  private validatedAt = 0;
  private readonly launch: LaunchContext;
  private readonly probeFn: (session: SessionData) => Promise<boolean>;

  constructor(private readonly opts: SessionManagerOptions) {
    this.launch =
      opts.launchContext ?? ((dir, o) => launchPersistentProfile(dir, { headless: o.headless, channel: opts.channel, onStatus: opts.onStatus }));
    this.probeFn = opts.probe ?? ((session) => this.defaultProbe(session));
  }

  get profileDir(): string {
    return this.opts.profileDir;
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
    if (stored) {
      const validFor = this.opts.validForMs ?? 60_000;
      if (this.validatedAt && Date.now() - this.validatedAt < validFor) return { method: "cached", session: stored };
      if (await this.probeFn(stored)) {
        this.validatedAt = Date.now();
        return { method: "cached", session: stored };
      }
    }
    this.validatedAt = 0;

    // 2) Silent refresh: a headless round trip through the persistent profile. The identity
    //    provider may still know the browser and auto-POST a fresh assertion without any form.
    //    3) Compatibility: if it does ask, and credentials were given, fill the form headlessly.
    //
    //    Only worth a browser when there is an identity to reuse (a profile on disk) or credentials
    //    to type. With neither, launching would just navigate to the identity provider's sign-in
    //    form and wait — so skip straight to the interactive/needs-sign-in outcome instead.
    const silent = this.hasProfile() || o.credentials ? await this.withProfile(true, async (page) => {
      this.status("Checking whether the identity provider still remembers this browser…");
      await page.goto(this.opts.launchpadUrl, { waitUntil: "domcontentloaded" });
      const landed = await waitForLaunchpad(page, {
        launchpadUrl: this.opts.launchpadUrl,
        timeoutMs: this.opts.silentTimeoutMs ?? 20_000,
        pollMs: this.opts.pollMs,
        giveUpOnLoginUi: true,
        signal: o.signal,
        onStatus: this.opts.onStatus,
      });
      if (landed) return this.finish(page, "silent");
      if (!o.credentials) return null;
      this.status("The identity provider asks for a sign-in; using the given credentials");
      await runHandshake(page, o.credentials, { launchpadUrl: this.opts.launchpadUrl, pollMs: this.opts.pollMs, signal: o.signal });
      return this.finish(page, "credentials");
    }) : null;
    if (silent) return silent;

    if (!o.interactive) {
      throw new SessionExpiredError(
        "The identity provider needs a fresh sign-in. Run `xflow-timesheet sso` (or call the sso_login tool) to sign in once in a browser window; " +
          "after that the session is renewed silently.",
      );
    }

    // 4) Interactive: the only step the user ever sees. Same profile, headed, and nothing is typed
    //    by the tool — the user signs in on the identity provider's genuine page.
    const interactive = await this.withProfile(false, async (page) => {
      this.status("Opening a browser window — please sign in there (the tool never sees your password).");
      await page.goto(this.opts.launchpadUrl, { waitUntil: "domcontentloaded" });
      void this.opts.onInteractivePage?.(page);
      const landed = await waitForLaunchpad(page, {
        launchpadUrl: this.opts.launchpadUrl,
        timeoutMs: this.opts.interactiveTimeoutMs ?? 240_000,
        pollMs: this.opts.pollMs,
        signal: o.signal,
        onStatus: this.opts.onStatus,
      });
      if (!landed) {
        if (o.signal?.aborted) throw new LoginError("cancelled", "Sign-in cancelled.");
        throw new LoginError("timeout", "Timed out waiting for the sign-in in the browser window.");
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
        if (err instanceof LoginError) throw err;
        const msg = (err as Error)?.message ?? String(err);
        if (/has been closed/i.test(msg)) throw new LoginError("cancelled", "The browser window was closed before the sign-in completed.");
        throw err;
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  /** Exports the SAP cookies to the session file and confirms they work. */
  private async finish(page: Page, method: SessionMethod): Promise<EnsureSessionResult> {
    this.status("Launchpad reached, storing the SAP session");
    const session = await harvestSession(page, this.opts.launchpadUrl);
    await this.opts.store.save(session);
    if (!(await this.probeFn(session))) {
      throw new SessionExpiredError("Reached the launchpad, but the exported SAP cookies do not authenticate API calls.");
    }
    this.validatedAt = Date.now();
    return { method, session };
  }

  private async defaultProbe(session: SessionData): Promise<boolean> {
    const client = new SapClient(session, { language: this.opts.language, sapClient: this.opts.sapClient });
    try {
      await client.getJson(PROBE_PATH);
      return true;
    } catch (err) {
      if (err instanceof SessionExpiredError) return false;
      throw err;
    }
  }

  private status(message: string): void {
    this.opts.onStatus?.(message);
  }
}
