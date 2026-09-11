---
title: Architecture
description: How the code is organised, how the CLI and the MCP server share one engine, how the bundle is built, and how it is tested.
sidebar:
  order: 5
---

<span class="doc-kind">Explanation</span>

## One engine, two front ends

```
src/auth/sso-login.ts         Playwright state machine for the identity-provider handshake
src/auth/session-manager.ts   cached → silent → credentials → interactive; single-flight, profile lock
src/auth/browser.ts           persistent Chromium profile, first-run browser install
src/auth/login-flow.ts        step-wise wrapper (start / submitOtp / wait) for the MCP login tools
src/auth/session-store.ts     session.json (0600) and Cookie header building
src/sap/client.ts             cookie-authenticated HTTP client: CSRF token, OData errors, expiry detection
src/sap/odata.ts              OData v2 helpers ($filter, dates, $batch)
src/timesheet/standard.ts     Standard timesheet domain client
src/timesheet/multiproject.ts Multiproject domain client (+ lock.ts)
src/cli/main.ts               Commander CLI; runCli() is testable in-process
src/cli/timesheet-commands.ts std and mp commands
src/mcp/server.ts             MCP tools (createMcpServer()); run.ts is the stdio entry
src/config.ts                 environment and flag resolution
```

The CLI and the MCP server are thin: both resolve the configuration, obtain a session from the `SessionManager`, build a `SapClient`, and call the same domain classes. A CLI command and its MCP tool therefore return the same structure (`--json` on the CLI shows it). The one deliberate difference is who may open a sign-in window: the CLI's `sso` command and the MCP `sso_login` tool, nothing else.

## The SAP client

`SapClient` sends the stored cookies, appends `sap-language` and `sap-client` when configured, fetches a CSRF token before mutations and retries once when SAP answers `403` with `x-csrf-token: Required`. It decides that a session is gone by **outcome**, not by cookie expiry: a redirect to the identity provider, a `401`, or an HTML body that looks like a login page all raise `SessionExpiredError`, which the session manager turns into a silent renewal. Reads are retried once after that; writes are not, to avoid double-applying a half-finished batch.

## The MCP server

`createMcpServer()` registers the tools with zod input schemas (the same definitions the [MCP tools reference](/sap-fiori-timesheet-mcp/reference/mcp-tools/) describes) and a short instruction text that tells assistants the intended workflow. Stdout is the JSON-RPC channel, so everything else, including Playwright's browser-download progress bar, is routed to stderr. A test drives the bundled entry point over raw stdio and asserts that stdout contains only well-formed JSON-RPC.

## The MCPB bundle

`scripts/build-mcpb.mjs` produces the Claude Desktop extension:

1. esbuild bundles `src/mcp/run.ts` into one ESM file, `server/index.js`, with everything inlined except Playwright.
2. A `package.json` pinning the exact Playwright version is written next to it and `npm install --omit=dev` runs there, so the bundle carries a real, flat `node_modules` for Playwright (it spawns its own CLI and cannot be inlined). `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` keeps the 150 MB browser out of the archive.
3. `manifest.json`, `icon.png`, `LICENSE` and `.mcpbignore` are copied.
4. `mcpb validate`, then `mcpb pack`.

The manifest declares the settings form (launchpad URL, optional email and password, SAP client, language) and maps each field to an environment variable. Claude Desktop expands every field, so a blank one arrives as an empty string; the configuration code treats blank and unset alike. `manifest.json`, `package.json` and `src/version.ts` must carry the same version, and the tool list in the manifest must equal what the server registers; a test enforces both.

The bundle is platform-independent (plain JavaScript plus the pure-JavaScript Playwright package), so CI builds it once on Linux.

## CI and releases

`.github/workflows/ci.yml` runs type-checking and the unit tests on Ubuntu, macOS and Windows (the sign-in tests drive a real headless Chromium), builds the bundle, and on a push to `main` that changes `package.json`'s version creates a GitHub release with the `.mcpb` attached and publishes the package to npm with provenance. Shipping a version is therefore a version bump in the three files, a commit and a push.

## Tests

Development is test-driven; every feature starts with a failing test. Two fixtures make that possible without any real credentials:

- `test/fixtures/fake-idp.ts`: a small HTTP server that reproduces the Entra ID pages and element ids (`loginfmt`, `passwd`, `otc`, `idSIButton9`, `idRichContext_DisplaySign`, …) and a fake launchpad that sets cookies once the handshake completes.
- `test/fixtures/fake-xflow.ts`: an in-memory imitation of the three SAP services with realistic shapes, used by the domain, CLI and MCP tests.

```bash
pnpm test        # everything
pnpm test:unit   # without the end-to-end tests that need a real system
pnpm typecheck
```

`test/e2e/real-xflow.test.ts` runs against the real portal when a session is available and is excluded from CI.
