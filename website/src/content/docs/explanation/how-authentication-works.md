---
title: How authentication works
description: Why the tool never needs your password, what "silent renewal" means, and what the two files on your disk are for.
sidebar:
  order: 1
---

<span class="doc-kind">Explanation</span>

The SAP portal does not have its own passwords. It sits behind the company's identity provider (at BearingPoint: Microsoft Entra ID with two-factor authentication) and uses SAML: the browser is bounced from SAP to the identity provider, you sign in there, and the identity provider posts a signed assertion back to SAP, which then issues its own session cookies. Every OData call the tool makes is authenticated by those SAP cookies.

The interesting question is not how to get the cookies once; it is how to keep getting them without asking you to sign in every few hours.

## Two cookies, two lifetimes

| Cookie | Lives on | Typical lifetime | Role |
| --- | --- | --- | --- |
| SAP session (`SAP_SESSIONID_<SID>_<client>`) | the SAP host | hours | authenticates OData calls |
| Identity-provider session | the identity provider's host | days to weeks, longer with "Stay signed in?" | lets the identity provider re-issue a SAML assertion **without showing a login form** |

When the SAP session expires, a browser that still holds a valid identity-provider cookie can run the whole redirect dance again and land back on SAP with fresh cookies, with no form and no second factor. That is what your normal browser does when you open the portal in the morning. The tool does exactly the same thing, in a browser it owns.

So the thing worth remembering is the identity-provider cookie, not the SAP one. The SAP cookies are a by-product that can be regenerated.

## Why a browser profile, not a cookie file

An earlier design tried to harvest cookies into a file and inject them back into a fresh browser. That breaks in practice: Playwright's exported state only contains cookies for origins the page actually visited, `HttpOnly` and host-only scoping gets mangled on the way, and some identity providers reject a cookie that arrives from what looks like a new client.

Instead the tool keeps an entire, dedicated Chromium **profile** on disk (`~/.config/xflow-timesheet/profile`, mode 0700) and opens it with Playwright's persistent context. The cookie jar, identity-provider cookie included, survives across runs on its own. The tool stops managing cookies and manages a browser profile, which is what the "instant" single-sign-on tools do too.

The profile is dedicated to this tool. It is never your day-to-day Chrome profile, so the tool cannot touch your other sessions and they cannot touch it.

## What happens on every command

Every CLI command and every MCP tool goes through the same four steps, and stops at the first one that works:

1. **Cached.** The cookies in `session.json` are sent to the Standard timesheet OData service. If SAP answers with data, done. A successful probe is trusted for one minute before it is repeated.
2. **Silent.** The profile is opened headless and navigated to the launchpad. If the identity provider still recognises its cookie, it auto-posts a fresh assertion and the page lands on SAP within about twenty seconds. The new SAP cookies are exported to `session.json`, done. Nothing is shown on screen. If a login form appears instead, this step gives up immediately.
3. **Credentials** (only when you have chosen that mode). The form is filled with the email and password from the environment, and you are asked live for the second factor.
4. **Interactive.** The same profile is opened with a visible window on the launchpad URL. You sign in on the identity provider's genuine page; the tool types nothing. When the page reaches SAP, the cookies are exported and the window closes. The CLI `sso` command and the MCP `sso_login` tool are the only entry points allowed to take this step; a plain data command fails with exit code 3 instead, so nothing pops up in the middle of a script.

Step 4 is the only one you ever see, and it happens roughly once per identity-provider session, plus whenever you change your password.

## Two details that matter

**Liveness is measured on the OData tier.** SAP's `/sap/bc/ui2/start_up` endpoint accepts a session that the OData services still reject, because it authenticates off the SSO ticket alone. The tool therefore probes the timesheet service root, and after a fresh sign-in it re-exports the cookies a few times until they authenticate a real data call, so a half-issued session is never stored as "logged in".

**"Stay signed in?" is answered *Yes*.** The checkbox is detected by its element id, which does not change with the page language, and ticking it is what stretches the identity-provider cookie from a day to weeks.

## What this means for you

- You sign in once in a window. After that the tool works for weeks without showing anything.
- Your password is typed only into the identity provider's own page, in a browser window on your screen. It never passes through the tool, the assistant, or a configuration file (unless you opt into credential mode).
- Two things on your disk are sensitive: the SAP session file and the browser profile. Both are as good as a logged-in browser. [Security](/sap-fiori-timesheet-mcp/explanation/security/) spells out the consequences.
- Only one process can hold the profile at a time. Two hosts that run the tool concurrently need two profiles.
