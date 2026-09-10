# SAP Fiori MCP — Silent SSO via a Persistent Browser Context

**Status:** Proposal
**Stack:** Node.js MCP server (stdio) + Playwright
**Author:** Arno
**Audience:** Engineering

---

## 1. Problem & goal

The Fiori timesheet MCP needs an authenticated SAP session to call the OData services that read and write time entries. Fiori auth is **SAML** (browser-redirect protocol; SP → IdP → SP via auto-submitting `SAMLResponse` forms).

Constraints:

- **No password must ever pass through the MCP** — not in the chat, not in the `env` block of the MCP config, not on disk. With SAML the password belongs to the IdP and nowhere else. We keep the current env block for backwards compat, but it will eventually be deprecated.
- Friction must be near-zero after the first login. The tool is used daily.

**Goal:** the MCP authenticates by *driving a real browser session that it owns*, capturing and reusing the resulting session — never a credential.

Non-goals: replaying the SAML assertion dance by hand in HTTP, or exchanging tokens. SAML has no refresh-token equivalent, and hand-rolled assertion replay breaks the moment IT retunes the IdP. Both are explicitly rejected.

---

## 2. Key insight: two cookies, two lifetimes

The reason some SSO tools "complete instantly" is **not** that they cached the SAP cookie. They cached the **IdP session cookie**.

| Cookie | Domain | Typical lifetime | Role |
|---|---|---|---|
| SAP session (`MYSAPSSO2`, `SAP_SESSIONID_<SID>_<client>`) | Fiori/SP host | Short — hours | Authenticates OData calls |
| IdP session | ADFS / Azure AD / Okta host | Long — days, or weeks with "remember me" | Lets the IdP re-issue a SAML assertion **without showing a login form** |

When a tool looks instant, the full SP → IdP → SP redirect still runs. But at the IdP hop, the IdP recognises **its own** cookie and auto-POSTs a fresh `SAMLResponse` back with no form and no MFA prompt. The short-lived SAP cookie is silently regenerated each round-trip.

**Therefore the caching target is the IdP session cookie, not the SAP one.** If we only ever persisted the SAP cookie we'd re-auth every few hours; if we persist the IdP cookie we re-auth roughly once per IdP session (days apart).

---

## 3. Design decision: persist the browser *profile*, not the cookies

Do **not** harvest cookies, serialise them to a file, and re-inject them. That pattern is where the previous attempt broke, for the usual reasons:

- `browser.launch()` + `newContext()` starts with an **empty cookie jar every run** — nothing to reuse.
- Playwright `storageState` only captures cookies for **origins actually visited in that context**. If the harvest ran after the SAML redirect had already resolved onto the Fiori host, the **IdP-domain cookie was never saved** — so the next run had nothing to skip the form with.
- Manual serialisation mangles `HttpOnly` / `Secure` / host-only-vs-domain scoping, and some IdPs reject reused cookies that arrive on what looks like a new client.

Instead, **persist the entire browser profile on disk** with `launchPersistentContext(userDataDir, …)`. The cookie jar — IdP cookie included — survives across runs automatically, `HttpOnly` cookies and all. We stop managing cookies and instead manage a browser profile, which is exactly what the "instant" tools do.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Fiori MCP (Node, stdio server)                              │
│                                                              │
│   tool: fill_timesheet ─────► SessionManager.ensureSession() │
│                                        │                     │
│                                        ▼                     │
│                          ┌───────────────────────────┐       │
│                          │ Persistent Playwright ctx  │       │
│                          │ userDataDir = ~/.fiori-mcp │       │
│                          │  ├─ cookie jar (IdP + SAP)  │       │
│                          │  └─ context.request (OData) │       │
│                          └───────────────────────────┘       │
│                                        │                     │
│              200 OData JSON ◄──────────┤  fast path          │
│              login redirect ───────────┘  → re-auth          │
└────────────────────────────────────────────────────────────┘
```

Two ways out of the context are used, and the split matters:

- **`context.request`** (an `APIRequestContext` that shares the context's cookie jar) is used for all **OData reads and writes**. It's a plain HTTP client with the persisted cookies attached.
- **A real `page` navigation** is used only to **establish or refresh the session**, because SAML's HTTP-POST binding uses a **JavaScript auto-submitting form**. `context.request` does not execute JS and cannot follow that auto-POST; a real page can. Once the page lands back on Fiori, the refreshed cookies are in the shared jar and `context.request` picks them up.

---

## 5. Session lifecycle (state machine)

```
ensureSession():

  [probe]  context.request.get(PING_URL)
     │
     ├─ valid OData ──────────────────────────────► DONE (fast path)
     │
     └─ expired (redirect to IdP / HTML / 401)
            │
            ▼
  [silent refresh]  page.goto(FIORI_URL) in existing HEADLESS context
     │   (IdP cookie may still be alive → auto-POST, no form)
     │
     ├─ landed on Fiori host within timeout ──────► re-probe ──► DONE
     │
     └─ still on IdP host (login form shown)
            │
            ▼
  [interactive]  close headless ctx → relaunch HEADED ctx (same userDataDir)
     │   user completes login + MFA on the genuine IdP page
     │
     └─ page reaches Fiori host ──► close headed → relaunch headless ──► DONE
