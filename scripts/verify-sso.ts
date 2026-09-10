/**
 * Real-system check for specs/mcp-sso-design.md's core assumption:
 * the identity provider's own session cookie survives inside the persistent
 * browser profile, so an expired SAP session is re-issued **silently** — no
 * form, no 2FA — after a full process relaunch.
 *
 * Run it yourself (it needs your password + 2FA, which never reach the tool):
 *
 *   pnpm exec tsx scripts/verify-sso.ts                 # bundled Chromium
 *   XFLOW_BROWSER_CHANNEL=chrome pnpm exec tsx scripts/verify-sso.ts   # real Chrome
 *
 * It uses a DEDICATED throwaway profile under $TMPDIR by default so it never
 * touches your normal ~/.config/xflow-timesheet profile; pass --profile <dir>
 * to check a specific one. Nothing is written to the real session file.
 *
 * Phases:
 *   1. Sign in once in a browser window (only step you see).
 *   2. CLOSE everything, relaunch a FRESH context, and read the cookie jar:
 *      print the identity-provider cookie names + expiry (the discriminating
 *      check — a session-scoped cookie would already be gone here).
 *   3. Delete the SAP host cookies (simulate the short SAP session dying),
 *      relaunch headless, and require ensureSession() to return "silent".
 *   4. Confirm the re-issued session authenticates a real /sap/bc/ui2/start_up.
 */
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { resolveConfig } from "../src/config.js";
import { SessionStore } from "../src/auth/session-store.js";
import { SessionManager } from "../src/auth/session-manager.js";
import { SapClient } from "../src/sap/client.js";

const argv = process.argv.slice(2);
const profileArg = argv[argv.indexOf("--profile") + 1];
const useReal = argv.includes("--real-profile");
const cfg = resolveConfig();
const sapHost = new URL(cfg.launchpadUrl).hostname;
const IDP_HOST_RE = /login\.microsoftonline\.com|login\.microsoft\.com|sts\.|adfs|okta/i;

const profileDir = profileArg ?? (useReal ? cfg.profileDir : join(mkdtempSync(join(tmpdir(), "xflow-verify-")), "profile"));
const sessionFile = join(mkdtempSync(join(tmpdir(), "xflow-verify-sess-")), "session.json");
const store = new SessionStore(sessionFile);
const cleanupProfile = !profileArg && !useReal;

const line = (s = "") => process.stdout.write(s + "\n");
const check = (ok: boolean, label: string) => line(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
let allOk = true;
const record = (ok: boolean, label: string) => (check(ok, label), (allOk = allOk && ok));

function manager(extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  return new SessionManager({
    launchpadUrl: cfg.launchpadUrl,
    store,
    profileDir,
    channel: cfg.browserChannel,
    language: cfg.language,
    sapClient: cfg.sapClient,
    interactiveTimeoutMs: 300_000,
    silentTimeoutMs: 30_000,
    validForMs: 0,
    onStatus: (m) => line(`     … ${m}`),
    ...extra,
  });
}

/** Read the profile's cookie jar in a fresh short-lived context, without navigating anywhere. */
async function readJar(): Promise<{ name: string; domain: string; expires: number }[]> {
  const ctx = await chromium.launchPersistentContext(profileDir, { headless: true, channel: cfg.browserChannel });
  try {
    return (await ctx.cookies()).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires }));
  } finally {
    await ctx.close();
  }
}

async function clearSapCookies(): Promise<number> {
  const ctx = await chromium.launchPersistentContext(profileDir, { headless: true, channel: cfg.browserChannel });
  try {
    const before = (await ctx.cookies()).length;
    await ctx.clearCookies({ domain: sapHost });
    const after = (await ctx.cookies()).length;
    return before - after;
  } finally {
    await ctx.close();
  }
}

try {
  line(`launchpad     ${cfg.launchpadUrl}`);
  line(`SAP host      ${sapHost}`);
  line(`browser       channel=${cfg.browserChannel}  (set XFLOW_BROWSER_CHANNEL=chrome to use real Chrome)`);
  line(`profile       ${profileDir}${cleanupProfile ? " (throwaway)" : ""}`);
  line("");

  // ── Phase 1: interactive sign-in ────────────────────────────────────────────
  line("Phase 1 — sign in once in the browser window that opens …");
  const first = await manager().ensureSession({ interactive: true });
  line(`  signed in (method=${first.method}); SAP cookies exported: ${first.session.cookies.map((c) => c.name).join(", ")}`);
  record(first.session.cookies.some((c) => c.name.startsWith("SAP_SESSIONID")), "SAP session cookie captured");
  record(!first.session.cookies.some((c) => IDP_HOST_RE.test(c.domain)), "no identity-provider cookie in the exported session (stays in the profile)");
  line("");

  // ── Phase 2: relaunch a FRESH context and inspect the jar ────────────────────
  line("Phase 2 — relaunch a fresh browser context and read the persisted cookies …");
  const jar = await readJar();
  const idpCookies = jar.filter((c) => IDP_HOST_RE.test(c.domain));
  const persistentIdp = idpCookies.filter((c) => c.expires && c.expires > Date.now() / 1000);
  line("  identity-provider cookies that survived the relaunch:");
  if (!idpCookies.length) line("    (none)");
  for (const c of idpCookies) {
    const exp = c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session-scoped (dropped on close)";
    line(`    ${c.name}  domain=${c.domain}  expires=${exp}`);
  }
  record(persistentIdp.length > 0, "a persistent identity-provider cookie survived a full relaunch (the discriminating check)");
  line("");

  // ── Phase 3: expire the SAP session, require a SILENT refresh ────────────────
  line("Phase 3 — delete the SAP session cookies and require a silent, form-free refresh …");
  const removed = await clearSapCookies();
  const afterClear = (await readJar()).filter((c) => c.domain.includes(sapHost) || c.name.startsWith("SAP_SESSIONID"));
  record(removed > 0 && afterClear.length === 0, `SAP cookies cleared from the profile (removed ${removed}; the domain filter matched host-only cookies)`);
  const refreshed = await manager().ensureSession({ interactive: false });
  line(`  ensureSession(interactive:false) → method=${refreshed.method}`);
  record(refreshed.method === "silent", "session re-issued silently (no form, no 2FA) from the remembered identity");
  line("");

  // ── Phase 4: the re-issued session actually authenticates ────────────────────
  line("Phase 4 — confirm the re-issued session authenticates a real OData call …");
  const me = await new SapClient(refreshed.session, { language: cfg.language, sapClient: cfg.sapClient }).getJson<Record<string, unknown>>("/sap/bc/ui2/start_up");
  line(`  /sap/bc/ui2/start_up → user ${me.id}, client ${me.client}, language ${me.language}`);
  record(typeof me.id === "string" && me.id.length > 0, "re-issued SAP session returns the real user");
  line("");

  line(allOk ? "RESULT: PASS — the persistent-profile silent-SSO design holds on the real system." : "RESULT: FAIL — see the failing checks above (try XFLOW_BROWSER_CHANNEL=chrome if the silent refresh was blocked).");
  process.exitCode = allOk ? 0 : 1;
} finally {
  if (cleanupProfile && existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  rmSync(sessionFile, { force: true });
}
