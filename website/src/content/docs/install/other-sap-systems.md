---
title: Use it with another SAP system
description: Point the tool at your own SAP Fiori launchpad instead of BearingPoint's portal, and what must hold for it to work.
sidebar:
  order: 4
---

<span class="doc-kind">How-to guide</span>

The tool defaults to BearingPoint's "xflow" portal, but every part of it that is specific to that system is a setting. To use it against another SAP Fiori deployment:

## 1. Set the launchpad URL

The SAP host is derived from the launchpad URL. Give the full URL of your Fiori launchpad, including the `#Shell-home` fragment if your system uses one.

| Where you run it | How to set it |
| --- | --- |
| Claude Desktop (`.mcpb`) | The **Fiori launchpad URL** field of the extension settings. |
| Any other MCP client | An `env` block in the server entry: `"env": { "XFLOW_LAUNCHPAD_URL": "https://fiori.example.com/sap/bc/ui2/flp#Shell-home" }` |
| CLI | `export XFLOW_LAUNCHPAD_URL=…` in your shell profile, or the `--launchpad-url` flag on any command. (The repository's `.env.example` lists the variables; the tool does not read a `.env` file itself.) |

## 2. Optionally pin the SAP client and language

If your system needs a specific client (`sap-client`) or logon language, set `XFLOW_SAP_CLIENT` (for example `006`) and `XFLOW_LANGUAGE` (default `EN`) the same way. Both are appended as query parameters to every request.

## 3. Sign in and check

```bash
xflow-timesheet sso
xflow-timesheet whoami
xflow-timesheet std info
```

`whoami` prints the host it talked to; `std info` shows the personnel number and the data-entry profile SAP assigned to you.

## What must hold true

The tool is generic to the *apps*, not to every SAP system. It expects:

- The Fiori launchpad to host the **Standard timesheet** (`#StandardTimesheet-manage`, OData service `ZHCM_TIMESHEET_MAN_SRV`) and, for the `mp` commands, the **Multiproject timesheet** (`#MultiprojectTimesheet-manage`, service `ZHCM_TIMESHEET_MAN_V2_SRV_01` plus the `ZB_LOCK_SRV` lock service). These are custom (`Z`) services, so a system without them will not work. See the [OData reference](/sap-fiori-timesheet-mcp/reference/sap-odata/).
- Sign-in through a browser page the tool can recognise. The interactive `sso` flow works with **any** identity provider, because you do the typing. The silent renewal and the credential-based `login` command recognise Microsoft Entra ID and ADFS-style forms. What that means for other identity providers is discussed in [What is supported today](/sap-fiori-timesheet-mcp/explanation/supported-today/).

The attendance-type and order codes are yours, not the ones in these pages' examples. Find them with `std attendance-types`, `std chargeable-orders` and `std non-chargeable-orders` (see [Jobcodes and codes](/sap-fiori-timesheet-mcp/reference/jobcodes/)).
