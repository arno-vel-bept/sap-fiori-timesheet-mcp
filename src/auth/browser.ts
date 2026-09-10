import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** Playwright's error when the browser binary was never downloaded. */
export function isMissingBrowserError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /Executable doesn't exist|browserType\.launch.*(?:install|doesn't exist)|Please run the following command to download new browsers/i.test(msg);
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
