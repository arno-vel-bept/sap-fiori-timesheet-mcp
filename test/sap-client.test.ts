import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSap, type FakeSap } from "./fixtures/fake-sap.js";
import { SapClient, SapError, SessionExpiredError } from "../src/sap/client.js";
import type { SessionData } from "../src/auth/session-store.js";

let sap: FakeSap;
beforeAll(async () => {
  sap = await startFakeSap();
});
afterAll(() => sap.close());

const session = (): SessionData => ({
  launchpadUrl: `${sap.baseUrl}/fiori/shells/abap/FioriLaunchpad.html#Shell-home`,
  createdAt: new Date().toISOString(),
  cookies: [{ name: "SAP_SESSIONID_X", value: "ok", domain: "127.0.0.1", path: "/", httpOnly: true }],
});

describe("SapClient", () => {
  it("sends the session cookies and parses JSON on GET", async () => {
    const c = new SapClient(session());
    const res = await c.getJson<{ id: string }>("/sap/bc/ui2/start_up");
    expect(res.id).toBe("AEXAMPLE");
    const last = sap.requests.at(-1)!;
    expect(last.headers.cookie).toContain("SAP_SESSIONID_X=ok");
    expect(last.headers.accept).toContain("application/json");
  });

  it("throws SessionExpiredError when SAP redirects to the identity provider", async () => {
    sap.expired = true;
    try {
      await expect(new SapClient(session()).getJson("/sap/bc/ui2/start_up")).rejects.toBeInstanceOf(SessionExpiredError);
    } finally {
      sap.expired = false;
    }
  });

  it("a 401 becomes a SessionExpiredError that says which request failed, what SAP answered and which cookies were sent (names only)", async () => {
    sap.expired = true;
    sap.reject = "unauthorized";
    try {
      const err = await new SapClient(session()).getJson("/sap/opu/odata/sap/SVC/Entries").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionExpiredError);
      const e = err as SessionExpiredError;
      expect(e.details).toMatchObject({
        kind: "unauthorized",
        method: "GET",
        status: 401,
        statusText: "Unauthorized",
        wwwAuthenticate: 'Basic realm="SAP NetWeaver Application Server [SGW/006]"',
        cookiesSent: ["SAP_SESSIONID_X"],
        cookiesStored: ["SAP_SESSIONID_X"],
      });
      expect(e.details.url).toContain("/sap/opu/odata/sap/SVC/Entries");
      // the HTML logon page is reduced to its text
      expect(e.details.bodyExcerpt).toMatch(/Logon failed.*Session expired or not found/);
      expect(e.details.bodyExcerpt).not.toMatch(/<html>/);
      // and everything a bug report needs is in the message itself
      expect(e.message).toMatch(/GET .*\/sap\/opu\/odata\/sap\/SVC\/Entries/);
      expect(e.message).toMatch(/401 Unauthorized/);
      expect(e.message).toMatch(/WWW-Authenticate: Basic realm="SAP NetWeaver Application Server \[SGW\/006\]"/);
      expect(e.message).toMatch(/Session expired or not found/);
      expect(e.message).toMatch(/cookies sent: SAP_SESSIONID_X/);
      expect(e.message).not.toMatch(/=ok/); // never the value
    } finally {
      sap.expired = false;
      sap.reject = "redirect";
    }
  });

  it("a redirect to the identity provider becomes a SessionExpiredError that names the request and the redirect target", async () => {
    sap.expired = true;
    try {
      const e = (await new SapClient(session()).getJson("/sap/bc/ui2/start_up").catch((x: unknown) => x)) as SessionExpiredError;
      expect(e).toBeInstanceOf(SessionExpiredError);
      expect(e.details).toMatchObject({ kind: "redirect", method: "GET", status: 302, cookiesSent: ["SAP_SESSIONID_X"] });
      expect(e.details.location).toContain("login.microsoftonline.com");
      expect(e.message).toMatch(/redirected GET .*start_up.* to https:\/\/login\.microsoftonline\.com/);
      expect(e.message).toMatch(/identity provider/);
    } finally {
      sap.expired = false;
    }
  });

  it("when no stored cookie applies to the host, the error lists the cookies it does hold and the host it needed them for", async () => {
    const s = session();
    s.cookies = [{ name: "SAP_SESSIONID_X", value: "ok", domain: "other.example.com", path: "/" }, { name: "sap-contextid", value: "ctx", domain: "127.0.0.1", path: "/sap/bc/ui2/start_up" }];
    const e = (await new SapClient(s).getJson("/sap/opu/odata/sap/SVC/Entries").catch((x: unknown) => x)) as SessionExpiredError;
    expect(e).toBeInstanceOf(SessionExpiredError);
    expect(e.details).toMatchObject({ kind: "no_cookies", cookiesSent: [], cookiesStored: ["SAP_SESSIONID_X@other.example.com", "sap-contextid[/sap/bc/ui2/start_up]"] });
    expect(e.message).toMatch(/No stored cookie applies to GET .*\/sap\/opu\/odata\/sap\/SVC\/Entries/);
    expect(e.message).toMatch(/sap-contextid\[\/sap\/bc\/ui2\/start_up\]/);
  });

  it("fetches a CSRF token once and sends it on mutations", async () => {
    const c = new SapClient(session());
    const before = sap.requests.length;
    const created = await c.postJson<{ d: { Id: string; Hours: number } }>("/sap/opu/odata/sap/SVC/Entries", { Hours: 8 });
    expect(created.d).toMatchObject({ Id: "new", Hours: 8 });
    await c.delete("/sap/opu/odata/sap/SVC/Entries('1')");
    const reqs = sap.requests.slice(before);
    const fetches = reqs.filter((r) => String(r.headers["x-csrf-token"]).toLowerCase() === "fetch");
    expect(fetches).toHaveLength(1);
    expect(reqs.filter((r) => r.method === "POST")[0].headers["x-csrf-token"]).toBe("TOKEN123");
    expect(reqs.filter((r) => r.method === "DELETE")[0].headers["x-csrf-token"]).toBe("TOKEN123");
  });

  it("re-fetches the token and retries once when SAP rejects it", async () => {
    const c = new SapClient(session());
    // Poison the cached token.
    (c as unknown as { csrfToken: string }).csrfToken = "STALE";
    const created = await c.postJson<{ d: { Id: string } }>("/sap/opu/odata/sap/SVC/Entries", {});
    expect(created.d.Id).toBe("new");
  });

  it("surfaces OData error messages as SapError with status, method and url", async () => {
    const c = new SapClient(session());
    const e = (await c.getJson("/sap/opu/odata/sap/BROKEN/Err").catch((x: unknown) => x)) as SapError;
    expect(e).toBeInstanceOf(SapError);
    expect(e.method).toBe("GET");
    expect(e.url).toContain("/sap/opu/odata/sap/BROKEN/Err");
    await expect(c.getJson("/sap/opu/odata/sap/BROKEN/Err")).rejects.toMatchObject({
      name: "SapError",
      status: 400,
      message: expect.stringContaining("Something is wrong"),
    } satisfies Partial<SapError>);
  });

  it("returns raw text for non-JSON resources such as $metadata", async () => {
    const c = new SapClient(session());
    const xml = await c.getText("/sap/opu/odata/sap/SVC/$metadata");
    expect(xml).toContain("<edmx:Edmx/>");
  });
});
