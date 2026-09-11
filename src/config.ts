import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LAUNCHPAD_URL = "https://xflow.bearingpoint.com/fiori/shells/abap/FioriLaunchpad.html#Shell-home";

export interface Config {
  launchpadUrl: string;
  /** Origin of the SAP system, derived from the launchpad URL (e.g. https://xflow.bearingpoint.com). */
  baseUrl: string;
  sessionFile: string;
  /**
   * Persistent browser profile (Chromium user-data-dir) that keeps the identity provider's own
   * session cookie between runs, so SAP sessions can be re-issued without a sign-in form.
   */
  profileDir: string;
  /** Playwright browser channel: "chromium" (bundled, default) or "chrome" (the installed Google Chrome). */
  browserChannel: string;
  email?: string;
  password?: string;
  /** SAP client (sap-client query parameter), if the system needs one. */
  sapClient?: string;
  language: string;
}

export type Env = Record<string, string | undefined>;

/**
 * Treat an unset, empty/blank, OR unexpanded-placeholder env var the same. MCPB / Claude
 * Desktop substitutes every `${user_config.X}` in the manifest's `env` block, so a config
 * field the user left blank arrives — depending on the host — either as `""` or as the
 * literal, unexpanded `${user_config.X}` string, never as an absent key. Both would slip
 * past a plain `??`: `""` blew up in `new URL("")`, and the literal placeholder leaked into
 * request URLs (issue #8: an unresolved `${user_config.sap_client}` became a bogus
 * `sap-client` on the session probe and turned a healthy 200 into a 401). A literal `${...}`
 * is never a valid value for any of these fields, so coerce both to `undefined` and let the
 * defaults apply.
 */
const val = (x: string | undefined): string | undefined => {
  const t = x?.trim();
  return t && !/^\$\{[^}]*\}$/.test(t) ? t : undefined;
};

export function resolveConfig(env: Env = process.env, overrides: Partial<Config> = {}): Config {
  const launchpadUrl = overrides.launchpadUrl ?? val(env.XFLOW_LAUNCHPAD_URL) ?? DEFAULT_LAUNCHPAD_URL;
  const configDir = join(homedir(), ".config", "xflow-timesheet");
  return {
    launchpadUrl,
    baseUrl: overrides.baseUrl ?? new URL(launchpadUrl).origin,
    sessionFile: overrides.sessionFile ?? val(env.XFLOW_SESSION_FILE) ?? join(configDir, "session.json"),
    profileDir: overrides.profileDir ?? val(env.XFLOW_PROFILE_DIR) ?? join(configDir, "profile"),
    browserChannel: overrides.browserChannel ?? val(env.XFLOW_BROWSER_CHANNEL) ?? "chromium",
    email: overrides.email ?? val(env.XFLOW_EMAIL),
    password: overrides.password ?? val(env.XFLOW_PASSWORD),
    sapClient: overrides.sapClient ?? val(env.XFLOW_SAP_CLIENT),
    language: overrides.language ?? val(env.XFLOW_LANGUAGE) ?? "EN",
  };
}
