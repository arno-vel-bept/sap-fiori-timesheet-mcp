/**
 * Minimal imitation of an SAP Gateway host: checks the session cookie, serves
 * JSON for OData GETs, requires a CSRF token for mutations, and redirects to
 * the IdP when the session is gone.
 */
import http from "node:http";
import { AddressInfo } from "node:net";

export interface FakeSap {
  baseUrl: string;
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[];
  /** Flip to true to simulate an expired session. */
  expired: boolean;
  close(): Promise<void>;
}

export async function startFakeSap(): Promise<FakeSap> {
  const state: FakeSap = { baseUrl: "", requests: [], expired: false, close: async () => {} };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      state.requests.push({ method: req.method!, path: url.pathname + url.search, headers: req.headers, body });
      const authed = !state.expired && /SAP_SESSIONID_X=ok/.test(req.headers.cookie ?? "");
      if (!authed) {
        res.writeHead(302, { location: "https://login.microsoftonline.com/common/oauth2/authorize?x=1" });
        return res.end();
      }
      if (url.pathname === "/sap/bc/ui2/start_up") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "AEXAMPLE", fullName: "Jane D", client: "006", language: "EN" }));
      }
      if (url.pathname === "/sap/opu/odata/sap/SVC/$metadata") {
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end("<edmx:Edmx/>");
      }
      if (url.pathname.startsWith("/sap/opu/odata/sap/SVC/")) {
        const csrf = req.headers["x-csrf-token"];
        if (req.method === "GET" || req.method === "HEAD") {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (typeof csrf === "string" && csrf.toLowerCase() === "fetch") headers["x-csrf-token"] = "TOKEN123";
          res.writeHead(200, headers);
          return res.end(JSON.stringify({ d: { results: [{ Id: "1" }] } }));
        }
        if (csrf !== "TOKEN123") {
          res.writeHead(403, { "x-csrf-token": "Required", "content-type": "text/plain" });
          return res.end("CSRF token validation failed");
        }
        if (req.method === "POST") {
          res.writeHead(201, { "content-type": "application/json" });
          return res.end(JSON.stringify({ d: { Id: "new", ...JSON.parse(body || "{}") } }));
        }
        if (req.method === "DELETE") {
          res.writeHead(204);
          return res.end();
        }
      }
      if (url.pathname === "/sap/opu/odata/sap/BROKEN/Err") {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "X", message: { lang: "en", value: "Something is wrong" } } }));
      }
      // OData service root — the session-liveness probe (SessionManager) hits this.
      if (/^\/sap\/opu\/odata\/sap\/[^/]+\/$/.test(url.pathname)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ d: { EntitySets: [] } }));
      }
      res.writeHead(404);
      res.end("nope");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}
