---
title: CLI commands
description: Every xflow-timesheet command with its arguments, options and defaults.
sidebar:
  order: 1
---

<span class="doc-kind">Reference</span>

The command is `xflow-timesheet` (or `npx -y -p sap-fiori-timesheet-mcp xflow-timesheet …` without an install). `xflow-timesheet --help` and `xflow-timesheet <command> --help` print the same information.

## Global options

| Option | Effect |
| --- | --- |
| `--launchpad-url <url>` | Fiori launchpad URL (env `XFLOW_LAUNCHPAD_URL`). The SAP host is derived from it. |
| `--session-file <path>` | Where the SAP session is stored (env `XFLOW_SESSION_FILE`). |
| `--profile-dir <path>` | The browser profile that remembers the identity-provider sign-in (env `XFLOW_PROFILE_DIR`). |
| `-v, --version` | Print the version. |

Conventions shared by the commands below:

- Dates are `YYYY-MM-DD`. Where a command takes `<dates...>`, each argument may be a day, a range `a..b` (working days only unless `--include-weekends`), or a comma-separated list.
- `--from <date>` / `--to <date>` default to the first and last day of the current month.
- `--json` prints the same structure the corresponding MCP tool returns.
- `--dry-run` prints what would be booked and writes nothing. Available on `std set`, `std fill-open`, `std staffing --apply`, `mp plan` and `mp balance`.
- Item options (on every command that books): `-a, --attendance-type <code>`, `-o, --order <code>`, `-s, --sales-order <code>`, `-i, --sales-order-item <code>`; `-f, --favorite <name-or-id>` where noted. See [Jobcodes and codes](../jobcodes/).
- Every command that talks to SAP renews an expired session silently first, and fails with exit code 3 when a sign-in window would be needed. See [Files and exit codes](../files-and-exit-codes/).

## Session

| Command | Options | Description |
| --- | --- | --- |
| `sso` | `--no-interactive`, `--timeout <seconds>` (240) | Establish a session through the browser profile: silently when the identity provider still remembers the browser, otherwise in a window where you sign in yourself. `--no-interactive` never opens a window and exits 3 instead. |
| `login` | `-e, --email <email>`, `-p, --password <password>`, `-o, --otp <code>`, `--headed`, `--timeout <seconds>` (240), `--debug-dir <dir>` | Compatibility sign-in with credentials (env `XFLOW_EMAIL` / `XFLOW_PASSWORD`, otherwise prompted; the password prompt is hidden). Asks for the 2FA code when needed. `--headed` shows the browser; `--debug-dir` saves a screenshot and the HTML of the identity-provider page on failure. |
| `logout` | `--forget-identity` | Delete the stored SAP session; with the flag also the browser profile. |
| `session status` | | Whether a session is stored, which cookies it holds and when they expire, and whether the identity is remembered. Exit 1 when no session. |
| `whoami` | | Ask SAP who you are (user, name, client, language, host). Checks that the session works. |
| `doctor` | | Check Node, the session, the identity, the browser, the MCP launcher and each client's registration. Exit 1 when something is wrong. |
| `install-mcp` | `-c, --client <client>` (required: `claude-code`, `claude-desktop`, `cursor`, `vscode`), `--config-path <file>`, `--print`, `--session-file-env`, `--npx` | Register the MCP server in the client's configuration file (a `.bak` is kept). See [Other MCP clients](../../install/other-mcp-clients/). |
| `http get <path>` | `-H, --header <Name:Value...>` | Authenticated `GET` on the SAP host, for exploration. |

## Standard timesheet: `std`

### Read