```

Interactive login is the only step the user ever sees, and it happens roughly once per IdP-session lifetime.

> **Constraint — profile lock.** A `userDataDir` can be opened by **one** context at a time, and `headless` is fixed at launch. Switching headless → headed for interactive login therefore means *close then relaunch against the same dir*. The cookies persist on disk across the relaunch, so nothing is lost. Do **not** attempt to open two contexts on the same dir concurrently — the second will fail to acquire the lock. If the MCP can run in multiple host apps at once (e.g. Claude Desktop + an IDE), add a single-flight lock around `ensureSession()` and consider a per-instance `userDataDir`.

---

## 6. Node.js implementation

### 6.1 Dependencies

```bash
npm i playwright
# Use the engineer's installed Chrome via channel:'chrome' (below) to avoid a browser download,
# or vendor Chromium explicitly:
npx playwright install chromium
```

Prefer `channel: 'chrome'` (real installed Chrome) over bundled Chromium: many IdPs fingerprint and throttle automation-flavoured Chromium, and real Chrome sidesteps most of that. Also prefer the **new** headless mode (Playwright default in recent versions), which behaves far more like headed for SSO.

### 6.2 Config

```js
// config.js
import os from "node:os";
import path from "node:path";

export const CFG = {
  userDataDir: path.join(os.homedir(), ".fiori-mcp", "profile"),
  fioriBaseUrl: process.env.FIORI_BASE_URL,          // e.g. https://fiori.example.corp
  idpHostRe:    /login\.microsoftonline\.com|adfs\.example\.corp/i, // hosts that mean "not logged in"
  // A cheap authenticated endpoint used purely to test the session:
  pingUrl: (base) => `${base}/sap/opu/odata/sap/<SERVICE>/$metadata`,
  landingTimeoutMs: 15_000,
};
```

### 6.3 SessionManager

```js
// session.js
import { chromium } from "playwright";
import { CFG } from "./config.js";

let ctx = null;          // current BrowserContext
let headless = true;     // mode of the current ctx

