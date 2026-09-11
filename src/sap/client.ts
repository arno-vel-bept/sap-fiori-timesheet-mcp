import { cookieHeaderFor, cookieNamesIn, describeCookies, type SessionData } from "../auth/session-store.js";

/** Why a request was judged to have no usable SAP session. */
export type SessionExpiryKind =
  /** none of the stored cookies applies to the host/path */
  | "no_cookies"
  /** SAP answered with a redirect (normally to the identity provider) */
  | "redirect"
  /** SAP answered 401 */
  | "unauthorized"
  /** SAP answered 200 with an HTML sign-in page */
  | "login_page"
  /** the launchpad was reached but the cookies exported from the browser fail the OData probe (issue #5) */
  | "cookies_rejected"
  /** a silent refresh is not possible: the identity provider needs a person */
  | "needs_sign_in"
  | "unknown";

/**
 * Everything a bug report needs about a failed session check. Cookie *names* only — values never
 * leave the process. `[key: string]` leaves room for callers to attach their own context
 * (attempts, browser-side result, silent-refresh outcome…).
 */
export interface SessionExpiryDetails {
  kind: SessionExpiryKind;
  method?: string;
  url?: string;
  status?: number;
  statusText?: string;
  /** `Location` of a redirect answer */
  location?: string;
  /** `WWW-Authenticate` of a 401 */
  wwwAuthenticate?: string;
  contentType?: string;
  /** first ~300 characters of the body, HTML reduced to its text */
  bodyExcerpt?: string;
  /** cookie names that were attached to the request (see describeCookies) */
  cookiesSent?: string[];
  /** cookie names the session holds, with path/domain when they do not apply everywhere */
  cookiesStored?: string[];
  [extra: string]: unknown;
}

const LOGIN_HINT = "Run `xflow-timesheet login`.";

/** One line per detail, in a fixed order, e.g. `GET https://… → 401 Unauthorized (WWW-Authenticate: …; body: "…"); cookies sent: A, B`. */
export function describeExpiry(d: Partial<SessionExpiryDetails>): string {
  const parts: string[] = [];
  if (d.method || d.url) {
    let s = `${d.method ?? "request"} ${d.url ?? ""}`.trim();
    if (d.status !== undefined) s += ` → ${d.status}${d.statusText ? ` ${d.statusText}` : ""}`;
    const extras: string[] = [];
    if (d.location) extras.push(`Location: ${d.location}`);
    if (d.wwwAuthenticate) extras.push(`WWW-Authenticate: ${d.wwwAuthenticate}`);
    if (d.contentType) extras.push(`Content-Type: ${d.contentType}`);
    if (d.bodyExcerpt) extras.push(`body: ${JSON.stringify(d.bodyExcerpt)}`);
    if (extras.length) s += ` (${extras.join("; ")})`;
    parts.push(s);
  }
  if (d.cookiesSent) parts.push(`cookies sent: ${d.cookiesSent.length ? d.cookiesSent.join(", ") : "none"}`);
  if (d.cookiesStored && JSON.stringify(d.cookiesStored) !== JSON.stringify(d.cookiesSent)) {
    parts.push(`cookies stored: ${d.cookiesStored.length ? d.cookiesStored.join(", ") : "none"}`);
  }
  return parts.join("; ");
}

export class SessionExpiredError extends Error {
  override readonly name = "SessionExpiredError";
  readonly details: SessionExpiryDetails;
  constructor(message = `The SAP session has expired or is missing. ${LOGIN_HINT}`, details: Partial<SessionExpiryDetails> = {}) {
    super(message);
    this.details = { kind: "unknown", ...details };
  }
}

export class SapError extends Error {
  override readonly name = "SapError";
  readonly method?: string;
  readonly url?: string;
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
    request: { method?: string; url?: string } = {},
  ) {
    super(message);
    this.method = request.method;
    this.url = request.url;
  }
}

export interface SapClientOptions {
  fetch?: typeof fetch;
  language?: string;
  sapClient?: string;
}

type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "MERGE";

