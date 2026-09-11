/**
 * A tiny in-process imitation of the Microsoft Entra ID login sequence used by
 * xflow.bearingpoint.com, plus a fake Fiori launchpad behind it.
 *
 * Flow (mirrors the real one closely enough for the login state machine):
 *   GET  /fiori/...        -> 302 to /idp/login (unless `xflow_session` cookie is set)
 *   GET  /idp/login        -> email page      (input[name=loginfmt], #idSIButton9)
 *                             or, when the IdP's own `idp_session` cookie is still valid,
 *                             a JS auto-submitting form that POSTs straight back to the SAP
 *                             host (silent SSO: no form, no prompt — like Entra with ESTSAUTH)
 *   POST /idp/email        -> password page   (input[name=passwd],   #idSIButton9)
 *   POST /idp/password     -> OTP page        (input[name=otc],      #idSubmit_SAOTCC_Continue)
 *                             or error page   (#passwordError) when password is wrong
 *   POST /idp/otp          -> KMSI page       ("Stay signed in?", #idSIButton9 = Yes)
 *   POST /idp/kmsi         -> Set-Cookie idp_session (persistent, like ESTSAUTHPERSISTENT)
 *                             + 302 to the SAP callback
 *   GET|POST /sap/callback -> Set-Cookie xflow_session + 302 to /fiori/...
 *   GET  /fiori/...        -> launchpad page  (#shell-header) when cookie present
 *   GET  /sap/bc/ui2/start_up -> JSON user info when the SAP cookie is valid (probe endpoint)
 *
 * Two lifetimes can be ended independently, like on the real system:
 *   expireSapSession()  -> every xflow_session issued so far stops being accepted
 *   expireIdpSession()  -> every idp_session issued so far stops being accepted
 */
import http from "node:http";
import { AddressInfo } from "node:net";

export interface FakeIdpOptions {
  email: string;
  password: string;
  otp: string;
  /** Show a "number matching" Authenticator page instead of an OTP field. */
  numberMatch?: number;
  /** After the password, show Entra's "More information required" (proof-up) interstitial. */
  proofUp?: boolean;
  /** After the email, show a page the state machine does not know, which moves on by itself after `unknownMs`. */
  unknownInterstitialMs?: number;
  /** After the password, show the "Verify your identity" method chooser before the OTP page. */
  methodChooser?: boolean;
  /** After the email, hand over to an ADFS-style form (#userNameInput/#passwordInput/#submitButton). */
  adfs?: boolean;
}

export interface FakeIdp {
  baseUrl: string;
  launchpadUrl: string;
  requests: string[];
  /** Bodies of the "Stay signed in?" answers, in order (e.g. `DontShowAgain=true`). */
  kmsiBodies: string[];
  /** Invalidate every SAP session cookie issued so far (SAP-side expiry). */
  expireSapSession(): void;
  /** Invalidate every IdP session cookie issued so far (IdP-side expiry: a fresh sign-in is needed). */
  expireIdpSession(): void;
  /**
   * Make the OData tier answer 401 even for a valid SAP session (issue #5: the launchpad is reached
   * and start_up works, but the exported cookies do not authenticate the data services).
   */
  rejectOData(on: boolean): void;
  close(): Promise<void>;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function cookieValue(req: http.IncomingMessage, name: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie ?? "");
  return m?.[1];
}

