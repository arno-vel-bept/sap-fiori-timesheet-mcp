import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startFakeXflow, fakeSession, type FakeXflow } from "./fixtures/fake-xflow.js";
import { startFakeIdp, type FakeIdp } from "./fixtures/fake-idp.js";
import { SessionStore } from "../src/auth/session-store.js";
import { createMcpServer } from "../src/mcp/server.js";

let sap: FakeXflow;
let idp: FakeIdp;
let client: Client;
let sessionFile: string;

beforeAll(async () => {
  sap = await startFakeXflow();
  idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456" });
  const dir = mkdtempSync(join(tmpdir(), "xflow-mcp-"));
  sessionFile = join(dir, "session.json");
  await new SessionStore(sessionFile).save(fakeSession(sap.baseUrl));
  const server = createMcpServer({ env: { XFLOW_LAUNCHPAD_URL: `${sap.baseUrl}/fiori/shells/abap/FioriLaunchpad.html#Shell-home`, XFLOW_SESSION_FILE: sessionFile } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});
afterAll(async () => {
  await client.close();
  await sap.close();
  await idp.close();
});

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return { res, text, json: () => JSON.parse(text) };
}

describe("MCP server", () => {
  it("exposes the timesheet tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const n of [
      "session_status",
      "login_start",
      "login_submit_otp",
      "std_open_days",
      "std_entries",
      "std_favorites",
      "std_attendance_types",
      "std_chargeable_orders",
      "std_non_chargeable_orders",
      "std_sales_order_items",
      "std_fill",
      "std_remove",
      "std_update",
      "std_favorite_add",
      "std_favorite_remove",
      "mp_months",
      "mp_month",
      "mp_allocate",
      "mp_clear",
    ])
      expect(names, `missing tool ${n}`).toContain(n);
    const fill = tools.find((t) => t.name === "std_fill")!;
    expect(fill.description).toMatch(/attendance|order/i);
    expect(fill.inputSchema).toMatchObject({ type: "object" });
  });

  it("session_status reports the stored session", async () => {
    const r = await call("session_status");
    expect(r.res.isError).toBeFalsy();
    expect(r.json()).toMatchObject({ loggedIn: true, user: expect.objectContaining({ id: "8765432" }) });
  });

  it("std_open_days returns structured JSON", async () => {
    const r = await call("std_open_days", { from: "2026-09-01", to: "2026-09-06" });
    expect(r.res.isError).toBeFalsy();
    const days = r.json() as { date: string }[];
    expect(days.map((d) => d.date)).toEqual(["2026-09-02", "2026-09-03", "2026-09-04"]);
  });

  it("std_fill books hours and std_remove deletes them", async () => {
    const before = sap.state.entries.length;
    const r = await call("std_fill", { dates: ["2026-09-03", "2026-09-04"], item: { order: "900140", attendanceType: "0081" }, hours: 8, shortText: "dev" });
    expect(r.res.isError).toBeFalsy();
    const results = r.json() as { ok: boolean; counter: string }[];
    expect(results.every((x) => x.ok)).toBe(true);
    expect(sap.state.entries).toHaveLength(before + 2);

    const rm = await call("std_remove", { counters: results.map((x) => x.counter), from: "2026-09-01", to: "2026-09-30" });
    expect(rm.res.isError).toBeFalsy();
    expect(sap.state.entries).toHaveLength(before);
  });

  it("std_fill can take a favorite by name", async () => {
    const r = await call("std_fill", { dates: ["2026-09-08"], favorite: "Holiday" });
    expect(r.res.isError).toBeFalsy();
    expect(sap.state.entries.at(-1)).toMatchObject({ workdate: "20260908", fields: { AWART: "0010" } });
  });

  it("returns isError with the SAP message when a day is rejected", async () => {
    const r = await call("std_fill", { dates: ["2026-08-20"], item: { attendanceType: "0010" }, hours: 8 });
    expect(r.res.isError).toBe(true);
    expect(r.text).toMatch(/closed/i);
  });

  it("validates input (missing item) with a helpful error instead of crashing", async () => {
    const r = await call("std_fill", { dates: ["2026-09-09"], hours: 8 });
    expect(r.res.isError).toBe(true);
    expect(r.text).toMatch(/attendance type or an order|favorite/i);
  });

  it("mp_month and mp_allocate work end to end", async () => {
    const m = await call("mp_month", { year: 2026, month: 9 });
    expect(m.res.isError).toBeFalsy();
    expect(m.json().days).toHaveLength(30);
    const before = sap.state.entries.length;
    const a = await call("mp_allocate", { year: 2026, month: 9, project: { order: "900004", attendanceType: "0081" }, days: [{ date: "2026-09-16", hours: 4 }] });
    expect(a.res.isError).toBeFalsy();
    expect(sap.state.entries).toHaveLength(before + 1);
    const c = await call("mp_clear", { year: 2026, month: 9, project: { order: "900004", attendanceType: "0081" }, dates: ["2026-09-16"] });
    expect(c.res.isError).toBeFalsy();
    expect(sap.state.entries).toHaveLength(before);
  });

  it("login_start pauses for the one-time code and login_submit_otp completes and stores the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-mcp-login-"));
    const loginSessionFile = join(dir, "session.json");
    const server = createMcpServer({ env: { XFLOW_LAUNCHPAD_URL: idp.launchpadUrl, XFLOW_SESSION_FILE: loginSessionFile } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c2 = new Client({ name: "t2", version: "0" });
    await c2.connect(ct);
    try {
      const status = (await c2.callTool({ name: "session_status", arguments: {} })) as ToolResult;
      expect(JSON.parse(status.content[0].text!)).toMatchObject({ loggedIn: false });

      const start = (await c2.callTool({ name: "login_start", arguments: { email: "arno@example.com", password: "s3cret" } })) as ToolResult;
      expect(start.isError).toBeFalsy();
      expect(JSON.parse(start.content[0].text!)).toMatchObject({ state: "otp_required" });

      const done = (await c2.callTool({ name: "login_submit_otp", arguments: { code: "123456" } })) as ToolResult;
      expect(done.isError).toBeFalsy();
      expect(JSON.parse(done.content[0].text!)).toMatchObject({ state: "done", cookies: expect.any(Number) });
      expect((await new SessionStore(loginSessionFile).load())?.cookies.some((k) => k.name === "xflow_session")).toBe(true);
    } finally {
      await c2.close();
    }
  });
});

