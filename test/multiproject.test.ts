import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeXflow, fakeSession, type FakeXflow } from "./fixtures/fake-xflow.js";
import { SapClient } from "../src/sap/client.js";
import { MultiprojectTimesheet } from "../src/timesheet/multiproject.js";

let sap: FakeXflow;
let mp: MultiprojectTimesheet;
beforeAll(async () => {
  sap = await startFakeXflow();
});
afterAll(() => sap.close());
beforeEach(() => {
  mp = new MultiprojectTimesheet(new SapClient(fakeSession(sap.baseUrl)));
});

describe("MultiprojectTimesheet · reading", () => {
  it("lists months with status and hour totals", async () => {
    const months = await mp.months();
    expect(months[0]).toMatchObject({ year: 2026, month: 9, status: "YACTION", closed: false });
    expect(months[1]).toMatchObject({ year: 2026, month: 8, status: "PER_CLOSED", closed: true, totalHours: 16 });
    expect(typeof months[0].missingHours).toBe("number");
  });

  it("returns a month as projects (columns) x days (rows)", async () => {
    const sheet = await mp.month(2026, 9);
    expect(sheet).toMatchObject({ year: 2026, month: 9, closed: false });
    expect(sheet.projects).toHaveLength(2);
    expect(sheet.projects[0]).toMatchObject({ column: "PROJECT1", salesOrder: "0003136787", salesOrderItem: "000401", attendanceType: "0800", text: "Acme Portal - User Data Study" });
    expect(sheet.projects[1]).toMatchObject({ column: "PROJECT2", order: "000000900140", attendanceType: "0081" });
    expect(sheet.days).toHaveLength(30);
    const d1 = sheet.days.find((d) => d.date === "2026-09-01")!;
    expect(d1.targetHours).toBe(8);
    expect(d1.cells.PROJECT1).toMatchObject({ hours: 8, counter: "000054598801" });
    expect(d1.totalHours).toBe(8);
    expect(sheet.days.find((d) => d.date === "2026-09-02")!.cells.PROJECT2).toMatchObject({ hours: 4 });
  });
});

describe("MultiprojectTimesheet · writing", () => {
  it("allocates hours on several days for a new project: locks, posts UpdateTimeDataSet, unlocks", async () => {
    const before = sap.state.entries.length;
    const sheet = await mp.allocate(2026, 9, { order: "900004", attendanceType: "0081" }, [
      { date: "2026-09-03", hours: 4, text: "Ops Support workshop" },
      { date: "2026-09-04", hours: 8 },
    ]);
    expect(sap.state.entries).toHaveLength(before + 2);
    expect(sap.state.entries.at(-1)).toMatchObject({ workdate: "20260904", hours: 8, fields: { RAUFNR: "000000900004", AWART: "0081" } });
    expect(sap.state.lock).toMatchObject({ held: false, unlocks: 1 });
    // returned sheet is refreshed
    const p = sheet.projects.find((x) => x.order.replace(/^0+/, "") === "900004")!;
    expect(sheet.days.find((d) => d.date === "2026-09-03")!.cells[p.column]).toMatchObject({ hours: 4, text: "Ops Support workshop" });

    const post = sap.requests.find((r) => r.path.includes("UpdateTimeDataSet"))!;
    const body = JSON.parse(post.body) as { ColumnData: string; RowData: string };
    const cols = JSON.parse(body.ColumnData) as { COLNAME: string; COLINFO: Record<string, string> }[];
    expect(Array.isArray(cols)).toBe(true); // bare array, like the Fiori app sends
    expect(cols.map((c) => c.COLNAME)).toEqual(["PROJECT1", "PROJECT2", "PROJECT3"]);
    expect(cols[2].COLINFO).toEqual({ RAUFNR: "900004", AWART: "0081", RKDAUF: "", RKDPOS: "000000", ZZTEXT: "", ZZLAND: "", ZZBLAND: "" });
    const rows = JSON.parse(body.RowData) as Record<string, unknown>[];
    expect(rows).toHaveLength(30);
    expect(rows[2]).toMatchObject({ DATE: "2026-09-03", PROJECT3: { HOURS: "4.00", COUNTER: "", TEXT: "Ops Support workshop", LONGTEXT: "" } });
    expect(rows[0]).toMatchObject({ PROJECT1: { HOURS: "8.00", COUNTER: "000054598801" } });
    // lock sequence around the save
    const seq = sap.requests.map((r) => r.path).filter((p) => /Cats|UpdateTimeDataSet/.test(p)).map((p) => p.split("/").pop()!.split("?")[0]);
    expect(seq).toEqual(["CatsLock", "UpdateTimeDataSet", "CatsUnlock"]);
  });

  it("reuses an existing column for the same project and updates existing cells", async () => {
    await mp.allocate(2026, 9, { order: "900140", attendanceType: "0081" }, [{ date: "2026-09-02", hours: 6 }]);
    const e = sap.state.entries.find((x) => x.counter === "000054598802")!;
    expect(e.hours).toBe(6);
    const sheet = await mp.month(2026, 9);
    expect(sheet.projects.filter((p) => p.order.endsWith("900140"))).toHaveLength(1);
  });

  it("clears allocations (deletes the entries) for given days of a project", async () => {
    await mp.allocate(2026, 9, { attendanceType: "0010" }, [{ date: "2026-09-10", hours: 8 }, { date: "2026-09-11", hours: 8 }]);
    const n = sap.state.entries.length;
    await mp.clear(2026, 9, { attendanceType: "0010" }, ["2026-09-10"]);
    expect(sap.state.entries).toHaveLength(n - 1);
    expect(sap.state.entries.some((e) => e.workdate === "20260911" && e.fields.AWART === "0010")).toBe(true);
  });

  it("refuses to write into a closed month", async () => {
    await expect(mp.allocate(2026, 8, { attendanceType: "0010" }, [{ date: "2026-08-20", hours: 8 }])).rejects.toThrow(/closed/i);
    expect(sap.state.lock.held).toBe(false);
  });

  it("releases the lock when SAP rejects the update", async () => {
    await expect(mp.allocate(2026, 9, { attendanceType: "9999" }, [{ date: "2026-09-12", hours: 8 }])).rejects.toThrow(/unknown attendance type/i);
    expect(sap.state.lock.held).toBe(false);
  });

  it("fails clearly when the timesheet is locked by someone else", async () => {
    sap.state.lock.held = true;
    try {
      await expect(mp.allocate(2026, 9, { attendanceType: "0077" }, [{ date: "2026-09-14", hours: 8 }])).rejects.toThrow(/locked/i);
    } finally {
      sap.state.lock.held = false;
    }
  });
});

