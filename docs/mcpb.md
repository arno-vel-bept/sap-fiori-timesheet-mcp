# Claude Desktop one-click install (`.mcpb`)

[MCPB](https://github.com/modelcontextprotocol/mcpb) ("MCP Bundle", formerly DXT) is a
zip archive containing a local MCP server plus a `manifest.json`. Claude Desktop installs
one in a single click — no terminal, no hand-editing `claude_desktop_config.json`.

This repo ships a bundle for the SAP Fiori timesheet MCP server. It contains the whole
server pre-built into one file, its one un-bundleable dependency (Playwright, for the SSO
login), and the manifest. The Chromium binary itself is **not** in the bundle — it is
downloaded once (~150 MB) on your machine the first time you log in.

## Install

1. Download `sap-fiori-timesheet-mcp-<version>.mcpb` (from the project's releases, or build
   it yourself — see below).
2. Install it into Claude Desktop any of these ways:
   - double-click the file, or
   - drag it onto the Claude Desktop window, or
   - **Settings → Extensions → Advanced settings → Install Extension…**
3. The install screen shows the name, author, and the permissions it needs. Review and
   confirm.
4. Fill in the configuration (Claude Desktop renders a form from the manifest):

   | Field | Required | Notes |
   | --- | --- | --- |
   | **Fiori launchpad URL** | yes | Defaults to BearingPoint's xflow portal. The SAP host is derived from it. Point it at your own Fiori launchpad for any other SAP system. |
   | **SSO email** | no | Set it so the `login_start` tool can run without asking each time. Never written to disk. |
   | **SSO password** | no | Stored in the OS keychain by Claude Desktop, handed to the server only as an environment variable. Leave blank to type it at login time. |
   | **SAP client** | no | e.g. `006`, if your system needs one pinned. |
   | **Logon language** | no | Two-letter code, default `EN`. |

5. Restart Claude Desktop if it doesn't pick the server up immediately. The 34 tools then
   appear under the tools icon.

## First login

The server signs in through Microsoft Entra ID SSO with a headless browser. The first time
you call `login_start` (or `xflow-timesheet login` on the CLI), Playwright downloads
Chromium — about 150 MB — into `~/Library/Caches/ms-playwright` (shared across every install
and update). That download can take longer than Claude Desktop's per-tool-call timeout, in
which case the `login_start` call fails with a timeout; the download keeps going in the
background, so **just call `login_start` again a minute or two later** and it will proceed
past the (now cached) browser.

After a successful login the SAP session cookies are cached in
`~/.config/xflow-timesheet/session.json` (mode 0600) and reused for every OData call. The
2FA step (code entry or Authenticator number-match) is always live — `login_start` returns
`otp_required` / `number_match` and you answer with `login_submit_otp` / `login_wait`.
Credentials are never persisted; only the resulting cookies are.

## Build the bundle yourself

```bash
pnpm install
pnpm build:mcpb          # -> build/sap-fiori-timesheet-mcp-<version>.mcpb
```

`scripts/build-mcpb.mjs`:

1. esbuilds `src/mcp/run.ts` into `build/mcpb/server/index.js` (one ESM file; everything
   except Playwright is inlined).
2. writes `build/mcpb/package.json` pinning the exact Playwright version this repo resolved,
   then runs `npm install --omit=dev` in that directory so the bundle carries a real, flat
   `node_modules` (no pnpm symlinks). `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` keeps the Chromium
   binary out of the bundle.
3. copies `manifest.json`, `icon.png`, `LICENSE`, `.mcpbignore`.
4. runs `mcpb validate` then `mcpb pack`.

Flags: `--no-pack` stages `build/mcpb/` without packing; `--no-install` only runs the
esbuild step (used by the test suite).

`manifest.json`, `package.json`, and `src/version.ts` must all carry the same version —
`test/mcpb-manifest.test.ts` fails the build if they drift.

## Signing

`mcpb sign` / `mcpb verify` exist for code-signing a bundle. Unsigned bundles install fine
(Claude Desktop shows an "unverified" note). Signing is out of scope for this repo for now.

## Tests

- `test/mcpb-manifest.test.ts` — manifest is spec-0.3 valid, version parity, and the tool
  list in the manifest matches exactly what `createMcpServer()` registers.
- `test/mcpb-bundle.test.ts` — builds the bundle (esbuild only) and drives the bundled entry
  point over raw stdio, asserting the handshake works and **stdout contains only well-formed
  JSON-RPC** (the regression guard for anything polluting the stdio channel).
