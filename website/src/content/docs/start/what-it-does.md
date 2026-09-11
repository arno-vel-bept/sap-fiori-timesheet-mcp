---
title: What the tool does
description: An overview of sap-fiori-timesheet-mcp, who it is for, and the two ways to use it.
sidebar:
  order: 1
---

`sap-fiori-timesheet-mcp` is a small program that runs on your own computer and talks to the SAP Fiori timesheet apps on your behalf. It was built for BearingPoint's internal SAP portal ("xflow"), and it works against any SAP Fiori system that runs the same two apps:

- the **Standard timesheet** (one entry per day and jobcode), and
- the **Multiproject timesheet** (a month grid with one column per project).

You can use it in two ways, and both share the same engine:

| | Who it is for | What it looks like |
| --- | --- | --- |
| **MCP server** | Anyone using an AI assistant such as Claude Desktop, Claude Code, Cursor or VS Code | You ask in plain language: *"Which days this month are still empty?"*, *"Book Tuesday and Wednesday on the NovaLabs order."* The assistant calls the tool. |
| **Command line (CLI)** | People who like a terminal, or want to script things | `xflow-timesheet std days`, `xflow-timesheet std set 2026-09-15 -a 0010` |

## What it can do

- Tell you which working days are already filled and which still miss hours.
- Book one or several days on a jobcode or an absence type, or change and delete existing entries.
- Tell you whether a month contains a given jobcode, how often, and what share of the hours it holds.
- Load your staffing plan (the app's *Retrieve staffing* button) and book it on the open days.
- Fill the whole open period with a single code in one command, for example the administration code.
- In the Multiproject timesheet: declare several projects per day, see the proportion each project holds, and rewrite a date range so that projects hold a target proportion (say 60% / 40%).
- Preview any write with a **dry run** before anything is sent to SAP.

## What it does on your behalf, and what it never does

- It signs you in through your company's normal single sign-on, in a browser window where **you** type your password and answer the two-factor prompt. The tool never sees the password. See [How authentication works](/sap-fiori-timesheet-mcp/explanation/how-authentication-works/).
- After that, it keeps the resulting SAP session on your machine and renews it silently for as long as your identity provider remembers the browser.
- It talks only to your SAP host. Nothing is sent anywhere else.
- It writes nothing unless you (or your assistant, on your request) call a writing command. Every writing command has a dry-run mode.

## Where to go next

- Never used it? Follow [Your first timesheet with Claude Desktop](/sap-fiori-timesheet-mcp/start/first-timesheet-claude-desktop/) or [Your first timesheet from the terminal](/sap-fiori-timesheet-mcp/start/first-timesheet-cli/).
- Installing for a team? Start with [Install for Claude Desktop](/sap-fiori-timesheet-mcp/install/claude-desktop/), the format that needs no terminal.
- Looking for a specific task? Browse the [how-to guides](/sap-fiori-timesheet-mcp/how-to/see-missing-days/).
