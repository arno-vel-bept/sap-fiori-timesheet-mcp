# xflow-timesheet

CLI and local MCP server that let a human or an AI agent work with an
**SAP Fiori** timesheet portal (originally built against BearingPoint's
internal "xflow" portal, but generic to any Fiori-based deployment of the
same *Standard timesheet* and *Multiproject timesheet* apps).

## Use via npx (fastest, no install)

Point your MCP client at the published package and set `XFLOW_LAUNCHPAD_URL`
to your own organization's Fiori launchpad URL — nothing else to install:

```json
{
  "mcpServers": {
    "xflow-timesheet": {
      "command": "npx",
      "args": ["-y", "sap-fiori-timesheet-mcp@latest"],
      "env": { "XFLOW_LAUNCHPAD_URL": "https://fiori.example.com/sap/bc/ui2/flp#Shell-home" }
    }
  }
}
```

or generate that block with `xflow-timesheet install-mcp --client <client> --npx` once you
have the CLI on your PATH (see [Install](#install-for-anyone-on-the-team) below), or just
write the JSON above by hand — npx needs nothing pre-installed. The CLI works the
same way: `npx -y -p sap-fiori-timesheet-mcp xflow-timesheet login`.

If you'll be using this against the same system every time, cloning and
building locally (below) saves you from typing `XFLOW_LAUNCHPAD_URL` each time
— set it once in your shell profile, or pass `--launchpad-url` per command.

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
xflow-timesheet login            # Microsoft SSO: email, password (hidden), 2FA code or Authenticator approval
xflow-timesheet install-mcp --client claude-code     # or: claude-desktop | cursor | vscode
xflow-timesheet doctor           # checks Node, session, browser and the MCP registrations
```

`install-mcp` edits the client's own config file (a `.bak` copy is kept), for
example `~/Library/Application Support/Claude/claude_desktop_config.json`,
`~/.cursor/mcp.json`, `~/.claude.json` or VS Code's user `mcp.json`. Restart
the client afterwards. Use `--print` to get the JSON snippet instead, or
`--config-path <file>` for a project-level config. On Windows/Linux the
standard locations of each client are used.

The SAP session lives in `~/.config/xflow-timesheet/session.json` and is what
both the CLI and the MCP server use; when it expires, `xflow-timesheet login`
again (the MCP `login_start` / `login_submit_otp` tools do the same from an agent).

## Authentication

xflow sits behind Microsoft Entra ID SSO with 2FA. The tool logs in once with a
headless browser, then stores the resulting SAP session cookies in
`~/.config/xflow-timesheet/session.json` (mode 0600) and reuses them for every
OData call.

```bash
# interactive: prompts for email, password (hidden) and the 2FA code if requested
xflow-timesheet login

# credentials as flags or env (the 2FA code is still prompted when Entra asks for one)
xflow-timesheet login -e you@bearingpoint.com -p '…'
XFLOW_EMAIL=you@bearingpoint.com XFLOW_PASSWORD=… xflow-timesheet login
xflow-timesheet login -e you@bearingpoint.com -p '…' -o 123456   # pre-supplied one-time code

# watch the browser while it logs in
xflow-timesheet login --headed

# save a screenshot + HTML of the IdP page if the login fails (unknown page, timeout)
xflow-timesheet login --debug-dir ./sso-debug

xflow-timesheet session status   # what is stored, cookie expiry
xflow-timesheet logout           # delete the stored session
```

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
| `XFLOW_LAUNCHPAD_URL` | Fiori launchpad URL (also determines the SAP host) | `https://fiori.example.com/sap/bc/ui2/flp#Shell-home` |
| `XFLOW_SESSION_FILE` | where the session cookies are stored | `~/.config/xflow-timesheet/session.json` |
| `XFLOW_EMAIL` / `XFLOW_PASSWORD` | credentials for `login` | prompted |
| `XFLOW_LANGUAGE` | SAP logon language | `EN` |

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
(needs the package published to npm — see the [npx section](#use-via-npx-fastest-no-install) above):

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
