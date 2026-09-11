---
title: Files and exit codes
description: What the tool writes to disk, where, with which permissions, and what each exit code means.
sidebar:
  order: 5
---

<span class="doc-kind">Reference</span>

## Files on disk

| Path (default) | Content | Mode | Change with |
| --- | --- | --- | --- |
| `~/.config/xflow-timesheet/session.json` | The SAP session cookies (`SAP_SESSIONID_<SID>_<client>` and related), the launchpad URL and the creation time. | `0600` | `XFLOW_SESSION_FILE`, `--session-file` |
| `~/.config/xflow-timesheet/profile/` | A dedicated Chromium profile. Its cookie jar holds the identity provider's own session cookie, which is what allows silent renewal. | `0700` | `XFLOW_PROFILE_DIR`, `--profile-dir` |
| Playwright's browser cache (macOS `~/Library/Caches/ms-playwright`, Linux `~/.cache/ms-playwright`, Windows `%LOCALAPPDATA%\ms-playwright`) | The Chromium build downloaded at the first sign-in; shared by every install on the machine. | | `PLAYWRIGHT_BROWSERS_PATH` (a Playwright variable) |
| `sso-debug/` (only with `login --debug-dir`) | Screenshot and HTML of the identity-provider page when a credential-based login fails or stalls. | | the `--debug-dir` argument |
| The MCP client's configuration file, plus a `.bak` copy (only with `install-mcp`) | The server entry. | | `--config-path` |

Nothing else is written. In particular no password, no log file, and no cookie ever appears in the output; errors mention hosts and status codes only.

## Exit codes (CLI)

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Usage error, or no session stored. |
| `2` | The identity provider rejected the login (bad email or password, cancelled, timed out). |
| `3` | The SAP session has expired and could not be renewed silently: a sign-in in a window is needed (`xflow-timesheet sso`). Also returned by `sso --no-interactive` when a window would have been needed. |
| `4` | SAP rejected something. Details are printed; with `std fill` and the other per-day commands the results of the days that succeeded are still printed. |

## MCP errors

Tools never crash the server. A failure comes back as a text message with `isError: true`. The messages you are most likely to see:

| Message starts with | Meaning |
| --- | --- |
| `The identity provider needs a fresh sign-in.` | Call `sso_login`; the user must sign in in the window. |
| `The browser profile … is already in use` | Another CLI run or MCP host holds the profile; wait, or set `XFLOW_PROFILE_DIR` per instance. |
| `A login is already in progress` | A credential login awaits `login_submit_otp` or `login_wait`. |
| `No favorite "…"` | The favorite name or id is unknown; the known names are listed. |
| `Give an item (attendance type or an order) or a favorite.` | The write tool got neither. |
| `SAP error: …` | SAP refused the request; the OData error text follows. |
| A JSON array of per-day results | A multi-day write where at least one day was rejected; each element says `ok` and the reason. |
