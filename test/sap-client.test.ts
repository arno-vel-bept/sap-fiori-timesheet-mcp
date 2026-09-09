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

  it("surfaces OData error messages as SapError with status", async () => {
    const c = new SapClient(session());
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
