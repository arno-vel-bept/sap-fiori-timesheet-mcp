import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startFakeXflow, fakeSession, type FakeXflow } from "./fixtures/fake-xflow.js";
import { runCli } from "../src/cli/main.js";
import { SessionStore } from "../src/auth/session-store.js";

let sap: FakeXflow;
let env: Record<string, string>;
beforeAll(async () => {
  sap = await startFakeXflow();
  const dir = mkdtempSync(join(tmpdir(), "xflow-cli-ts-"));
  env = { XFLOW_LAUNCHPAD_URL: `${sap.baseUrl}/fiori/shells/abap/FioriLaunchpad.html#Shell-home`, XFLOW_SESSION_FILE: join(dir, "s.json") };
  await new SessionStore(env.XFLOW_SESSION_FILE).save(fakeSession(sap.baseUrl));
});
afterAll(() => sap.close());

async function cli(args: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c.toString()));
  stderr.on("data", (c) => (err += c.toString()));
  const code = await runCli(args, { env, stdin: new PassThrough(), stdout, stderr });
  return { code, out, err, json: () => JSON.parse(out) };
}

describe("standard timesheet commands", () => {
  it("std open-days prints a table and --json prints machine output", async () => {
    const r = await cli(["std", "open-days", "--from", "2026-09-01", "--to", "2026-09-06"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2026-09-02/);
    expect(r.out).toMatch(/AI Incubator/);
    const j = await cli(["std", "open-days", "--from", "2026-09-01", "--to", "2026-09-06", "--json"]);
    expect(j.json().map((d: { date: string }) => d.date)).toEqual(["2026-09-02", "2026-09-03", "2026-09-04"]);
  });

  it("std entries lists entries of a range", async () => {
    const r = await cli(["std", "entries", "--from", "2026-08-01", "--to", "2026-08-31", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toHaveLength(2);
    expect(r.json()[0]).toMatchObject({ counter: "000054598661", hours: 8 });
  });

  it("std favorites lists favorites", async () => {
    const r = await cli(["std", "favorites"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Holiday");
    expect(r.out).toContain("0010");
  });

  it("std attendance-types / chargeable-orders / non-chargeable-orders / sales-order-items query value helps", async () => {
    expect((await cli(["std", "attendance-types"])).out).toContain("Holiday (full day)");
    const ch = await cli(["std", "chargeable-orders", "Globex", "--json"]);
    expect(ch.json()[0]).toMatchObject({ code: "3141993" });
    expect((await cli(["std", "non-chargeable-orders"])).out).toContain("900140");
    const items = await cli(["std", "sales-order-items", "3136787", "--json"]);
    expect(items.json().map((i: { code: string }) => i.code)).toEqual(["000401", "000112"]);
  });

  it("std fill books hours on several days (order + attendance type, or a favorite) and prints per-day results", async () => {
    const before = sap.state.entries.length;
    const r = await cli(["std", "fill", "2026-09-03", "2026-09-04", "--order", "900140", "--attendance-type", "0081", "--hours", "8", "--short-text", "dev"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2026-09-03.*ok/);
    expect(sap.state.entries).toHaveLength(before + 2);

    const f = await cli(["std", "fill", "2026-09-08", "--favorite", "Holiday", "--json"]);
    expect(f.code).toBe(0);
    expect(f.json()[0]).toMatchObject({ ok: true, date: "2026-09-08" });
    expect(sap.state.entries.at(-1)).toMatchObject({ workdate: "20260908", hours: 8, fields: { AWART: "0010" } });
  });

  it("std fill supports date ranges and --no-release, and exits 4 when any day fails", async () => {
    const r = await cli(["std", "fill", "2026-08-28..2026-09-01", "--attendance-type", "0077", "--hours", "8", "--no-release", "--json"]);
    expect(r.code).toBe(4);
    const res = r.json() as { ok: boolean; date: string }[];
    expect(res.map((x) => x.date)).toEqual(["2026-08-28", "2026-08-31", "2026-09-01"]); // weekend skipped
    expect(res.filter((x) => x.ok).map((x) => x.date)).toEqual(["2026-09-01"]);
    expect(sap.state.entries.find((e) => e.workdate === "20260901" && e.fields.AWART === "0077")?.status).toBe("MSAVE");
  });

  it("std remove deletes entries by counter", async () => {
    const created = await cli(["std", "fill", "2026-09-15", "--attendance-type", "0077", "--hours", "8", "--json"]);
    const counter = created.json()[0].counter as string;
    const r = await cli(["std", "remove", counter, "--from", "2026-09-01", "--to", "2026-09-30"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`${counter}.*ok`));
    expect(sap.state.entries.some((e) => e.counter === counter)).toBe(false);
  });

  it("std favorite add / remove", async () => {
    const add = await cli(["std", "favorite", "add", "Admin day", "--attendance-type", "0077", "--hours", "8", "--json"]);
    expect(add.code).toBe(0);
    const id = add.json().id as string;
    expect((await cli(["std", "favorites", "--json"])).json().some((f: { id: string }) => f.id === id)).toBe(true);
    expect((await cli(["std", "favorite", "remove", id])).code).toBe(0);
    expect((await cli(["std", "favorites", "--json"])).json().some((f: { id: string }) => f.id === id)).toBe(false);
  });
});

describe("multiproject timesheet commands", () => {
  it("mp months lists months", async () => {
    const r = await cli(["mp", "months", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()[0]).toMatchObject({ year: 2026, month: 9 });
  });

  it("mp month shows the grid", async () => {
    const r = await cli(["mp", "month", "2026-09"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PROJECT1/);
    expect(r.out).toMatch(/2026-09-01/);
    const j = await cli(["mp", "month", "2026-09", "--json"]);
    expect(j.json().projects.length).toBeGreaterThanOrEqual(2);
    expect(j.json().projects[0]).toMatchObject({ column: "PROJECT1", salesOrder: "0003136787" });
  });

  it("mp allocate books hours per day on a project", async () => {
    const before = sap.state.entries.length;
    const r = await cli(["mp", "allocate", "2026-09", "--order", "900004", "--attendance-type", "0081", "--day", "2026-09-03=4", "--day", "2026-09-04=8", "--text", "Ops Support"]);
    expect(r.code).toBe(0);
    expect(sap.state.entries).toHaveLength(before + 2);
    expect(r.out).toMatch(/900004/);
  });

  it("mp clear removes a project's hours on given days", async () => {
    await cli(["mp", "allocate", "2026-09", "--attendance-type", "0010", "--day", "2026-09-10=8", "--day", "2026-09-11=8"]);
    const n = sap.state.entries.length;
    const r = await cli(["mp", "clear", "2026-09", "--attendance-type", "0010", "--dates", "2026-09-10"]);
    expect(r.code).toBe(0);
    expect(sap.state.entries).toHaveLength(n - 1);
  });

  it("reports timesheet errors with exit code 4", async () => {
    const r = await cli(["mp", "allocate", "2026-08", "--attendance-type", "0010", "--day", "2026-08-20=8"]);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/closed/i);
  });
});

describe("user-flow commands", () => {
  it("std days shows filled and missing days", async () => {
    const r = await cli(["std", "days", "--from", "2026-09-01", "--to", "2026-09-02"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2026-09-01.*(filled|✓)/);
    expect(r.out).toMatch(/2026-09-02/);
  });

  it("std set replaces the entries of the given days", async () => {
    const r = await cli(["std", "set", "2026-09-22", "--attendance-type", "0010", "--hours", "8", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().created[0]).toMatchObject({ ok: true, date: "2026-09-22" });
    expect(sap.state.entries.filter((e) => e.workdate === "20260922")).toHaveLength(1);
  });

  it("std jobcodes lists codes with counts, optionally filtered", async () => {
    const r = await cli(["std", "jobcodes", "--from", "2026-09-01", "--to", "2026-09-30"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/days/);
    const f = await cli(["std", "jobcodes", "0010", "--from", "2026-09-01", "--to", "2026-09-30", "--json"]);
    expect(f.json().every((s: { item: { attendanceType?: string } }) => s.item.attendanceType === "0010")).toBe(true);
  });

  it("std staffing lists the plan and --apply books it", async () => {
    const r = await cli(["std", "staffing", "--from", "2026-09-01", "--to", "2026-09-30", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()[0]).toMatchObject({ status: "Planned" });
    const a = await cli(["std", "staffing", "--from", "2026-09-01", "--to", "2026-09-30", "--apply", "--json"]);
    expect([0, 4]).toContain(a.code);
    expect(a.json()).toHaveProperty("created");
  });

  it("std fill-open fills all open days of the range", async () => {
    const r = await cli(["std", "fill-open", "--from", "2026-09-28", "--to", "2026-09-30", "--attendance-type", "0077", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().map((x: { date: string }) => x.date)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
  });

  it("mp allocate accepts --range with --hours", async () => {
    const before = sap.state.entries.length;
    const r = await cli(["mp", "allocate", "2026-09", "--attendance-type", "0077", "--range", "2026-09-07..2026-09-09", "--hours", "1"]);
    expect(r.code).toBe(0);
    expect(sap.state.entries.length).toBe(before + 3);
  });

  it("mp plan books several slots per day over a range in one save", async () => {
    const before = sap.state.entries.length;
    const r = await cli(["mp", "plan", "2026-09", "--range", "2026-09-14..2026-09-15", "--slot", "order=900140,att=0081:2", "--slot", "att=0010:6"]);
    expect(r.code, r.err).toBe(0);
    expect(sap.state.entries.length).toBe(before + 4);
  });

  it("mp stats shows proportions", async () => {
    const r = await cli(["mp", "stats", "2026-09", "--from", "2026-09-14", "--to", "2026-09-15"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/%/);
    const j = await cli(["mp", "stats", "2026-09", "--from", "2026-09-14", "--to", "2026-09-15", "--json"]);
    expect(j.json().totalHours).toBe(16);
  });

  it("mp balance rewrites a range to proportions", async () => {
    const r = await cli(["mp", "balance", "2026-09", "--range", "2026-09-16..2026-09-18", "--slot", "att=0077:50%", "--slot", "att=0010:50%", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.json().totalHours).toBe(24);
    expect(r.json().projects.map((p: { share: number }) => p.share).sort()).toEqual([50, 50]);
  });
});

describe("dry runs and clearer interfaces", () => {
  it("std set --dry-run prints the plan and writes nothing", async () => {
    const before = sap.state.entries.length;
    const r = await cli(["std", "set", "2026-09-24", "--attendance-type", "0010", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dry run/i);
    expect(r.out).toMatch(/2026-09-24/);
    expect(sap.state.entries).toHaveLength(before);
  });

  it("std fill-open --dry-run and std staffing --apply --dry-run write nothing", async () => {
    const before = sap.state.entries.length;
    const a = await cli(["std", "fill-open", "--from", "2026-09-24", "--to", "2026-09-25", "--attendance-type", "0077", "--dry-run"]);
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/dry run/i);
    const b = await cli(["std", "staffing", "--from", "2026-09-01", "--to", "2026-09-30", "--apply", "--dry-run"]);
    expect(b.code).toBe(0);
    expect(b.out).toMatch(/dry run/i);
    expect(sap.state.entries).toHaveLength(before);
  });

  it("mp plan / mp balance --dry-run print a per-day table and write nothing; slot keys accept 'attendance'", async () => {
    const before = sap.state.entries.length;
    const p = await cli(["mp", "plan", "2026-09", "--range", "2026-09-24..2026-09-25", "--slot", "attendance=0077:2", "--slot", "order=900140,attendance=0081:6", "--dry-run"]);
    expect(p.code, p.err).toBe(0);
    expect(p.out).toMatch(/dry run/i);
    expect(p.out).toMatch(/2026-09-24/);
    const b = await cli(["mp", "balance", "2026-09", "--range", "2026-09-24..2026-09-25", "--slot", "attendance=0077:50%", "--slot", "attendance=0010:50%", "--mode", "every-day", "--dry-run"]);
    expect(b.code, b.err).toBe(0);
    expect(b.out).toMatch(/every-day/);
    expect(b.out).toMatch(/2026-09-25/);
    expect(sap.state.entries).toHaveLength(before);
  });

  it("mp balance --mode every-day splits each day", async () => {
    const r = await cli(["mp", "balance", "2026-09", "--range", "2026-09-28..2026-09-29", "--slot", "att=0077:50%", "--slot", "att=0010:50%", "--mode", "every-day", "--json"]);
    expect(r.code, r.err).toBe(0);
    for (const d of r.json().perDay) expect(Object.values(d.cells)).toEqual([4, 4]);
  });

  it("rejects an unknown --mode with a helpful message", async () => {
    const r = await cli(["mp", "balance", "2026-09", "--range", "2026-09-28..2026-09-29", "--slot", "att=0077:100%", "--mode", "weird"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/whole-days|every-day/);
  });
});
