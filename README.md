# xflow-timesheet

[![npm version](https://img.shields.io/npm/v/sap-fiori-timesheet-mcp.svg)](https://www.npmjs.com/package/sap-fiori-timesheet-mcp)
[![license](https://img.shields.io/npm/l/sap-fiori-timesheet-mcp.svg)](LICENSE)
[![CI](https://github.com/arno-vel-bept/sap-fiori-timesheet-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/arno-vel-bept/sap-fiori-timesheet-mcp/actions/workflows/ci.yml)

CLI and local MCP server that let a human or an AI agent work with an
**SAP Fiori** timesheet portal (originally built against BearingPoint's
internal "xflow" portal, but generic to any Fiori-based deployment of the
same *Standard timesheet* and *Multiproject timesheet* apps).

## Documentation

The full documentation (tutorials, how-to guides, reference and explanations) lives at
**https://arno-vel-bept.github.io/sap-fiori-timesheet-mcp/** and is built from
[`website/`](website/) with Astro Starlight (`pnpm --dir website dev` to preview locally).
Start with [Install for Claude Desktop](https://arno-vel-bept.github.io/sap-fiori-timesheet-mcp/install/claude-desktop/)
if you just want to use it.

## Use via npx (fastest, no install)

Point your MCP client at the published package — nothing to install first:

```json
{
  "mcpServers": {
    "xflow-timesheet": {
      "command": "npx",
      "args": ["-y", "sap-fiori-timesheet-mcp@latest"]
    }
  }
}
```

The default `XFLOW_LAUNCHPAD_URL` points at BearingPoint's own "xflow" Fiori
portal (see `.env.example`). Working against a different SAP Fiori system?
Add an `"env"` override with your own launchpad URL:

```json
      "env": { "XFLOW_LAUNCHPAD_URL": "https://your-fiori-host.example/sap/bc/ui2/flp#Shell-home" }
```

or generate the whole block with `xflow-timesheet install-mcp --client <client> --npx` once you
have the CLI on your PATH (see [Install](#install-for-anyone-on-the-team) below), or just
write the JSON above by hand — npx needs nothing pre-installed. The CLI works the
same way: `npx -y -p sap-fiori-timesheet-mcp xflow-timesheet login`.

Prefer a local install (no npx overhead on every launch, and easier to patch)?
See [Install](#install-for-anyone-on-the-team) below.

## Claude Desktop: one-click install (`.mcpb`)

Claude Desktop users can skip the JSON entirely. Grab
`sap-fiori-timesheet-mcp-<version>.mcpb` (from releases, or `pnpm build:mcpb`) and
double-click it, drag it onto the Claude Desktop window, or use **Settings → Extensions →
Advanced settings → Install Extension**. Claude Desktop shows a permissions screen and
renders a settings form (launchpad URL, optional SSO email/password kept in the OS
keychain, SAP client, language). No terminal, no config file.

The bundle carries the whole server pre-built; only the headless-login browser (~150 MB) is
fetched on your machine the first time you log in. Full details, the config fields, and how
the bundle is built: **[docs/mcpb.md](docs/mcpb.md)**.

## Install (for anyone on the team)

Prerequisites: Node.js 20 or newer (`node --version`). No SAP or Playwright
setup is needed: the headless browser used for the SSO login is downloaded
automatically the first time you log in.

```bash
git clone https://github.com/arno-vel-bept/sap-fiori-timesheet-mcp.git
cd sap-fiori-timesheet-mcp
npm install && npm run build     # or: pnpm install && pnpm build
npm link                         # puts xflow-timesheet / xflow-timesheet-mcp on your PATH
```

> `npm install -g git+https://…` is intentionally not the documented path:
> npm's global git-dependency install has a known issue (npm/cli#2919 and
> related reports) where the installed package can end up as a dangling
> symlink into a temp cache directory npm deletes right after — unrelated to
> this package's build. Clone + `npm link` above is reliable and takes the
> same two commands. A packaged tarball (`npm run build && npm pack`, then
> `npm install -g xflow-timesheet-<version>.tgz` on the target machine) also
> works if you'd rather hand someone a single file.

Then, once:

```bash
xflow-timesheet sso              # sign in once in a real browser window (password + 2FA never touch the tool)
xflow-timesheet install-mcp --client claude-code     # or: claude-desktop | cursor | vscode
xflow-timesheet doctor           # checks Node, session, browser profile and the MCP registrations
```

`install-mcp` edits the client's own config file (a `.bak` copy is kept), for
example `~/Library/Application Support/Claude/claude_desktop_config.json`,
`~/.cursor/mcp.json`, `~/.claude.json` or VS Code's user `mcp.json`. Restart
the client afterwards. Use `--print` to get the JSON snippet instead, or
`--config-path <file>` for a project-level config. On Windows/Linux the
standard locations of each client are used.

The SAP session lives in `~/.config/xflow-timesheet/session.json`; the
identity-provider sign-in is remembered in a persistent browser profile at
`~/.config/xflow-timesheet/profile`. When the SAP session expires it is
renewed **silently** through that profile — no form, no 2FA — for as long as
the identity provider still remembers the browser. Only when that is gone do
you sign in again. The MCP `sso_login` tool does the same from an agent.

## Authentication

xflow sits behind Microsoft Entra ID SSO with 2FA. The design keeps **two**
things with different lifetimes apart (see [specs/mcp-sso-design.md](specs/mcp-sso-design.md)):

- the short-lived **SAP session cookies** are written to
  `~/.config/xflow-timesheet/session.json` (mode 0600) and authenticate OData calls;
- the long-lived **identity-provider session cookie** lives only inside the
  persistent Chromium profile at `~/.config/xflow-timesheet/profile` (mode 0700).
  It is what lets the identity provider re-issue an SAP session without showing
  a login form.

```bash
# sign in once in a real browser window — you type the password and 2FA there,
# the tool never sees them. It answers "Stay signed in?" itself.
xflow-timesheet sso

# renew without ever opening a window (fails with exit 3 if a sign-in is needed)
xflow-timesheet sso --no-interactive

# compatibility: drive the form headlessly with credentials (prefer `sso`)
xflow-timesheet login -e you@bearingpoint.com -p '…'
XFLOW_EMAIL=you@bearingpoint.com XFLOW_PASSWORD=… xflow-timesheet login
xflow-timesheet login --headed                 # watch the browser
xflow-timesheet login --debug-dir ./sso-debug  # dump the IdP page on failure

xflow-timesheet session status        # what is stored + whether the identity is remembered
xflow-timesheet logout                # delete the SAP session (keeps the remembered identity)
xflow-timesheet logout --forget-identity   # also delete the browser profile (full sign-in next time)
```

Ordinary commands (`whoami`, `std …`, `mp …`) renew an expired SAP session
silently on their own; you only run `sso` when the identity provider has
forgotten the browser.

2FA handling:

- **Code entry** (authenticator TOTP / SMS): the tool prints the on-screen text
  and asks for the code. A wrong code is re-prompted.
- **Number matching** (Authenticator push): the tool prints the number to
  enter in the app and waits for the approval.
- **Method chooser** ("Verify your identity"): the verification-code option is
  picked when offered, otherwise the Authenticator push.
- Passwordless-first tenants: "Use your password instead" is selected.
- ADFS-style federated forms (`#passwordInput` / `#submitButton`) are handled.
- "Stay signed in?" is answered *Yes* so the SSO cookie lasts longer.

If the flow lands on a page the tool does not know it says so after 3 s
(`Waiting on unrecognized page "…"`) and, with `--debug-dir`, saves a
screenshot and the HTML of that page. Ctrl-C also saves them before exiting.

Exit codes: `0` success, `1` usage/no session, `2` login rejected by the IdP
(bad email/password, timeout).

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `XFLOW_LAUNCHPAD_URL` | Fiori launchpad URL (also determines the SAP host) | `https://xflow.bearingpoint.com/fiori/shells/abap/FioriLaunchpad.html#Shell-home` |
| `XFLOW_SESSION_FILE` | where the SAP session cookies are stored | `~/.config/xflow-timesheet/session.json` |
| `XFLOW_PROFILE_DIR` | persistent browser profile that remembers the identity-provider sign-in | `~/.config/xflow-timesheet/profile` |
| `XFLOW_BROWSER_CHANNEL` | Playwright browser channel: `chromium` (bundled) or `chrome` (installed Google Chrome; some IdPs throttle automation-flavoured Chromium) | `chromium` |
| `XFLOW_EMAIL` / `XFLOW_PASSWORD` | credentials for the compatibility `login` command | prompted |
| `XFLOW_LANGUAGE` | SAP logon language | `EN` |

## Troubleshooting and reporting a bug

Every failure is meant to be reportable as is: the error text names the exact request SAP refused,
what it answered, and which cookies (names only, never values) were involved.

- **MCP tools** return the message followed by a `Diagnostics: {…}` JSON object, and `session_status`
  returns the same object as `diagnostics` next to `reason` when it is not logged in.
  `diagnostics.kind` is one of `no_cookies`, `redirect`, `unauthorized`, `login_page`,
  `cookies_rejected` (the launchpad was reached but the OData probe refused the exported cookies:
  the object carries the probe response, the number of attempts, the exported cookie names and what
  the browser itself got for the same URL) and `needs_sign_in` (what the silent refresh saw: the
  sign-in form and where, a timeout, or no browser profile).
- **The MCP server logs to stderr**: one line per tool call with its duration and outcome, plus every
  step of the session check (`auth: …`). Claude Desktop keeps it in
  `~/Library/Logs/Claude/mcp-server-SAP Fiori Timesheet (xflow).log` (macOS) or
  `%APPDATA%\Claude\logs\mcp-server-SAP Fiori Timesheet (xflow).log` (Windows).
- **The CLI** prints the same message and a `Diagnostics:` line to stderr (exit code 3 for a session
  problem, 4 for an SAP error).
- When the probe refuses a freshly exported session, the rejected cookies stay in the session file
  (`~/.config/xflow-timesheet/session.json`, mode 0600) so their names, paths and attributes can be
  inspected. Delete it with `xflow-timesheet logout`.

A useful report contains: the `Diagnostics` object, the `auth:` and `tool …` lines from the log
around the failure, the version (`session_status` prints it), and how the session was obtained
(`sso_login`, `login_start`, CLI). Cookie values, passwords and one-time codes are never logged —
do not add them.

## User guide

[docs/user-guide.md](docs/user-guide.md) walks through every user flow of
[specs/user-flows-timesheets.md](specs/user-flows-timesheets.md) with concrete
CLI and MCP examples.

## CLI

All commands read the stored session; add `--json` for machine-readable
output. Dates are `YYYY-MM-DD`; `--from/--to` default to the current month.
Every writing command accepts `--dry-run` (print the plan, write nothing).

### Standard timesheet (`std`)

```bash
xflow-timesheet std days                            # every working day: filled / MISSING, hours, entries
xflow-timesheet std open-days                       # only the days still missing hours
xflow-timesheet std jobcodes [0010 900140]          # which jobcodes the range contains (days, hours, share)
xflow-timesheet std staffing [--apply]              # MDS staffing plan; --apply books it on open days
xflow-timesheet std entries --from 2026-09-01 --to 2026-09-30
xflow-timesheet std calendar                        # target hours / period status per day
xflow-timesheet std info                            # profile, release settings
xflow-timesheet std favorites
xflow-timesheet std attendance-types [Holiday]      # AWART codes (query = case-sensitive substring)
xflow-timesheet std chargeable-orders [Globex]      # sales orders (RKDAUF) with client/partner/manager
xflow-timesheet std non-chargeable-orders [NovaLabs]   # receiver orders (RAUFNR)
xflow-timesheet std sales-order-items 3141993       # items (RKDPOS) of a sales order
xflow-timesheet std worklist

# book 8h on several days — non-chargeable order + attendance type
xflow-timesheet std fill 2026-09-03 2026-09-04 --order 900140 --attendance-type 0081 --hours 8 --short-text "dev"
# a working-day range, from a favorite (its default hours)
xflow-timesheet std fill 2026-09-08..2026-09-12 --favorite Holiday
# --no-release omits the release flag; note that auto-approving profiles (ReleaseDirectly) approve on save anyway
# chargeable work
xflow-timesheet std fill 2026-09-15 --sales-order 3141993 --sales-order-item 000401 --attendance-type 0800 --hours 8
# make days contain exactly one item (existing entries on them are deleted first)
xflow-timesheet std set 2026-09-08..2026-09-12 --order 900140 --attendance-type 0081
# quick action: fill every open day of the range with its missing hours
xflow-timesheet std fill-open --attendance-type 0077

xflow-timesheet std update 000054598801 2026-09-01 --attendance-type 0800 --sales-order 3136787 --sales-order-item 000401 --hours 4
xflow-timesheet std remove 000054598801 000054598802   # by counter (see `std entries`)
xflow-timesheet std favorite add "Admin day" --attendance-type 0077 --hours 8
xflow-timesheet std favorite remove <id>
```

### Multiproject timesheet (`mp`)

```bash
xflow-timesheet mp months                 # months with status / totals
xflow-timesheet mp month 2026-09          # projects x days grid
xflow-timesheet mp favorites
xflow-timesheet mp stats 2026-09 [--from --to]   # projects in a day/range/month with hours and %
# allocate hours per day to a project (column created if new; 0 clears a day)
xflow-timesheet mp allocate 2026-09 --order 900140 --attendance-type 0081 --day 2026-09-03=4 --day 2026-09-04=8 --text "dev"
xflow-timesheet mp allocate 2026-09 --attendance-type 0077 --range 2026-09-08..2026-09-12 --hours 2
# several projects per day over a range in one save
xflow-timesheet mp plan 2026-09 --range 2026-09-08..2026-09-12 --slot order=900140,attendance=0081:2 --slot attendance=0077:6
# rewrite a range to proportions of the target hours (--mode whole-days | every-day; preview with --dry-run)
xflow-timesheet mp balance 2026-09 --range 2026-09-01..2026-09-12 --slot order=900140,attendance=0081:60% --slot attendance=0077:40% --dry-run
xflow-timesheet mp clear 2026-09 --order 900140 --attendance-type 0081 --dates 2026-09-03,2026-09-04
```

Exit codes: `0` ok · `1` usage / no session · `2` login rejected · `3` session
expired (run `login` again) · `4` SAP rejected something (details printed; with
`fill`, per-day results are still printed).

### Exploration

```bash
xflow-timesheet whoami                                   # checks the session against SAP
xflow-timesheet http get '/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/$metadata'
pnpm exec tsx scripts/record-traffic.ts '#StandardTimesheet-manage' out.json   # record an app's OData traffic
```

## MCP server

The package's `bin` includes an entry literally named `sap-fiori-timesheet-mcp`
(matching the published npm package), so `npx sap-fiori-timesheet-mcp` runs the
MCP server directly with no subcommand — the same pattern as `@playwright/mcp`.
`xflow-timesheet-mcp` is an alias of the same launcher for local/global installs.

`xflow-timesheet install-mcp --client <client> [--npx]` registers it for you:
without `--npx` it points at the binary on your PATH (or `node <checkout>/bin/xflow-timesheet-mcp.js`
from a repo checkout); with `--npx` it writes an npx-based entry instead
(see the [npx section](#use-via-npx-fastest-no-install) above):

```json
{
  "mcpServers": {
    "xflow-timesheet": { "command": "/usr/local/bin/xflow-timesheet-mcp", "args": [] }
  }
}
```

VS Code uses `"servers"` with `"type": "stdio"`. Claude Code users can also run
`claude mcp add --scope user xflow-timesheet -- xflow-timesheet-mcp`.

Tools: `session_status`, `login_start` / `login_submit_otp` / `login_wait`,
`logout`, `std_info`, `std_days`, `std_open_days`, `std_calendar`, `std_entries`,
`std_jobcodes`, `std_staffing`, `std_staffing_apply`, `std_favorites`,
`std_favorite_add`, `std_favorite_remove`, `std_attendance_types`,
`std_chargeable_orders`, `std_non_chargeable_orders`, `std_sales_order_items`,
`std_worklist`, `std_fill`, `std_set`, `std_fill_open`, `std_update`, `std_remove`,
`mp_months`, `mp_month`, `mp_stats`, `mp_favorites`, `mp_allocate`,
`mp_allocate_many`, `mp_balance`, `mp_clear`.

Login through MCP: `login_start {email, password}` returns `otp_required`
(then `login_submit_otp {code}`), `number_match` (approve in the Authenticator
app, then `login_wait`) or `done`. The agent should ask the user for the code;
credentials are never persisted, only the resulting SAP cookies.

`email` and `password` are optional on `login_start`: set `XFLOW_EMAIL` and
`XFLOW_PASSWORD` in the MCP server's `env` block (see `.env.example`) and an
agent can call `login_start` with no arguments at all — useful when the same
account always logs in and you don't want the agent asking for credentials
each time. An explicit `email`/`password` argument always overrides the env
value. The 2FA code still has to come from a live prompt (login_submit_otp /
login_wait), since it changes every time.

## How it talks to SAP

See [docs/api-notes.md](docs/api-notes.md) for the recorded OData protocol of
both apps (entity sets, filters, the `$batch` write format, the CATS lock).

## Development

Test-driven: every feature starts with a failing test.

```bash
pnpm test          # all tests (fake IdP login flow, fake SAP services, CLI, MCP)
pnpm typecheck
```

Fixtures: `test/fixtures/fake-idp.ts` (Entra ID pages), `test/fixtures/fake-xflow.ts`
(in-memory imitation of the three SAP services with realistic shapes, used by
the domain, CLI and MCP tests).

The SSO flow is tested against `test/fixtures/fake-idp.ts`, a small HTTP server
that reproduces the Entra ID pages and element ids (`loginfmt`, `passwd`,
`otc`, `idSIButton9`, `idRichContext_DisplaySign`, …) and a fake launchpad that
sets cookies once the handshake completes. No real credentials are needed to
run the suite.

### Layout

```
src/auth/sso-login.ts     Playwright state machine for the Entra ID handshake
src/auth/login-flow.ts    step-wise wrapper (start / submitOtp) for MCP clients
src/auth/prompts.ts       terminal CredentialProvider (hidden password input)
src/auth/session-store.ts cookie persistence + Cookie header builder
src/sap/client.ts         cookie-authenticated HTTP client (CSRF, OData errors, expiry)
src/sap/odata.ts          OData v2 helpers ($filter, dates, $batch)
src/timesheet/standard.ts     Standard timesheet domain client
src/timesheet/multiproject.ts Multiproject timesheet domain client (+ lock.ts)
src/cli/main.ts           commander CLI (runCli() is testable in-process)
src/cli/timesheet-commands.ts std / mp commands
src/mcp/server.ts         MCP tools (createMcpServer()), run.ts = stdio entry
src/config.ts             env/flag resolution
```
