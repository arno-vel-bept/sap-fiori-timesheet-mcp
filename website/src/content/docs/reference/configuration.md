---
title: Configuration
description: Every setting, its default, and where to put it depending on how you run the tool.
sidebar:
  order: 3
---

<span class="doc-kind">Reference</span>

The tool reads environment variables at start-up. Nothing is required: the defaults point at BearingPoint's portal and at `~/.config/xflow-timesheet/` for local files. A variable that is set but blank — or left as an unexpanded `${user_config.…}` placeholder — counts as unset (the Claude Desktop extension passes every form field, filled or not, and depending on version an empty optional field arrives either way).

## Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `XFLOW_LAUNCHPAD_URL` | Fiori launchpad URL. The SAP host (origin) is derived from it. | `https://xflow.bearingpoint.com/fiori/shells/abap/FioriLaunchpad.html#Shell-home` |
| `XFLOW_SESSION_FILE` | Where the SAP session cookies are stored (mode 0600). | `~/.config/xflow-timesheet/session.json` |
| `XFLOW_PROFILE_DIR` | The dedicated browser profile that remembers the identity-provider sign-in (mode 0700). Keep it on a local, encrypted disk. | `~/.config/xflow-timesheet/profile` |
| `XFLOW_BROWSER_CHANNEL` | Playwright browser channel: `chromium` (bundled, downloaded at first sign-in) or `chrome` (the installed Google Chrome; some identity providers throttle automation-flavoured Chromium). | `chromium` |
| `XFLOW_EMAIL` | Account email for the credential-based `login` / `login_start`. | prompted / must be passed |
| `XFLOW_PASSWORD` | Account password for the same. Never written to disk by the tool. See [Security](/sap-fiori-timesheet-mcp/explanation/security/#credential-mode). | prompted / must be passed |
| `XFLOW_SAP_CLIENT` | SAP client (`sap-client` query parameter), if the system needs one pinned, e.g. `006`. | none |
| `XFLOW_LANGUAGE` | SAP logon language (`sap-language`), two-letter code. | `EN` |

Playwright's own `PLAYWRIGHT_BROWSERS_PATH` moves the downloaded browser cache.

The `~/.config/xflow-timesheet/` directory is used on every platform, including macOS and Windows.

## Precedence

CLI flags (`--launchpad-url`, `--session-file`, `--profile-dir`) override the environment, which overrides the defaults.

## Where to set them

| How you run the tool | Where the variables go |
| --- | --- |
| CLI | Your shell profile (`export XFLOW_LAUNCHPAD_URL=…`), or the command line. The tool does **not** read a `.env` file; the repository's `.env.example` is a template listing the variables. |
| MCP client with a JSON configuration | The server entry's `"env": { … }` block. |
| Claude Desktop extension (`.mcpb`) | The extension's settings form; each field maps to a variable (below). |

## Claude Desktop extension settings

| Form field | Variable | Required | Notes |
| --- | --- | --- | --- |
| Fiori launchpad URL | `XFLOW_LAUNCHPAD_URL` | yes | Pre-filled with BearingPoint's portal. |
| SSO email (optional) | `XFLOW_EMAIL` | no | Only for `login_start`. |
| SSO password (optional) | `XFLOW_PASSWORD` | no | Marked sensitive: Claude Desktop stores it in the OS keychain and passes it as an environment variable. |
| SAP client (optional) | `XFLOW_SAP_CLIENT` | no | |
| Logon language | `XFLOW_LANGUAGE` | no | Default `EN`. |

The extension declares compatibility with Claude Desktop 0.10 or newer, on macOS and Windows, with Node.js 20 or newer.

## MCP client configuration files

Written by `xflow-timesheet install-mcp --client <client>`, or by hand:

| Client | File | Shape |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers` map |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`; Linux `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json` | `mcpServers` map |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` map |
| VS Code | macOS `~/Library/Application Support/Code/User/mcp.json`; Windows `%APPDATA%\Code\User\mcp.json`; Linux `$XDG_CONFIG_HOME/Code/User/mcp.json` | `servers` map, entries carry `"type": "stdio"` |

The server entry is named `xflow-timesheet`. Its `command` is either `npx` with `["-y", "sap-fiori-timesheet-mcp@latest"]` (the `--npx` form), the `xflow-timesheet-mcp` binary on the PATH, or `node` with the path to `bin/xflow-timesheet-mcp.js` in a checkout.