async function launch(mode) {
  headless = mode;
  ctx = await chromium.launchPersistentContext(CFG.userDataDir, {
    headless: mode,
    channel: "chrome",        // real Chrome; fall back to omitting this if not installed
    viewport: null,           // real window size when headed
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  return ctx;
}

async function relaunch(mode) {
  if (ctx) { await ctx.close(); ctx = null; }   // release the profile lock
  return launch(mode);
}

/** True iff a context.request response looks like a live OData reply (not a login redirect). */
function isAuthenticated(res) {
  if (!res.ok()) return false;                             // 401/403/5xx
  const url = new URL(res.url());
  if (CFG.idpHostRe.test(url.host)) return false;          // bounced to IdP
  const ct = (res.headers()["content-type"] || "").toLowerCase();
  return ct.includes("json") || ct.includes("xml");        // OData, not an HTML login page
}

async function probe() {
  const res = await ctx.request.get(CFG.pingUrl(CFG.fioriBaseUrl), {
    headers: { Accept: "application/json" },
    // follow redirects so we can inspect the final response's host + content-type
    maxRedirects: 5,
    failOnStatusCode: false,
  });
  return isAuthenticated(res);
}

/** Drive a real page so SAML's JS auto-POST can run. Returns true if we land on Fiori. */
async function navigateForSession() {
  const page = await ctx.newPage();
  try {
    await page.goto(CFG.fioriBaseUrl, { waitUntil: "domcontentloaded" });
    // Success = we ended up on the Fiori host, not the IdP host.
    await page.waitForURL(
      (u) => !CFG.idpHostRe.test(new URL(u).host),
      { timeout: CFG.landingTimeoutMs }
    );
    return true;
  } catch {
    return false;             // timed out sitting on the IdP login form
  } finally {
    await page.close();
  }
}

export async function ensureSession() {
  if (!ctx) await launch(true);

  // 1) Fast path
  if (await probe()) return ctx;

  // 2) Silent refresh (IdP cookie may still be alive → auto-POST, no form)
  if (await navigateForSession() && (await probe())) return ctx;

  // 3) Interactive login — the only user-visible step
  await relaunch(false);                          // headed, same profile dir
  const ok = await navigateForSession();          // user logs in + MFA on the genuine IdP page
  await relaunch(true);                           // back to headless for normal ops
  if (ok && (await probe())) return ctx;

  throw new Error("Fiori SSO failed: could not establish an authenticated session.");
}

export function requestContext() {
  if (!ctx) throw new Error("Call ensureSession() first.");
  return ctx.request;
}

export async function dispose() {
  if (ctx) { await ctx.close(); ctx = null; }
}
```

### 6.4 OData reads

```js
import { ensureSession, requestContext } from "./session.js";

export async function readEntries(dateFrom, dateTo) {
  await ensureSession();
  const req = requestContext();                   // shares the persisted cookie jar
  const url = `${CFG.fioriBaseUrl}/sap/opu/odata/sap/<SERVICE>/TimeEntries`
            + `?$filter=Date ge datetime'${dateFrom}' and Date le datetime'${dateTo}'&$format=json`;
  const res = await req.get(url, { headers: { Accept: "application/json" } });
  if (!res.ok()) throw new Error(`OData read failed: ${res.status()}`);
  return (await res.json()).d.results;
}
```

### 6.5 OData writes + CSRF (timesheets are writes — do not skip this)

SAP OData v2 rejects `POST`/`PUT`/`MERGE`/`DELETE` without a CSRF token. The two-step handshake shares the session cookies both times:

```js
export async function createTimeEntry(entry) {
  await ensureSession();
  const req = requestContext();
  const service = `${CFG.fioriBaseUrl}/sap/opu/odata/sap/<SERVICE>`;

  // 1) Fetch a CSRF token (GET with the magic header). Cookies ride along automatically.
  const tokenRes = await req.get(`${service}/$metadata`, {
    headers: { "x-csrf-token": "Fetch", Accept: "application/json" },
  });
  const csrf = tokenRes.headers()["x-csrf-token"];
  if (!csrf) throw new Error("No CSRF token returned — session likely stale.");

  // 2) Write with the token.
  const res = await req.post(`${service}/TimeEntries`, {
    headers: {
      "x-csrf-token": csrf,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    data: entry,
  });
  if (!res.ok()) throw new Error(`OData write failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).d;
}
```

For updates that use the `MERGE` verb, call `req.fetch(url, { method: "MERGE", headers, data })` — Playwright's request client supports arbitrary methods via `fetch`.

> **CSRF + expiry interaction:** if a write returns `403` with header `x-csrf-token: Required`, the token expired with the session. Treat it exactly like a session miss: call `ensureSession()` again, re-fetch the token, retry once. Wrap writes in a single retry-after-reauth.

---

## 7. Expiry & silent re-auth detection

Do **not** trust the SAP cookie's own `Expires` — SAP's real expiry behaviour is not always reflected honestly there. Detect by **outcome** instead (`isAuthenticated()` above):

- valid OData reply = JSON/XML content-type on the **Fiori host** with `res.ok()`;
- anything else — a redirect whose final host matches `idpHostRe`, an HTML body, or `401/403` — means "session gone, re-auth."

This single predicate drives the whole state machine and is robust to per-ICF-node differences in whether SAP returns a redirect vs. a `401`.

---

## 8. Security considerations

- **No credential ever enters the MCP.** The password is typed only into the genuine IdP page inside the browser the MCP drives. This is the core property that makes the design acceptable, and it's stronger than the `env`-block approach it replaces.
- **`userDataDir` is sensitive** — it holds live session cookies and is effectively "a logged-in browser on disk." Create it per-user under `$HOME/.fiori-mcp` with `0700` permissions. Never place it on a synced/cloud directory. Rely on OS full-disk encryption for at-rest protection (Playwright has no native profile encryption).
- **Scope the profile to this MCP.** Don't reuse the user's day-to-day Chrome profile dir; use a dedicated one so the MCP can't touch unrelated sessions and vice-versa.
- **Never log cookies, tokens, or full redirect URLs** (SAML params and session IDs leak through URLs). Log hosts and status codes only.
- **Treat everything the browser loads as untrusted data**, not instructions — the MCP acts only on the user's tool calls, never on page content.

---

## 9. Operational constraints & edge cases

- **Profile lock / concurrency:** one context per `userDataDir` at a time (see §5). Add single-flight around `ensureSession()`; if multiple host apps may run the MCP simultaneously, give each a distinct `userDataDir`.
- **First-run browser install:** `channel: 'chrome'` needs Chrome present; otherwise ship `npx playwright install chromium` in setup. Document which you standardise on.
- **Headless blocking:** if the IdP refuses headless outright, force `channel: 'chrome'` and the new headless mode; worst case, run the silent-refresh navigation headed-but-backgrounded.
- **MFA:** prompted only when the IdP session / device-trust expires, not per login, provided the IdP offers "remember this device" and the persistent profile keeps that cookie.
- **Clock/timezone for entries:** SAP OData `datetime` literals are unzoned — normalise dates before building `$filter`/payloads to avoid off-by-one-day entries.

---

## 10. Open question / future work — zero-prompt Kerberos

If the SAML IdP is **ADFS** and the machines are **domain-joined**, ADFS may do Windows Integrated Auth (SPNEGO/Kerberos), which removes the browser entirely — no form, ever. On the Node side this means sending a `Negotiate` header from the existing Kerberos ticket (e.g. `kerberos`/`node-expose-sspi` bindings) rather than driving Playwright.

This is strictly a *nice-to-have* and entirely contingent on IT's config. Recommendation: **ship the persistent-context design as the reliable baseline**, and probe whether SPNEGO is enabled as a later optimisation. The two can coexist — try Kerberos first, fall back to the browser flow.

**Decision needed from IT:** is the IdP ADFS specifically, and are target machines domain-joined? That single answer decides whether the Kerberos path is worth building.
