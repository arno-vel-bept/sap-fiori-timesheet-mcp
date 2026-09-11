---
title: MCP tools
description: Every tool the MCP server exposes, with its parameters and what it returns.
sidebar:
  order: 2
---

<span class="doc-kind">Reference</span>

The server is named `xflow-timesheet` and speaks MCP over stdio. It is started by `npx sap-fiori-timesheet-mcp`, by the `xflow-timesheet-mcp` binary, or by the Claude Desktop extension. Every tool returns JSON as text content; failures are returned with `isError: true` and a message.

## Conventions

| Element | Meaning |
| --- | --- |
| `from`, `to` | Dates `YYYY-MM-DD`. Both optional; default to the first and last day of the current month. |
| `dates` | Array of `YYYY-MM-DD`. |
| `year`, `month` | Integers, for the Multiproject tools (`2026`, `9`). |
| `item` / `project` | Object `{attendanceType?, order?, salesOrder?, salesOrderItem?, shortText?}`. At least one of `attendanceType`, `order`, `salesOrder`. See [Jobcodes and codes](/sap-fiori-timesheet-mcp/reference/jobcodes/). |
| `favorite` | Favorite name (case-insensitive) or id; used instead of `item`. The favorite's default hours apply unless `hours` is given. |
| `dryRun` | `true` returns what would be booked and writes nothing. |
| `release` | Default `true`. `false` omits the release flag; auto-approving profiles ignore it. |

Session handling: before every tool the stored SAP session is checked and, if expired, renewed silently through the browser profile. **Read** tools retry once after such a renewal; **write** tools do not, so a write that hits an expired session fails with a message and must be sent again. Only `sso_login` ever opens a window.

## Session

| Tool | Input | Returns |
| --- | --- | --- |
| `session_status` | none | `{loggedIn: true, method, identityRemembered, createdAt, user: {id, fullName, client, language}}`, or `{loggedIn: false, identityRemembered, sessionFile, profileDir, reason, hint}`. `method` is `cached`, `silent`, `credentials` or `interactive`. |
| `sso_login` | none | Establishes a session: `cached` when the stored one still works, `silent` when the identity provider re-issued it without a prompt, otherwise a browser window opens for the user (up to 4 minutes). Returns `{state: "done", method, cookies, sessionFile, profileDir}`. |
| `login_start` | `email?`, `password?` (default to `XFLOW_EMAIL` / `XFLOW_PASSWORD`) | Compatibility login with credentials. `{state: "done"}`, `{state: "otp_required", prompt}` or `{state: "number_match", number}`. |
| `login_submit_otp` | `code` | Continues a login that returned `otp_required`. |
| `login_wait` | none | Continues a login that returned `number_match`. |
| `logout` | `forgetIdentity?` | Deletes the stored SAP session; with `forgetIdentity: true` also the browser profile. `{loggedOut, identityForgotten}`. |

## Standard timesheet: read

| Tool | Input | Returns |
| --- | --- | --- |
| `std_info` | none | Personnel number, data-entry profile, whether entries are released directly. |
| `std_days` | `from?`, `to?` | Every working day: `date`, `filled`, `targetHours`, `bookedHours`, `missingHours`, `entries[]`. |
| `std_open_days` | `from?`, `to?` | Only working days in open periods that still miss hours, with their entries. |
| `std_calendar` | `from?`, `to?` | Calendar days with target hours, working-day flag and period status. |
| `std_entries` | `from?`, `to?` | Entries with `counter`, `date`, `hours`, `status`, `item`. |
| `std_jobcodes` | `from?`, `to?`, `codes?` | One row per item with `days`, `hours`, `dates`, `share`. With `codes`, only those (empty = not present). |
| `std_staffing` | `from?`, `to?` | The MDS staffing plan (planned entries). |
| `std_worklist` | `from?`, `to?` | Worklist (assigned orders). |
| `std_favorites` | none | Favorites: `id`, `name`, `hours`, `item`. |
| `std_attendance_types` | `query?`, `top?`, `from?`, `to?` | Attendance / absence types (AWART). |
| `std_chargeable_orders` | `query?`, `top?`, `from?`, `to?` | Chargeable sales orders (RKDAUF) with client, partner and manager. |
| `std_non_chargeable_orders` | `query?`, `top?`, `from?`, `to?` | Non-chargeable receiver orders (RAUFNR). |
| `std_sales_order_items` | `salesOrder`, `from?`, `to?` | Items (RKDPOS) of a sales order. |

