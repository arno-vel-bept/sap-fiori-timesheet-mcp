import { spawn } from "node:child_process";
import { mkdir, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium, type BrowserContext } from "playwright";

/** Playwright's error when the browser binary was never downloaded. */
export function isMissingBrowserError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /Executable doesn't exist|browserType\.launch.*(?:install|doesn't exist)|Please run the following command to download new browsers/i.test(msg);
}

/** Chromium's refusal to open a user-data-dir that another browser process already holds. */
export function isProfileLockedError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /ProcessSingleton|profile is already in use|already in use by another instance/i.test(msg);
}

export class ProfileLockedError extends Error {
  override readonly name = "ProfileLockedError";
  constructor(profileDir: string) {
    super(
      `The browser profile ${profileDir} is already in use by another xflow-timesheet process (another MCP host or a CLI run). ` +
        `Wait for it to finish, or give this instance its own profile with XFLOW_PROFILE_DIR.`,
    );
  }
}

/** Runs `playwright install chromium` with the playwright CLI shipped in node_modules. */
export async function installChromium(onStatus?: (m: string) => void): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = require.resolve("playwright/cli");
  onStatus?.("Downloading the headless browser used for the SSO login (one-time, ~150 MB)…");
  await new Promise<void>((resolve, reject) => {
    // Playwright's installer prints a progress bar to stdout. When this runs inside the MCP
    // server, stdout IS the JSON-RPC channel, so send the child's stdout to our stderr instead
    // (harmless for the CLI, essential for the bundle). Stderr passes through untouched.
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: ["ignore", process.stderr, "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`playwright install chromium exited with code ${code}`))));
  });
}

/**
 * Runs `fn`; if it fails because the Playwright browser is missing, installs it once and retries.
 */
export async function withBrowserInstalled<T>(fn: () => Promise<T>, opts: { install?: (onStatus?: (m: string) => void) => Promise<void>; onStatus?: (m: string) => void } = {}): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isMissingBrowserError(err)) throw err;
    await (opts.install ?? installChromium)(opts.onStatus);
    return fn();
  }
}

export interface LaunchProfileOptions {
  headless: boolean;
  /** "chromium" (bundled; also selects Chromium's new headless mode, which behaves like a headed browser) or "chrome". */
  channel?: string;
  onStatus?: (m: string) => void;
}

/**
 * Opens the persistent browser profile at `dir` (created owner-only if missing). The cookie jar —
 * including the identity provider's own cookies — lives in that directory and survives across runs.
 * Only one browser process can hold a profile at a time; a second opener gets a ProfileLockedError.
 */
export async function launchPersistentProfile(dir: string, opts: LaunchProfileOptions): Promise<BrowserContext> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  try {
    return await withBrowserInstalled(
      () =>
        chromium.launchPersistentContext(dir, {
          headless: opts.headless,
          channel: opts.channel ?? "chromium",
          // a real window size when headed; Playwright's default viewport when headless
          viewport: opts.headless ? undefined : null,
        }),
      { onStatus: opts.onStatus },
    );
  } catch (err) {
    if (isProfileLockedError(err)) throw new ProfileLockedError(dir);
    throw err;
  }
}