export async function startFakeIdp(opts: FakeIdpOptions): Promise<FakeIdp> {
  const requests: string[] = [];
  const kmsiBodies: string[] = [];
  // Generation counters: a cookie is only valid when it carries the current generation.
  let sapGen = 0;
  let idpGen = 0;
  let odataRejects = false;
  const sapCookieValue = () => (sapGen === 0 ? "ok" : `ok-${sapGen}`);
  const idpCookieValue = () => (idpGen === 0 ? "ok" : `ok-${idpGen}`);
  // The launchpad lives on 127.0.0.1 and the IdP on localhost so the two are distinct origins,
  // like xflow.bearingpoint.com vs login.microsoftonline.com.
  let idpOrigin = "";
  let sapOrigin = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}`);
    const html = (title: string, body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(title, body));
    };
    const sapAuthed = cookieValue(req, "xflow_session") === sapCookieValue();

    const otpPage = () =>
      html(
        "Enter code",
        `<form method="post" action="/idp/otp">
           <div>Enter the code displayed in your authenticator app.</div>
           <input type="tel" name="otc" />
           <input type="submit" id="idSubmit_SAOTCC_Continue" value="Verify" />
         </form>`,
      );

    if (url.pathname.startsWith("/fiori/")) {
      if (!sapAuthed) {
        res.writeHead(302, { location: `${idpOrigin}/idp/login` });
        return res.end();
      }
      return html(
        "Home",
        `<div id="shell-header">Fiori launchpad</div><script>location.hash = "#Shell-home";</script>`,
      );
    }
    if (url.pathname === "/sap/bc/ui2/start_up") {
      if (!sapAuthed) {
        res.writeHead(302, { location: `${idpOrigin}/idp/login` });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "8765432", fullName: "Jane Doe", client: "006", language: "EN" }));
    }
    // The OData tier the data tools (and now the session probe) actually use. Unlike start_up it
    // answers 401 — not a redirect — when the SAP session is gone, like the real Gateway.
    if (url.pathname.startsWith("/sap/opu/odata/")) {
      if (!sapAuthed || odataRejects) {
        res.writeHead(401, { "content-type": "text/html; charset=windows-1252", "www-authenticate": 'Basic realm="SAP NetWeaver Application Server [SGW/006]"', "sap-server": "true" });
        return res.end("<html><head><title>Logon Error Message</title></head><body><h1>Logon failed</h1><p>Session expired or not found</p></body></html>");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ d: { EntitySets: ["TimeEntries", "Favorites"] } }));
    }

    if (url.pathname === "/idp/login") {
      if (cookieValue(req, "idp_session") === idpCookieValue()) {
        // The IdP still knows the user: like the SAML HTTP-POST binding, it answers with a form
        // that JavaScript submits back to the service provider. No form is shown, nothing is asked.
        return html(
          "Redirecting…",
          `<form method="post" action="${sapOrigin}/sap/callback"><input type="hidden" name="SAMLResponse" value="fake" /></form>
           <script>document.forms[0].submit();</script>`,
        );
      }
      return html(
        "Sign in to your account",
        // Like the real page, the email form also carries an off-screen (but not display:none)
        // password input, so naive visibility checks see a password field here too.
        `<form method="post" action="/idp/email">
           <input type="email" name="loginfmt" placeholder="Email" />
           <div style="position:absolute;left:-9999px"><input type="password" name="passwd" tabindex="-1" /></div>
           <input type="submit" id="idSIButton9" value="Next" />
         </form>`,
      );
    }
    if (url.pathname === "/idp/email" && req.method === "POST") {
      const b = new URLSearchParams(await readBody(req));
      if (b.get("loginfmt") !== opts.email) {
        return html("Sign in", `<div id="usernameError">We couldn't find an account with that username.</div>`);
      }
      if (opts.unknownInterstitialMs !== undefined && !url.searchParams.has("resumed")) {
        return html(
          "Please wait",
          `<div class="spinner">Taking you to your organization's sign-in page…</div>
           <form method="post" action="/idp/email?resumed=1"><input type="hidden" name="loginfmt" value="${opts.email}" /></form>
           <script>setTimeout(() => document.forms[0].submit(), ${opts.unknownInterstitialMs});</script>`,
        );
      }
      if (opts.adfs) {
        return html(
          "Sign In",
          `<form method="post" action="/idp/adfs">
             <input id="userNameInput" name="UserName" type="email" value="${opts.email}" />
             <input id="passwordInput" name="Password" type="password" />
             <span id="submitButton" onclick="this.closest('form').submit()">Sign in</span>
           </form>`,
        );
      }
      return html(
        "Enter password",
        `<form method="post" action="/idp/password">
           <input type="password" name="passwd" />
           <input type="submit" id="idSIButton9" value="Sign in" />
         </form>`,
      );
    }
    if (url.pathname === "/idp/adfs" && req.method === "POST") {
      const b = new URLSearchParams(await readBody(req));
      if (b.get("Password") !== opts.password) {
        return html(
          "Sign In",
          `<form method="post" action="/idp/adfs">
             <span id="errorText">Incorrect user ID or password. Type the correct user ID and password, and try again.</span>
             <input id="userNameInput" name="UserName" type="email" value="${opts.email}" />
             <input id="passwordInput" name="Password" type="password" />
             <span id="submitButton" onclick="this.closest('form').submit()">Sign in</span>
           </form>`,
        );
      }
      return otpPage();
    }
    if (url.pathname === "/idp/choose" && req.method === "POST") {
      const b = new URLSearchParams(await readBody(req));
      if (b.get("method") !== "PhoneAppOTP") return html("Unexpected", `<div>unexpected method ${b.get("method")}</div>`);
      return otpPage();
    }
    if (url.pathname === "/idp/password" && req.method === "POST") {
      const b = new URLSearchParams(await readBody(req));
      if (b.get("passwd") !== opts.password) {
        return html(
          "Enter password",
          `<form method="post" action="/idp/password">
             <div id="passwordError">Your account or password is incorrect.</div>
             <input type="password" name="passwd" />
             <input type="submit" id="idSIButton9" value="Sign in" />
           </form>`,
        );
      }
      if (opts.proofUp) {
        return html(
          "More information required",
          `<div id="ProofUpDescription">Your organization needs more information to keep your account secure</div>
           <input type="submit" id="idSubmit_ProofUp_Redirect" value="Next" />`,
        );
      }
      if (opts.numberMatch !== undefined) {
        return html(
          "Approve sign in request",
          `<div id="idRichContext_DisplaySign">${opts.numberMatch}</div>
           <div>Open your Authenticator app, and enter the number shown to sign in.</div>
           <form method="post" action="/idp/kmsi"><input type="submit" id="testApprove" value="approved (test hook)" /></form>
           <script>setTimeout(() => document.forms[0].submit(), 300);</script>`,
        );
      }
      if (opts.methodChooser) {
        return html(
          "Verify your identity",
          `<div id="idDiv_SAOTCS_Proofs">
             <form method="post" action="/idp/choose">
               <input type="hidden" name="method" value="" />
               <div role="button" data-value="PhoneAppNotification" onclick="pick(this)">Approve a request on my Microsoft Authenticator app</div>
               <div role="button" data-value="PhoneAppOTP" onclick="pick(this)">Use a verification code</div>
               <div role="button" data-value="OneWaySMS" onclick="pick(this)">Text +XX XXXXXXX89</div>
             </form>
           </div>
           <script>function pick(el){const f=el.closest('form');f.method.value=el.dataset.value;f.submit();}</script>`,
        );
      }
      return otpPage();
    }
    if (url.pathname === "/idp/otp" && req.method === "POST") {
      const b = new URLSearchParams(await readBody(req));
      if (b.get("otc") !== opts.otp) {
        return html(
          "Enter code",
          `<form method="post" action="/idp/otp">
             <div id="idSpan_SAOTCC_Error_OTC">You didn't enter the expected verification code.</div>
             <input type="tel" name="otc" />
             <input type="submit" id="idSubmit_SAOTCC_Continue" value="Verify" />
           </form>`,
        );
      }
      // Rendered in French like the real tenant: detection must not rely on English text.
      return html(
        "Connectez-vous à votre compte",
        `<form method="post" action="/idp/kmsi">
           <div role="heading">Rester connecté&nbsp;?</div>
           <input id="KmsiCheckboxField" name="DontShowAgain" type="checkbox" value="true" />
           <input type="button" id="idBtn_Back" value="Non" />
           <input type="submit" id="idSIButton9" value="Oui" />
         </form>`,
      );
    }
    if (url.pathname === "/idp/kmsi" && req.method === "POST") {
      kmsiBodies.push(await readBody(req));
      // "Yes" makes the IdP remember the browser: a persistent cookie on the IdP's own origin
      // (Entra's ESTSAUTHPERSISTENT). Then, like the real SAML/OIDC response, the IdP sends the
      // browser back to the SAP host, which sets its own cookies.
      res.writeHead(302, {
        location: `${sapOrigin}/sap/callback`,
        "set-cookie": [`idp_session=${idpCookieValue()}; Path=/idp; HttpOnly; Max-Age=86400`],
      });
      return res.end();
    }
    if (url.pathname === "/sap/callback") {
      res.writeHead(302, {
        location: "/fiori/shells/abap/FioriLaunchpad.html",
        "set-cookie": [`xflow_session=${sapCookieValue()}; Path=/; HttpOnly`, "MYSAPSSO2=fake-token; Path=/; HttpOnly"],
      });
      return res.end();
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((r) => server.listen(0, r)); // dual-stack: reachable as 127.0.0.1 and localhost
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  sapOrigin = baseUrl;
  idpOrigin = `http://localhost:${port}`;
  return {
    baseUrl,
    launchpadUrl: `${baseUrl}/fiori/shells/abap/FioriLaunchpad.html#Shell-home`,
    requests,
    kmsiBodies,
    expireSapSession: () => void sapGen++,
    expireIdpSession: () => void idpGen++,
    rejectOData: (on) => void (odataRejects = on),
    close: () =>
      new Promise((r) => {
        // A persistent browser (login_start tests) may still hold a keep-alive socket; drop it so
        // server.close() actually resolves instead of waiting for the connection to drain.
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