`query` is a case-sensitive substring of the description text. A numeric `query` is treated as a code and resolved even when it is not on the first page.

## Standard timesheet: write

| Tool | Input | Effect |
| --- | --- | --- |
| `std_fill` | `dates`, `item?` or `favorite?`, `hours?`, `shortText?`, `notes?`, `release?` | Books the same item on each day (one entry per day, added to what is there). Hours default to the favorite's, else 8. Returns one result per day with the counter; `isError` when any day was rejected. |
| `std_set` | `dates`, `item?` or `favorite?`, `hours?`, `shortText?`, `release?`, `dryRun?` | Makes each day contain exactly this item: existing entries on the day are deleted, then the item is booked. Returns `{removed[], created[]}`; with `dryRun` the plan. |
| `std_fill_open` | `from?`, `to?`, `item?` or `favorite?`, `maxHours?`, `shortText?`, `release?`, `dryRun?` | Books the item on every open day of the range, each with that day's missing hours, capped by `maxHours`. |
| `std_staffing_apply` | `from?`, `to?`, `dates?`, `release?`, `dryRun?` | Books the staffing plan on open days that still miss the planned hours. Returns `{created[], skipped[]}` with reasons. |
| `std_update` | `counter`, `date`, `item`, `hours`, `shortText?`, `release?` | Changes an existing entry. |
| `std_remove` | `counters`, `from?`, `to?` | Deletes entries by counter; they must lie within the range. |
| `std_favorite_add` | `name`, `item`, `hours?` | Creates a favorite. |
| `std_favorite_remove` | `id` | Deletes a favorite. |

## Multiproject timesheet

| Tool | Input | Effect |
| --- | --- | --- |
| `mp_months` | none | Months with status (`YACTION` open, `PER_CLOSED`) and totals. |
| `mp_month` | `year`, `month` | The grid: projects (columns) and days with hours per project. |
| `mp_favorites` | none | Favorites as listed by the Multiproject app. |
| `mp_stats` | `year`, `month`, `from?`, `to?` | `{totalHours, targetHours, projects: [{project, hours, days, share}], perDay}`. |
| `mp_allocate` | `year`, `month`, `project`, `days: [{date, hours, text?}]` | Sets hours per day for one project (column created if new; `hours: 0` clears the day). Returns the refreshed month. |
| `mp_allocate_many` | `year`, `month`, `slots: [{project, days?, range?: {from, to}, hours?, text?}]`, `dryRun?` | Several projects in one save; a `range` covers its working days at `hours` per day. |
| `mp_balance` | `year`, `month`, `range: {from, to}`, `slots: [{project, share}]`, `mode?`, `dryRun?` | Rewrites the working days so the projects hold the given shares (sum 100) of the target hours. `mode` is `whole-days` (default) or `every-day`. Returns the plan (`dryRun`) or the resulting stats. |
| `mp_clear` | `year`, `month`, `project`, `dates?` | Removes the project's hours on the given days (whole month if omitted). |

All Multiproject writes take the app's lock for the duration of the save and release it afterwards.

## Server instructions

The server announces a short workflow to the client: check `session_status`, call `sso_login` if needed, look with `std_days` / `std_open_days`, find codes with the `std_*_orders` and `std_attendance_types` tools, then book with `std_fill` / `std_set` / `std_fill_open` / `std_staffing_apply` or the `mp_*` tools. Assistants generally follow it without being told.
