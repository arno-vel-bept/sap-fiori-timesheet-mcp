---
title: What is supported today
description: The environment the tool was built against, what is generic, what is BearingPoint-specific, and what would need to change for another identity provider.
sidebar:
  order: 3
---

<span class="doc-kind">Explanation</span>

The tool was built for BearingPoint's "xflow" portal and verified there. This page separates what is generic to the SAP Fiori timesheet apps from what is specific to that deployment, so that anyone bringing it to another system knows what to expect.

## The environment it was built against

| Aspect | At BearingPoint |
| --- | --- |
| SAP system | `https://xflow.bearingpoint.com`, client `006`, Fiori launchpad `…/fiori/shells/abap/FioriLaunchpad.html#Shell-home` |
| Apps | Standard timesheet (`ZHCM_TIMESHEET_MAN_SRV`) and Multiproject timesheet (`ZHCM_TIMESHEET_MAN_V2_SRV_01` + `ZB_LOCK_SRV`) |
| Data-entry profile | `MA-FACHL` (France, company code 0810): entries are approved immediately on save, so the `--no-release` flag changes nothing visible |
| Identity provider | Microsoft Entra ID with two-factor authentication (authenticator code, SMS code, or number matching); "Stay signed in?" offered |
| Codes | `0077` administration, `0010` holiday, `0800` chargeable hours, `0081` non-chargeable order hours, `F035` RTT |
| Client platforms | macOS and Windows for the Claude Desktop bundle; macOS, Windows and Linux for the CLI and the npm package (CI runs the test suite on all three) |

## What is generic

- **The SAP side.** Everything is driven by the launchpad URL (`XFLOW_LAUNCHPAD_URL`), the SAP client and the language. Any system that runs the same two custom apps, with the same OData services and entity sets, works. The field codes (`AWART`, `RAUFNR`, `RKDAUF`, `RKDPOS`) are standard CATS; the codes' *values* are looked up from the system, never hard-coded. The examples in these pages use BearingPoint's values, and the MCP server's built-in instructions mention them as hints to the assistant, which is harmless elsewhere.
- **The interactive sign-in.** `sso` / `sso_login` opens a window on the launchpad URL and waits for the page to arrive on the SAP host with no login form showing. You do the signing in. This works with **any** identity provider, any second factor, any language.
- **Silent renewal.** The headless round trip does not know the identity provider either: it navigates to the launchpad and waits for SAP. It gives up early when it sees a login form it recognises (Entra ID or ADFS elements); with an unknown provider that shows a form, it simply waits the full twenty seconds before falling back to the interactive step. Slower in that one case, but correct.
- **Session handling** (probe, export, expiry detection by outcome rather than by cookie expiry, CSRF token dance, retry of reads) is SAP-generic.

## What is Entra ID-specific

The **credential-based login** (`login`, `login_start`) is a state machine written against the Microsoft sign-in pages. It recognises, by element id:

- the email and password fields and the primary button (`loginfmt`, `passwd`, `idSIButton9`);
- code entry (`otc`) with its error text, and number matching (`idRichContext_DisplaySign`);
- the "Verify your identity" method chooser and its tiles (code first, otherwise the Authenticator push);
- passwordless-first tenants ("Use your password instead"), the "Use another account" tile, and the "more information required" proof-up redirect;
- ADFS-style federated forms (`passwordInput`, `submitButton`, `errorText`), which covers tenants that federate Entra ID to an on-premises ADFS;
- "Stay signed in?" by its checkbox id, which is language-independent (verified with a French tenant).

Anything else is reported as an unrecognised page after three seconds and can be dumped with `--debug-dir`.

## Bringing it to a different identity provider

What would need to change depends on which path you need.

| You need | Work involved |
| --- | --- |
| Interactive sign-in and silent renewal only (most teams) | **Nothing.** Set the launchpad URL. Sign in once in the window. Renewal works as long as the identity provider keeps a session cookie in the browser, which every SAML provider does. |
| Faster fallback when the provider shows a form | Add the provider's login-form selectors to the list the silent step treats as "a form is showing" (the `LOGIN_UI` list in `src/auth/sso-login.ts`), so it gives up in a second instead of twenty. |
| Credential-based login against Okta, Ping, Keycloak, SAP's own logon page, … | Add that provider's steps to the state machine in `src/auth/sso-login.ts` (selectors for the fields, buttons, errors and second-factor screens) and a fake of its pages in `test/fixtures/fake-idp.ts` so the flow is covered by the test suite. Each provider is a few dozen lines. |
| Kerberos / Windows integrated authentication (ADFS on domain-joined machines) | A different mechanism entirely: send a `Negotiate` header from the machine's Kerberos ticket instead of driving a browser. Not built; sketched as future work in `specs/mcp-sso-design.md`. It could coexist with the browser flow as a first attempt. |
| Plain SAP logon without any identity provider (basic authentication) | Not supported. The HTTP client authenticates with cookies only. Adding a basic-auth mode to `src/sap/client.ts` and a matching CLI option would be a small, self-contained change. |
| A provider that blocks headless Chromium | Set `XFLOW_BROWSER_CHANNEL=chrome` to use the installed Google Chrome; the tool already uses Chromium's new headless mode, which behaves like a headed browser. |

## Known limitations

- One browser profile can be open in one process at a time. Two hosts running the tool at once need distinct `XFLOW_PROFILE_DIR` values.
- The Multiproject app's lock is honoured, not bypassed: if the app or another instance holds it, writes are refused.
- Value-help searches are case-sensitive on the text, because the SAP service is.
- The first sign-in downloads a browser (about 150 MB). Inside Claude Desktop this can outlast a single tool call; the second attempt succeeds.
- Timesheet features the two apps do not expose (approval workflows, other CATS profiles' extra fields such as country and state) are not covered.
