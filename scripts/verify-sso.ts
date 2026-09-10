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
 *   pnpm exec tsx scripts/verify-sso.ts --clean         # forget the verify profile and sign in fresh
 *
 * It uses a DEDICATED verify profile at ~/.config/xflow-timesheet/verify-profile
 * (never your normal `profile`), so a first run opens a window and later runs
 * reuse the remembered identity with no prompt. Pass --profile <dir> to point
 * elsewhere. Nothing is written to your real session file.
 *
 * Phases:
 *   1. Get a session — a window opens only if the verify profile has no identity yet.
 *   2. CLOSE everything, relaunch a FRESH context, read the cookie jar and print
 *      the identity-provider cookie names + expiry. This is the discriminating
 *      check: a *persistent* Entra cookie (ESTSAUTHPERSISTENT) is still here; a
 *      *session-scoped* one was dropped by Chromium on close and would be gone.
 *   3. Clear the SAP session file (what the HTTP client actually reads — this is
 *      how a real SAP-session expiry looks) and require ensureSession() to return
 *      "silent": a headless, form-free round trip through the profile.
 *   4. Confirm the re-issued session authenticates a real /sap/bc/ui2/start_up.
 */
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { resolveConfig } from "../src/config.js";
import { SessionStore } from "../src/auth/session-store.js";
import { SessionManager } from "../src/auth/session-manager.js";
import { SapClient } from "../src/sap/client.js";

const argv = process.argv.slice(2);
const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const cfg = resolveConfig();
const sapHost = new URL(cfg.launchpadUrl).hostname;
// Hosts that mean "sitting on the identity provider, i.e. an Entra cookie".
const IDP_HOST_RE = /microsoftonline\.com|microsoft\.com|windows\.net|sts\.|adfs|okta/i;

// A stable, dedicated verify profile so re-runs reuse the sign-in (no repeated 2FA).
const profileDir = at("--profile") ?? join(dirname(cfg.profileDir), "verify-profile");
const sessionFile = join(mkdtempSync(join(tmpdir(), "xflow-verify-sess-")), "session.json");
const store = new SessionStore(sessionFile);
if (argv.includes("--clean")) rmSync(profileDir, { recursive: true, force: true });
mkdirSync(dirname(profileDir), { recursive: true });

const line = (s = "") => process.stdout.write(s + "\n");
let allOk = true;
const record = (ok: boolean, label: string) => (line(`  ${ok ? "PASS" : "FAIL"}  ${label}`), (allOk = allOk && ok));

function manager() {
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

try {
  line(`launchpad     ${cfg.launchpadUrl}`);
  line(`SAP host      ${sapHost}`);
  line(`browser       channel=${cfg.browserChannel}  (set XFLOW_BROWSER_CHANNEL=chrome to use real Chrome)`);
  line(`verify profile ${profileDir}${existsSync(profileDir) ? " (reusing)" : " (new — a window will open)"}`);
  line("");

  // ── Phase 1: get a session (a window opens only if there's no remembered identity) ──
  line("Phase 1 — establish a session (a browser window opens only on the very first run) …");
  const first = await manager().ensureSession({ interactive: true });
  line(`  method=${first.method}; SAP cookies exported: ${first.session.cookies.map((c) => c.name).join(", ")}`);
  record(first.session.cookies.some((c) => c.name.startsWith("SAP_SESSIONID")), "SAP session cookie captured");
  record(!first.session.cookies.some((c) => IDP_HOST_RE.test(c.domain)), "no identity-provider cookie in the exported session (it stays in the profile)");
  line("");

  // ── Phase 2: relaunch a FRESH context and inspect the jar ────────────────────
  line("Phase 2 — relaunch a fresh browser context and read the persisted cookies …");
  const jar = await readJar();
  const idpCookies = jar.filter((c) => IDP_HOST_RE.test(c.domain));
  const persistentIdp = idpCookies.filter((c) => c.expires && c.expires > Date.now() / 1000);
  const sapInProfile = jar.filter((c) => c.name.startsWith("SAP_SESSIONID") || c.domain.includes(sapHost));
  line("  identity-provider cookies that survived the relaunch:");
  if (!idpCookies.length) line("    (none)");
  for (const c of idpCookies) {
    const exp = c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session-scoped (dropped on close)";
    line(`    ${c.name}  domain=${c.domain}  expires=${exp}`);
  }
  line(`  (SAP cookies still in the profile after relaunch: ${sapInProfile.length} — expected 0, they are session-scoped)`);
  record(persistentIdp.length > 0, "a persistent identity-provider cookie survived a full relaunch (the discriminating check)");
  line("");

  // ── Phase 3: expire the SAP session (clear the session file) → require SILENT ──
  line("Phase 3 — clear the SAP session file and require a silent, form-free refresh …");
  await store.clear();
  record(!(await store.load()), "SAP session file cleared (simulates the short SAP session expiring)");
  const refreshed = await manager().ensureSession({ interactive: false });
  line(`  ensureSession(interactive:false) → method=${refreshed.method}`);
  record(refreshed.method === "silent", "session re-issued silently (no form, no 2FA) from the remembered identity");
  line("");

  // ── Phase 4: the re-issued session actually authenticates a data call ────────
  // Both tiers: /sap/bc/ui2/start_up authenticates off the SSO2 ticket alone, so it can pass while
  // every /sap/opu/odata/* service (what the tools use) still rejects the session.
  line("Phase 4 — confirm the re-issued session authenticates both the launchpad and a real OData call …");
  const sap = new SapClient(refreshed.session, { language: cfg.language, sapClient: cfg.sapClient });
  const me = await sap.getJson<Record<string, unknown>>("/sap/bc/ui2/start_up");
  line(`  /sap/bc/ui2/start_up → user ${me.id}, client ${me.client}, language ${me.language}`);
  record(typeof me.id === "string" && me.id.length > 0, "re-issued SAP session returns the real user");
  const svc = await sap.getJson<{ d?: { EntitySets?: unknown[] } }>("/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/");
  const entitySets = svc.d?.EntitySets?.length ?? 0;
  line(`  /sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/ → ${entitySets} entity sets`);
  record(entitySets > 0, "re-issued SAP session authenticates the timesheet OData service (the tier the tools use)");
  line("");

  line(allOk ? "RESULT: PASS — the persistent-profile silent-SSO design holds on the real system." : "RESULT: FAIL — see the failing checks above (try XFLOW_BROWSER_CHANNEL=chrome if the silent refresh was blocked).");
  line(`(the verify profile is kept at ${profileDir}; re-run without --clean to reuse it, or delete it with --clean)`);
  process.exitCode = allOk ? 0 : 1;
} finally {
  rmSync(dirname(sessionFile), { recursive: true, force: true });
}
