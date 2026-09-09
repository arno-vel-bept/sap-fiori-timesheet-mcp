import { cookieHeaderFor, type SessionData } from "../auth/session-store.js";

export class SessionExpiredError extends Error {
  override readonly name = "SessionExpiredError";
  constructor(message = "The SAP session has expired or is missing. Run `xflow-timesheet login`.") {
    super(message);
  }
}

export class SapError extends Error {
  override readonly name = "SapError";
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface SapClientOptions {
  fetch?: typeof fetch;
  language?: string;
  sapClient?: string;
}

type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "MERGE";

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
    return (await this.parseJson(res)) as T;
  }

  async getText(path: string, headers: Record<string, string> = {}): Promise<string> {
    const res = await this.request("GET", path, { headers });
    return res.text();
  }

  async postJson<T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.mutate("POST", path, body, headers);
    return (await this.parseJson(res)) as T;
  }

  /** OData v2 update (MERGE semantics via PATCH); returns parsed JSON or null on 204. */
  async patchJson<T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T | null> {
    const res = await this.mutate("PATCH", path, body, headers);
    return (await this.parseJson(res)) as T | null;
  }

  async putJson<T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T | null> {
    const res = await this.mutate("PUT", path, body, headers);
    return (await this.parseJson(res)) as T | null;
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
    if (!res.ok) throw await this.toError(res);
    return res;
  }

  private async ensureCsrfToken(path: string): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    // Fetch the token from the service root (or the path itself when it isn't under /sap/opu/odata).
    const m = /^(\/sap\/opu\/odata\/[^/]+\/[^/]+\/)/.exec(path);
    const tokenPath = m ? m[1] : path;
    const res = await this.request("GET", tokenPath, { headers: { "x-csrf-token": "Fetch", accept: "application/json" } });
    const token = res.headers.get("x-csrf-token");
    if (!token) throw new SapError(res.status, `SAP did not return a CSRF token for ${tokenPath}`);
    this.csrfToken = token;
    return token;
  }

  private async request(
    method: Method,
    path: string,
    init: { headers?: Record<string, string>; body?: string; allowStatus?: number[] },
  ): Promise<Response> {
    const url = this.url(path);
    const cookie = cookieHeaderFor(this.session.cookies, url);
    if (!cookie) throw new SessionExpiredError("No session cookies apply to this host. Run `xflow-timesheet login`.");
    const res = await this.fetchImpl(url, {
      method,
      redirect: "manual",
      headers: { cookie, ...(init.headers ?? {}) },
      body: init.body,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") ?? "";
      if (/login\.microsoftonline\.com|\/sap\/public\/bc\/sec\/saml2|\/saml2\/|logon/i.test(loc) || loc) {
        throw new SessionExpiredError(`SAP redirected to ${loc || "an unknown location"}; the session has expired. Run \`xflow-timesheet login\`.`);
      }
    }
    if (res.status === 401) throw new SessionExpiredError();
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok && ct.includes("text/html") && /loginfmt|saml|logon/i.test(await res.clone().text())) {
      throw new SessionExpiredError("SAP answered with a login page; the session has expired. Run `xflow-timesheet login`.");
    }
    if (!res.ok && !(init.allowStatus ?? []).includes(res.status)) throw await this.toError(res);
    return res;
  }

  private async parseJson(res: Response): Promise<unknown> {
    if (res.status === 204) return null;
    const txt = await res.text();
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch {
      throw new SapError(res.status, `Expected JSON from ${res.url} but got: ${txt.slice(0, 200)}`);
    }
  }

  private async toError(res: Response): Promise<SapError> {
    const txt = await res.text().catch(() => "");
    let message = `${res.status} ${res.statusText} for ${res.url}`;
    let body: unknown = txt;
    try {
      body = JSON.parse(txt);
      const odata = (body as { error?: { message?: { value?: string } | string; code?: string } }).error;
      const m = typeof odata?.message === "string" ? odata.message : odata?.message?.value;
      if (m) message = `${m} (${odata?.code ?? res.status})`;
    } catch {
      if (txt) message += `: ${txt.slice(0, 300)}`;
    }
    return new SapError(res.status, message, body);
  }
}