describe("MultiprojectTimesheet · user flows", () => {
  it("allocateMany(): several projects on a date range in one save (2h X + 6h Y every working day)", async () => {
    const before = sap.state.entries.length;
    const sheet = await mp.allocateMany(2026, 9, [
      { project: { order: "900140", attendanceType: "0081" }, range: { from: "2026-09-21", to: "2026-09-25" }, hours: 2 },
      { project: { attendanceType: "0077" }, range: { from: "2026-09-21", to: "2026-09-25" }, hours: 6 },
    ]);
    // 900140 column already existed with 09-02; the 0077 column is new
    expect(sap.state.entries.length).toBe(before + 10);
    const d = sheet.days.find((x) => x.date === "2026-09-23")!;
    expect(d.totalHours).toBe(8);
    expect(sap.requests.filter((r) => r.path.includes("UpdateTimeDataSet")).length).toBeGreaterThan(0);
    const locks = sap.requests.map((r) => r.path).filter((p) => /CatsLock/.test(p)).length;
    expect(sap.state.lock.held).toBe(false);
    expect(locks).toBeGreaterThan(0);
  });

  it("stats(): jobcodes present in a range with hours, days and proportion", async () => {
    const stats = await mp.stats(2026, 9, { from: "2026-09-21", to: "2026-09-25" });
    const x = stats.projects.find((p) => p.project.order.endsWith("900140"))!;
    const y = stats.projects.find((p) => p.project.attendanceType === "0077" && !p.project.order)!;
    expect(x).toMatchObject({ hours: 10, days: 5, share: 25 });
    expect(y).toMatchObject({ hours: 30, days: 5, share: 75 });
    expect(stats.totalHours).toBe(40);
    expect(stats.targetHours).toBe(40);
    const day = await mp.stats(2026, 9, { from: "2026-09-23", to: "2026-09-23" });
    expect(day.projects.map((p) => p.share).sort((a, b) => a - b)).toEqual([25, 75]);
  });

  it("balance(): rewrites a range so the projects match the requested proportions (60/40 over two weeks)", async () => {
    const sheet = await mp.balance(
      2026,
      9,
      { from: "2026-09-14", to: "2026-09-25" },
      [
        { project: { order: "900140", attendanceType: "0081" }, share: 60 },
        { project: { attendanceType: "0077" }, share: 40 },
      ],
    );
    const stats = await mp.stats(2026, 9, { from: "2026-09-14", to: "2026-09-25" });
    expect(stats.targetHours).toBe(80);
    expect(stats.totalHours).toBe(80);
    const x = stats.projects.find((p) => p.project.order.endsWith("900140"))!;
    const y = stats.projects.find((p) => p.project.attendanceType === "0077" && !p.project.order)!;
    expect(x.hours).toBe(48);
    expect(y.hours).toBe(32);
    // every working day in the range is exactly at target, nothing else left on those days
    for (const d of sheet.days.filter((d) => d.date >= "2026-09-14" && d.date <= "2026-09-25" && d.targetHours > 0)) expect(d.totalHours).toBe(d.targetHours);
    // and the split is whole days first (48h = 6 days), then the rest
    expect(sheet.days.find((d) => d.date === "2026-09-14")!.cells[x.project.column].hours).toBe(8);
    expect(sheet.days.find((d) => d.date === "2026-09-25")!.cells[y.project.column].hours).toBe(8);
  });

  it("balance() rejects shares that do not add up to 100", async () => {
    await expect(mp.balance(2026, 9, { from: "2026-09-14", to: "2026-09-18" }, [{ project: { attendanceType: "0077" }, share: 70 }])).rejects.toThrow(/100/);
  });
});

