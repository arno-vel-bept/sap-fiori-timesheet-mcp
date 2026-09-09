import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LAUNCHPAD_URL = "https://fiori.example.com/sap/bc/ui2/flp#Shell-home";

export interface Config {
  launchpadUrl: string;
  /** Origin of the SAP system, derived from the launchpad URL (e.g. https://fiori.example.com). */
  baseUrl: string;
  sessionFile: string;
  email?: string;
  password?: string;
  /** SAP client (sap-client query parameter), if the system needs one. */
  sapClient?: string;
  language: string;
}

export type Env = Record<string, string | undefined>;

export function resolveConfig(env: Env = process.env, overrides: Partial<Config> = {}): Config {
  const launchpadUrl = overrides.launchpadUrl ?? env.XFLOW_LAUNCHPAD_URL ?? DEFAULT_LAUNCHPAD_URL;
  return {
    launchpadUrl,
    baseUrl: overrides.baseUrl ?? new URL(launchpadUrl).origin,
    sessionFile:
      overrides.sessionFile ?? env.XFLOW_SESSION_FILE ?? join(homedir(), ".config", "xflow-timesheet", "session.json"),
    email: overrides.email ?? env.XFLOW_EMAIL,
    password: overrides.password ?? env.XFLOW_PASSWORD,
    sapClient: overrides.sapClient ?? env.XFLOW_SAP_CLIENT,
    language: overrides.language ?? env.XFLOW_LANGUAGE ?? "EN",
  };
}