/** Looks like the identity provider / an SAP logon endpoint — the classic "session gone" redirect. */
const IDP_LOCATION_RE = /login\.microsoftonline\.com|\/sap\/public\/bc\/sec\/saml2|\/saml2\/|logon/i;

/** A redirect target without its query string (a SAML request there is hundreds of opaque bytes): `https://idp/…/saml2?…`. */
function trimUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}${x.search ? "?…" : ""}`;
  } catch {
    return u.length > 200 ? `${u.slice(0, 200)}…` : u;
  }
}

/** First `max` characters of a body, whitespace collapsed and HTML reduced to its text. */
export function bodyExcerpt(text: string, max = 300): string {
  let t = text;
  if (/<[a-z!/][^>]*>/i.test(t)) {
    t = t
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
  }
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Cookie-authenticated HTTP client for an SAP Gateway host. Handles the
 * x-csrf-token dance for mutations, JSON/OData error unwrapping, and detection
 * of an expired session (redirect to the IdP or an HTML login page).
 */
export class SapClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private csrfToken: string | null = null;
  private readonly language?: string;
  private readonly sapClient?: string;

  constructor(
    private readonly session: SessionData,
    opts: SapClientOptions = {},
  ) {
    this.baseUrl = new URL(session.launchpadUrl).origin;
    this.fetchImpl = opts.fetch ?? fetch;
    this.language = opts.language;
    this.sapClient = opts.sapClient;
  }

  url(path: string): string {
    const u = new URL(path, this.baseUrl);
    if (this.language && !u.searchParams.has("sap-language")) u.searchParams.set("sap-language", this.language);
    if (this.sapClient && !u.searchParams.has("sap-client")) u.searchParams.set("sap-client", this.sapClient);
    return u.toString();
  }

  async getJson<T = unknown>(path: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.request("GET", path, { headers: { accept: "application/json", ...headers } });
    return (await this.parseJson(res, "GET")) as T;
  }

  async getText(path: string, headers: Record<string, string> = {}): Promise<string> {
    const res = await this.request("GET", path, { headers });
    return res.text();
  }

  async postJson<T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.mutate("POST", path, body, headers);
    return (await this.parseJson(res, "POST")) as T;
  }

  /** OData v2 update (MERGE semantics via PATCH); returns parsed JSON or null on 204. */
  async patchJson<T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T | null> {
    const res = await this.mutate("PATCH", path, body, headers);
    return (await this.parseJson(res, "PATCH")) as T | null;
  }

  async putJson<T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T | null> {
    const res = await this.mutate("PUT", path, body, headers);
    return (await this.parseJson(res, "PUT")) as T | null;
  }

  async delete(path: string, headers: Record<string, string> = {}): Promise<void> {
    await this.mutate("DELETE", path, undefined, headers);
  }

  /** Raw request with an already-serialized body (used for $batch). Handles CSRF. */
  async mutateRaw(method: Method, path: string, body: string | undefined, headers: Record<string, string>): Promise<Response> {
    return this.mutate(method, path, body, headers, true);
  }

  private async mutate(
    method: Method,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    raw = false,
  ): Promise<Response> {
    const token = await this.ensureCsrfToken(path);
    const send = (t: string) =>
      this.request(method, path, {
        headers: {
          accept: "application/json",
          ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}),
          "x-csrf-token": t,
          ...headers,
        },
        body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
        allowStatus: [403],
      });
    let res = await send(token);
    if (res.status === 403 && /required|invalid/i.test(res.headers.get("x-csrf-token") ?? "")) {
      this.csrfToken = null;
      res = await send(await this.ensureCsrfToken(path));
    }
    if (!res.ok) throw await this.toError(res, method);
    return res;
  }

  private async ensureCsrfToken(path: string): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    // Fetch the token from the service root (or the path itself when it isn't under /sap/opu/odata).
    const m = /^(\/sap\/opu\/odata\/[^/]+\/[^/]+\/)/.exec(path);
    const tokenPath = m ? m[1] : path;
    const res = await this.request("GET", tokenPath, { headers: { "x-csrf-token": "Fetch", accept: "application/json" } });
    const token = res.headers.get("x-csrf-token");
    if (!token) {
      throw new SapError(res.status, `SAP did not return a CSRF token for GET ${res.url || this.url(tokenPath)} (${res.status} ${res.statusText}; x-csrf-token header absent)`, undefined, { method: "GET", url: res.url });
    }
    this.csrfToken = token;
    return token;
  }

  private async request(
    method: Method,
    path: string,
    init: { headers?: Record<string, string>; body?: string; allowStatus?: number[] },
  ): Promise<Response> {
    const url = this.url(path);
    const host = new URL(url).hostname;
    const cookie = cookieHeaderFor(this.session.cookies, url);
    const cookiesStored = describeCookies(this.session.cookies, host);
    const cookiesSent = cookieNamesIn(cookie);
    if (!cookie) {
      const d: SessionExpiryDetails = { kind: "no_cookies", method, url, cookiesSent, cookiesStored };
      throw new SessionExpiredError(`No stored cookie applies to ${method} ${url} (host ${host}); ${describeExpiry({ cookiesStored })}. ${LOGIN_HINT}`, d);
    }
    const res = await this.fetchImpl(url, {
      method,
      redirect: "manual",
      headers: { cookie, ...(init.headers ?? {}) },
      body: init.body,
    });
    const base = { method, url, status: res.status, statusText: res.statusText, cookiesSent, cookiesStored };
    if (res.status >= 300 && res.status < 400) {
      const raw = res.headers.get("location") ?? "";
      const idp = IDP_LOCATION_RE.test(raw);
      const loc = raw ? trimUrl(raw) : "";
      const d: SessionExpiryDetails = { kind: "redirect", ...base, location: loc || undefined };
      throw new SessionExpiredError(
        `SAP redirected ${method} ${url} to ${loc || "an unknown location"} (${res.status}${idp ? ", the identity provider: the SAP session has expired" : ", not the identity provider — check the redirect target"}); ${describeExpiry({ cookiesSent, cookiesStored })}. ${LOGIN_HINT}`,
        d,
      );
    }
    if (res.status === 401) {
      const d: SessionExpiryDetails = {
        kind: "unauthorized",
        ...base,
        wwwAuthenticate: res.headers.get("www-authenticate") ?? undefined,
        contentType: res.headers.get("content-type") ?? undefined,
        bodyExcerpt: bodyExcerpt(await res.text().catch(() => "")) || undefined,
      };
      throw new SessionExpiredError(`SAP rejected the session: ${describeExpiry(d)}. ${LOGIN_HINT}`, d);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok && ct.includes("text/html")) {
      const text = await res.clone().text();
      if (/loginfmt|saml|logon/i.test(text)) {
        const d: SessionExpiryDetails = { kind: "login_page", ...base, contentType: ct, bodyExcerpt: bodyExcerpt(text) };
        throw new SessionExpiredError(`SAP answered with a sign-in page instead of data: ${describeExpiry(d)}. ${LOGIN_HINT}`, d);
      }
    }
    if (!res.ok && !(init.allowStatus ?? []).includes(res.status)) throw await this.toError(res, method);
    return res;
  }

  private async parseJson(res: Response, method: Method): Promise<unknown> {
    if (res.status === 204) return null;
    const txt = await res.text();
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch {
      throw new SapError(res.status, `Expected JSON from ${method} ${res.url} (${res.status}, ${res.headers.get("content-type") ?? "no content-type"}) but got: ${bodyExcerpt(txt, 200)}`, txt, { method, url: res.url });
    }
  }

  private async toError(res: Response, method: Method): Promise<SapError> {
    const txt = await res.text().catch(() => "");
    const where = `${method} ${res.url}`;
    let message = `${res.status} ${res.statusText} for ${where}`;
    let body: unknown = txt;
    try {
      body = JSON.parse(txt);
      const odata = (body as { error?: { message?: { value?: string } | string; code?: string } }).error;
      const m = typeof odata?.message === "string" ? odata.message : odata?.message?.value;
      if (m) message = `${m} (${odata?.code ?? res.status})`;
    } catch {
      if (txt) message += `: ${bodyExcerpt(txt)}`;
    }
    return new SapError(res.status, message, body, { method, url: res.url });
  }
}