describe("MultiprojectTimesheet · previews and balance modes", () => {
  it("previewBalance(): whole-days mode gives consecutive whole days, every-day mode splits each day", async () => {
    const range = { from: "2026-09-14", to: "2026-09-18" }; // 5 working days, 40h
    const slots = [
      { project: { order: "900140", attendanceType: "0081" }, share: 60 },
      { project: { attendanceType: "0077" }, share: 40 },
    ];
    const writesBefore = sap.requests.filter((r) => r.path.includes("UpdateTimeDataSet")).length;
    const whole = await mp.previewBalance(2026, 9, range, slots, { mode: "whole-days" });
    expect(whole.targetHours).toBe(40);
    expect(whole.slots.map((s) => s.hours)).toEqual([24, 16]);
    expect(whole.days.map((d) => d.hours)).toEqual([[8, 0], [8, 0], [8, 0], [0, 8], [0, 8]]);

    const daily = await mp.previewBalance(2026, 9, range, slots, { mode: "every-day" });
    expect(daily.slots.map((s) => s.hours)).toEqual([24, 16]);
    for (const d of daily.days) {
      expect(d.hours[0] + d.hours[1]).toBe(8);
      expect([4.75, 5]).toContain(d.hours[0]); // 60 % of 8h = 4.8, rounded to quarter hours
    }
    expect(daily.days.reduce((a, d) => a + d.hours[0], 0)).toBe(24);
    // nothing was written
    expect(sap.requests.filter((r) => r.path.includes("UpdateTimeDataSet")).length).toBe(writesBefore);
  });

  it("balance() honours the mode", async () => {
    const range = { from: "2026-09-16", to: "2026-09-17" };
    const sheet = await mp.balance(2026, 9, range, [{ project: { attendanceType: "0077" }, share: 50 }, { project: { attendanceType: "0010" }, share: 50 }], { mode: "every-day" });
    const admin = sheet.projects.find((p) => p.attendanceType === "0077" && !p.order)!;
    const hol = sheet.projects.find((p) => p.attendanceType === "0010" && !p.order)!;
    for (const d of sheet.days.filter((d) => d.date >= range.from && d.date <= range.to)) {
      expect(d.cells[admin.column].hours).toBe(4);
      expect(d.cells[hol.column].hours).toBe(4);
    }
  });

  it("previewAllocateMany(): resolves slots to per-day hours without writing", async () => {
    const before = sap.requests.length;
    const plan = await mp.previewAllocateMany(2026, 9, [
      { project: { attendanceType: "0077" }, range: { from: "2026-09-21", to: "2026-09-22" }, hours: 2 },
      { project: { attendanceType: "0010" }, days: [{ date: "2026-09-21", hours: 6 }] },
    ]);
    expect(plan.days.map((d) => [d.date, d.hours])).toEqual([
      ["2026-09-21", [2, 6]],
      ["2026-09-22", [2, 0]],
    ]);
    expect(plan.slots.map((s) => s.hours)).toEqual([4, 6]);
    expect(sap.requests.slice(before).some((r) => r.method === "POST")).toBe(false);
  });
});