describe("MCP user-flow tools", () => {
  it("exposes the flow tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["std_days", "std_set", "std_jobcodes", "std_staffing", "std_staffing_apply", "std_fill_open", "mp_allocate_many", "mp_stats", "mp_balance"]) expect(names, n).toContain(n);
  });

  it("std_jobcodes / std_days / std_staffing return structured data", async () => {
    expect((await call("std_jobcodes", { from: "2026-09-01", to: "2026-09-30" })).json().length).toBeGreaterThan(0);
    expect((await call("std_days", { from: "2026-09-01", to: "2026-09-02" })).json()).toHaveLength(2);
    expect((await call("std_staffing", { from: "2026-09-01", to: "2026-09-30" })).json()[0]).toMatchObject({ status: "Planned" });
  });

  it("mp_allocate_many, mp_stats and mp_balance work", async () => {
    const a = await call("mp_allocate_many", { year: 2026, month: 9, slots: [{ project: { attendanceType: "0077" }, range: { from: "2026-09-28", to: "2026-09-29" }, hours: 3 }] });
    expect(a.res.isError, a.text).toBeFalsy();
    const s = await call("mp_stats", { year: 2026, month: 9, from: "2026-09-28", to: "2026-09-29" });
    expect(s.json().totalHours).toBeGreaterThanOrEqual(6);
    const b = await call("mp_balance", { year: 2026, month: 9, range: { from: "2026-09-28", to: "2026-09-29" }, slots: [{ project: { attendanceType: "0077" }, share: 50 }, { project: { attendanceType: "0010" }, share: 50 }] });
    expect(b.res.isError, b.text).toBeFalsy();
    expect(b.json().totalHours).toBe(16);
  });
});

describe("MCP dry runs and balance modes", () => {
  it("mp_balance supports dryRun and mode", async () => {
    const before = sap.state.entries.length;
    const r = await call("mp_balance", { year: 2026, month: 9, range: { from: "2026-09-21", to: "2026-09-22" }, slots: [{ project: { attendanceType: "0077" }, share: 50 }, { project: { attendanceType: "0010" }, share: 50 }], mode: "every-day", dryRun: true });
    expect(r.res.isError, r.text).toBeFalsy();
    expect(r.json()).toMatchObject({ dryRun: true, mode: "every-day" });
    expect(r.json().days[0].hours).toEqual([4, 4]);
    expect(sap.state.entries).toHaveLength(before);
  });

  it("std_set / std_fill_open / std_staffing_apply / mp_allocate_many support dryRun", async () => {
    const before = sap.state.entries.length;
    expect((await call("std_set", { dates: ["2026-09-23"], item: { attendanceType: "0010" }, dryRun: true })).json()).toHaveProperty("toCreate");
    expect((await call("std_fill_open", { from: "2026-09-23", to: "2026-09-23", item: { attendanceType: "0077" }, dryRun: true })).json()).toHaveProperty("dryRun", true);
    expect((await call("std_staffing_apply", { from: "2026-09-01", to: "2026-09-30", dryRun: true })).json()).toHaveProperty("toBook");
    expect((await call("mp_allocate_many", { year: 2026, month: 9, slots: [{ project: { attendanceType: "0077" }, range: { from: "2026-09-23", to: "2026-09-23" }, hours: 1 }], dryRun: true })).json()).toHaveProperty("days");
    expect(sap.state.entries).toHaveLength(before);
  });
});
