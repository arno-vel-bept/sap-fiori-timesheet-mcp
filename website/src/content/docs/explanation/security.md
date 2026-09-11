---
title: Security
description: What leaves your machine, what stays on it, what someone with access to it could do, and how to keep the risk small.
sidebar:
  order: 2
---

<span class="doc-kind">Explanation</span>

## What leaves your machine

Exactly two destinations: your SAP host, and your identity provider during a sign-in. Both are the same hosts your browser talks to when you open the portal. There is no telemetry, no relay, no third-party service. When you use the MCP server with a hosted AI assistant, the *results* of tool calls (your entries, your hours, order names) go to that assistant like any other message in the conversation; the tool itself does not send anything to the assistant's provider.

## What stays on your machine

| What | Where | Sensitivity |
| --- | --- | --- |
| SAP session cookies | `~/.config/xflow-timesheet/session.json`, mode 0600 | Anyone who reads this file can act as you on SAP until the session expires (hours). |
| Identity-provider session, inside a browser profile | `~/.config/xflow-timesheet/profile/`, mode 0700 | Anyone who copies this directory has a browser that is signed in as you at the identity provider, for as long as that session lasts (days to weeks). That is the same exposure as your own browser profile. |
| Your password | nowhere, in the default `sso` flow | |

Recommendations that follow:

- Keep the profile on a local, full-disk-encrypted drive. Never in a synced folder (iCloud Drive, OneDrive, Dropbox) and never in a repository.
- On a shared or borrowed machine, run `xflow-timesheet logout --forget-identity` (or ask the assistant to log out and forget the identity) when you are done. It deletes both files.
- Move the two paths with `XFLOW_SESSION_FILE` and `XFLOW_PROFILE_DIR` if your organisation has a policy for such material.

The tool never logs cookies, tokens or full redirect URLs (SAML parameters and session ids travel in URLs); errors mention hosts and status codes only.

## Credential mode

The `login` command and the `login_start` tool accept an email and password and drive the identity provider's form themselves. This is a compatibility path, kept for unattended set-ups. Its cost:

- The password passes through the tool's process memory and, when supplied through an MCP `env` block, sits **in clear text in the client's JSON configuration file**. Claude Desktop's extension settings are the exception: the password field is marked sensitive and Claude Desktop keeps it in the OS keychain, handing it to the server only as an environment variable at start-up.
- The second factor still comes from you, live, each time; nothing about it is stored.
- The tool never writes the password to disk, and the browser profile does not contain it either (the identity provider only sets session cookies).

If you can use `sso`, use `sso`. The design document in the repository (`specs/mcp-sso-design.md`) states the intent: the credential path is to be deprecated.

## Using it through an AI assistant

The MCP server does what the assistant asks, and the assistant does what you ask, in that order. Two habits keep this safe:

- **Ask for a dry run before a write**, and read it. The writing tools that reshape several days have one (`std_set`, `std_fill_open`, `std_staffing_apply`, `mp_allocate_many`, `mp_balance`); `std_fill` only adds and has none, so look at `std_days` first. The assistant will happily do the dry run first if you ask once per conversation.
- **Treat what the assistant reads as data.** Everything the tool returns comes from your own SAP system, so it is trustworthy in practice; still, an assistant that also reads e-mails or web pages in the same conversation could be steered by that content. Keep the timesheet conversation focused, and confirm writes yourself.

The tool acts only on tool calls. It never executes anything found in page content, order descriptions or notes.

## The software itself

- The `.mcpb` bundle is not code-signed; Claude Desktop shows an "unverified" note. The bundle is built by the project's CI from the tagged source, and you can build it yourself with `pnpm build:mcpb` and compare.
- The `npx -y sap-fiori-timesheet-mcp@latest` form fetches the latest published version every time the client starts. Pin a version (`sap-fiori-timesheet-mcp@0.5.1`) if your organisation prefers reviewed updates. A local install from a clone gives you the same control.
- The headless browser is Chromium as packaged by Playwright, downloaded from Playwright's CDN at the first sign-in. Set `XFLOW_BROWSER_CHANNEL=chrome` to use your already-installed Google Chrome instead and skip the download.
- Dependencies are few on purpose: the MCP SDK, Commander, Playwright, tough-cookie and zod.

## Reporting a problem

Open an issue at the project's GitHub repository. For anything that looks like a security weakness, contact the maintainer directly rather than filing it publicly.