| Command | Options | Description |
| --- | --- | --- |
| `std days` | range, `--json` | Every working day of the range: filled or `MISSING`, target, booked and missing hours, entries. |
| `std open-days` | range, `--json` | Only working days in open periods that still miss hours, with what is already booked. |
| `std entries` | range, `--json` | Entries with counter, date, hours, status and item. |
| `std calendar` | range, `--json` | Calendar days with target hours, working-day flag and period status. |
| `std info` | `--json` | Personnel number, data-entry profile, release settings. |
| `std jobcodes [codes...]` | range, `--json` | Which jobcodes the range contains, with days, hours, share and dates; with codes, only those (empty = not present). |
| `std staffing` | range, `--apply`, `--dates <d1,d2>`, `--no-release`, `--dry-run`, `--json` | The MDS staffing plan. `--apply` books it on open days that still miss the planned hours; `--dates` restricts the days. |
| `std worklist` | range, `--json` | Worklist (assignments). |
| `std favorites` | `--json` | Favorites with name, id, default hours and item. |
| `std attendance-types [query]` | range, `--top <n>`, `--json` | Attendance / absence types (AWART). |
| `std chargeable-orders [query]` | range, `--top <n>`, `--json` | Chargeable sales orders (RKDAUF) with client, partner and manager. |
| `std non-chargeable-orders [query]` | range, `--top <n>`, `--json` | Non-chargeable receiver orders (RAUFNR). |
| `std sales-order-items <salesOrder>` | range, `--json` | Items (RKDPOS) of a sales order. |

The query of the three value-help commands matches the description text, case-sensitively; a query that looks like a code is resolved by code even when it is not on the first page.

### Write

| Command | Options | Description |
| --- | --- | --- |
| `std fill <dates...>` | item options, `-f, --favorite`, `-h, --hours <n>`, `-t, --short-text <text>`, `-n, --notes <text>`, `--include-weekends`, `--no-release`, `--json` | Book the same item on each day, added to what is there. Hours default to the favorite's, else 8. |
| `std set <dates...>` | item options, `-f, --favorite`, `-h, --hours <n>`, `-t, --short-text <text>`, `--include-weekends`, `--no-release`, `--dry-run`, `--json` | Make each day contain exactly this item: existing entries on the day are deleted first. |
| `std fill-open` | range, item options, `-f, --favorite`, `--max-hours <n>`, `-t, --short-text <text>`, `--no-release`, `--dry-run`, `--json` | Book the item on every open day of the range, each with its missing hours (capped by `--max-hours`). |
| `std update <counter> <date>` | item options, `-h, --hours <n>`, `-t, --short-text <text>`, `--no-release`, `--json` | Change the hours and item of an existing entry. |
| `std remove <counters...>` | range, `--json` | Delete entries by counter; they must lie within the range. |
| `std favorite add <name>` | item options, `-h, --hours <n>`, `--json` | Create a favorite. |
| `std favorite remove <id>` | | Delete a favorite. |

Writing commands print one line per day with the outcome and the new counter. Exit code 4 when SAP rejected at least one day.

## Multiproject timesheet: `mp`

Months are written `YYYY-MM`.

| Command | Options | Description |
| --- | --- | --- |
| `mp months` | `--json` | Months with status and hour totals. |
| `mp month <yyyy-mm>` | `--json` | The project × day grid of a month. |
| `mp favorites` | `--json` | Favorites as seen by the Multiproject app. |
| `mp stats <yyyy-mm>` | range, `--json` | Projects a day, range or month contains, with hours, days and proportion. |
| `mp allocate <yyyy-mm>` | item options, `-d, --day <date=hours...>`, `-r, --range <from..to>`, `-h, --hours <n>`, `-t, --text <text>`, `--json` | Set hours per day for one project (column created if new; `=0` clears a day). `--range` books every working day at `--hours`. |
| `mp plan <yyyy-mm>` | `-r, --range <from..to>` (required), `-s, --slot <spec...>` (required), `-t, --text <text>`, `--dry-run`, `--json` | Several projects per day over a range in one save. Slot: `key=value[,key=value]:hours`, keys `attendance` / `att`, `order`, `salesOrder[/item]`. |
| `mp balance <yyyy-mm>` | `-r, --range <from..to>` (required), `-s, --slot <spec...>` (required, `…:share%`), `-m, --mode <whole-days\|every-day>` (whole-days), `--dry-run`, `--json` | Rewrite the working days of the range so the projects hold the given shares of the target hours; other projects' hours on those days are cleared. |
| `mp clear <yyyy-mm>` | item options, `--dates <d1,d2>`, `--json` | Remove a project's hours on the given days (whole month if omitted). |

Every `mp` write takes the app's lock for the save and releases it afterwards.

## Exploration

```bash
xflow-timesheet http get '/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/$metadata'
pnpm exec tsx scripts/record-traffic.ts '#StandardTimesheet-manage' out.json   # record an app's OData traffic (from a checkout)
```
