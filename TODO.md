# TODO

## Chargeable-order lookup didn't find orders the real UI can select — FIXED for the standard app (2026-09-10)

**Original symptom.** Asked the agent to fill days with jobcode `2150634`. It refused: the
code didn't show up in `std_chargeable_orders` (the search matched description text only, never
the code), and booking a chargeable order also needs a sales-order item (RKDPOS) that wasn't
given. In the real Fiori UI selecting that exact jobcode works — it shows the one compatible
"Rec. sales order" item and auto-fills it.

**What changed** (`src/timesheet/standard.ts`, `src/timesheet/types.ts` unchanged, MCP/CLI
descriptions, `test/fixtures/fake-xflow.ts`, `test/standard.test.ts`, `test/e2e/real-xflow.test.ts`):

1. **Exact-code lookup** — `valueHelp()` now detects a code-shaped `query` (has a digit, no
   spaces) and resolves it by code: it first tries
   `(substringof('code', FieldValue) or FieldId eq 'code' or FieldId eq '<zero-padded>')`, and
   if the server rejects a `FieldId` filter **or** returns nothing, it pages the unfiltered list
   and matches the code client-side (leading-zero-insensitive). Padded-candidate widths: RKDAUF
   10, RAUFNR 12, RKDPOS 6. Text queries are unchanged (case-sensitive `substringof` on text).
2. **RKDPOS auto-fill** — new `StandardTimesheet.resolveSalesOrderItem(item, range?)`: `salesOrder`
   without `salesOrderItem` → `salesOrderItems(order, range)`; one row → used; several →
   `TimesheetError` listing them; none → `TimesheetError`. Called by `fill` / `set` / `fillOpen` /
   `planSet` / `planFillOpen` / `update` / `addFavorite`, and by the MCP/CLI item resolvers so dry
   runs show the resolved item. `range` is scoped to the days being booked (so a date-scoped item
   isn't missed when booking a non-current month); `addFavorite` uses the default window.
3. **Pagination** — `valueHelp()` auto-pages whenever the caller passes no explicit `top`:
   `$top=500`, advancing `$skip` **by rows actually returned** (Gateway may cap a page below 500),
   stopping on an empty or repeated page. `top` still means "cap results" (e2e passes `{ top: 5 }`).
4. **Fake server** — `ValueHelpList` honours an exact `FieldId` filter (leading-zero-insensitive),
   `parseFilter` extracts `FieldId eq …` clauses, and two new seed modes:
   `startFakeXflow({ rejectFieldIdFilter: true })` → 400 on a `FieldId` filter (exercises the
   client-side fallback); `startFakeXflow({ valueHelpPageCap: n })` → return at most `n` rows per
   response regardless of `$top` (exercises multi-page paging). Fixture order `2150634`
   ("Pega-Migration BImA", 4th RKDAUF row) is resolvable only by code and has exactly one item
   (`000112`); `3136787` (2 items) and `3150744` (0 items) cover the refusal paths.
   Tests: `test/standard.test.ts` describes "order lookup by code" and "sales-order item
   auto-fill".

## Still open

5. **Verify against the real xflow system.** `test/e2e/real-xflow.test.ts` has a read-only case
   ("a chargeable order resolves by its own number, and a single-item order auto-fills RKDPOS")
   but it has **not been run** — needs a login session:
   `XFLOW_E2E=1 pnpm test:e2e`. In particular confirm whether the real `ValueHelpList` accepts a
   `FieldId eq …` filter (if not, the client-side fallback still covers it, just with an extra
   round-trip) and whether it stores `FieldId` zero-padded at the widths assumed above.

6. **MCPB: `login_start` blocks through the first Chromium download.** In the `.mcpb` bundle the
   first `login_start` triggers Playwright's ~150 MB Chromium download inside `withBrowserInstalled`
   and blocks the tool call until it finishes — past Claude Desktop's per-call timeout. It recovers
   (call `login_start` again; the browser is cached) and `docs/mcpb.md` says so, but the nicer fix
   is for `login_start` to kick the install off in the background and return
   `{ state: "installing_browser", … }` immediately. Needs `LoginFlow` + tool changes and tests.

7. **Multiproject app not covered.** `MultiprojectTimesheet.allocate` / `allocateMany` / `balance`
   still call the sync `validateItem` only — no code lookup, no RKDPOS auto-fill. `MultiprojectTimesheet`
   has no `salesOrderItems`, and the fake's MP `ValueHelpList` ignores `FieldRelated`. To extend
   the fix: add `salesOrderItems` + `resolveSalesOrderItem` to `MultiprojectTimesheet` (or share
   the standard app's), close the fake MP `ValueHelpList` fidelity gap (`FieldRelated`,
   `substringof`, `FieldId`), then wire it into the allocate/balance paths with tests.

## Silent SSO via persistent browser profile — IMPLEMENTED + VERIFIED on the real tenant (2026-09-10)

`specs/mcp-sso-design.md` is implemented (`src/auth/session-manager.ts`,
persistent-profile support in `src/auth/sso-login.ts`, `sso_login`/`logout
forgetIdentity` MCP tools, `xflow-timesheet sso` + `--forget-identity` CLI,
`XFLOW_PROFILE_DIR` / `XFLOW_BROWSER_CHANNEL`). 185 unit tests green, incl. the
IdP-persistence path against the fake IdP.

### Verified on the real tenant (2026-09-10)

`scripts/verify-sso.ts` returned **PASS** against xflow.bearingpoint.com: a persistent
Entra cookie survives a full browser relaunch, and after the SAP session file is cleared
the session is re-issued **silently** (headless, no form, no 2FA) and authenticates
/sap/bc/ui2/start_up. The two-cookie / two-lifetime assumption from the spec holds.

To re-verify later (needs your password + 2FA on the first run only):

```bash
pnpm exec tsx scripts/verify-sso.ts                      # bundled Chromium
XFLOW_BROWSER_CHANNEL=chrome pnpm exec tsx scripts/verify-sso.ts   # real Chrome
```

It signs in in a window, **relaunches a fresh context**, prints the Entra
cookie names + expiry, then clears the SAP cookies and requires a `"silent"`
(form-free) refresh. The discriminating unknown is whether the Entra identity
cookie is **persistent** (`ESTSAUTHPERSISTENT`, survives the relaunch) or
**session-scoped** (Chromium drops it on context close — verified in a local
spike). If session-scoped, "Rester connecté ?" / KMSI is not producing a
persistent cookie on this tenant and the design degrades to one sign-in per
process; note the finding and consider forcing `channel: chrome` or the
Kerberos path (spec §10). The fake IdP issues a persistent `idp_session`, so
the unit tests only cover the persistent case by construction.

### Known gap — CSRF + session expiry (spec §6.5)

`SapClient.mutate` retries once on a `403 x-csrf-token: Required`, but it only
re-fetches the token; it does not re-establish the session. A write whose SAP
session died inside the `validForMs` probe window therefore fails once and
relies on the caller retrying (the MCP `run()` wrapper invalidates the cached
probe on `SessionExpiredError`, so the next call renews). Out of scope for the
SSO change; wire a single retry-after-reauth into the write path if this bites.
