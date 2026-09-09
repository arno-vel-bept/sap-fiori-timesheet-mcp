import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeXflow, fakeSession, type FakeXflow } from "./fixtures/fake-xflow.js";
import { SapClient } from "../src/sap/client.js";
import { StandardTimesheet } from "../src/timesheet/standard.js";

let sap: FakeXflow;
let ts: StandardTimesheet;
beforeAll(async () => {
  sap = await startFakeXflow();
});
afterAll(() => sap.close());
beforeEach(() => {
  ts = new StandardTimesheet(new SapClient(fakeSession(sap.baseUrl)));
});

describe("StandardTimesheet · reading", () => {
  it("resolves the personnel number and profile info", async () => {
    expect(await ts.pernr()).toBe("08765432");
    const info = await ts.info();
    expect(info).toMatchObject({ pernr: "08765432", profileId: "MA-FACHL", releaseDirectly: true, country: "FR" });
  });

  it("lists calendar days with target hours and period status", async () => {
    const days = await ts.calendar("2026-09-01", "2026-09-07");
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ date: "2026-09-01", status: "YACTION", targetHours: 8, workingDay: true, closed: false });
    expect(days[4]).toMatchObject({ date: "2026-09-05", targetHours: 0, workingDay: false });
  });

  it("parses the flat TimeDataList into structured entries", async () => {
    const entries = await ts.entries("2026-08-01", "2026-09-30");
    expect(entries).toHaveLength(4);
    const ftv = entries.find((e) => e.date === "2026-09-01")!;
    expect(ftv).toMatchObject({
      counter: "000054598801",
      hours: 8,
      status: "MSAVE",
      statusText: "Saved",
      released: false,
      attendanceType: { code: "0800", text: "Chargeable Hours" },
      salesOrder: { code: "3136787", text: "Acme Portal - User Data Study" },
      salesOrderItem: { code: "000401", text: "Trip costs" },
      text: "Acme Portal - User Data Study",
    });
    const nch = entries.find((e) => e.date === "2026-09-02")!;
    expect(nch).toMatchObject({ hours: 4, status: "RELEASED", released: true, order: { code: "900140", text: "AI Incubator - NovaLabs" }, attendanceType: { code: "0081", text: "NCH-Order BAP" } });
    expect(nch.salesOrder).toBeUndefined();
    expect(nch.label).toBe("AI Incubator - NovaLabs (900140) · NCH-Order BAP (0081)");
  });

  it("lists open days: working days in open periods with hours still missing, with their entries", async () => {
    const open = await ts.openDays("2026-08-25", "2026-09-06");
    // August is closed, 5/6 Sept are the weekend, 1 Sept is fully booked (8h)
    expect(open.map((d) => d.date)).toEqual(["2026-09-02", "2026-09-03", "2026-09-04"]);
    expect(open[0]).toMatchObject({ targetHours: 8, bookedHours: 4, missingHours: 4 });
    expect(open[0].entries).toHaveLength(1);
    expect(open[1]).toMatchObject({ bookedHours: 0, missingHours: 8, entries: [] });
  });

  it("lists favorites with a normalized item", async () => {
    const favs = await ts.favorites();
    expect(favs).toHaveLength(3);
    expect(favs[0]).toMatchObject({ id: "20211220104922.9994940", name: "Acme Portal 2022", item: { attendanceType: "0800", salesOrder: "3136787", salesOrderItem: "000401" } });
    expect(favs[1]).toMatchObject({ name: "Holiday", hours: 8, item: { attendanceType: "0010" } });
  });

  it("queries value helps: attendance types, chargeable / non-chargeable orders, sales order items", async () => {
    const att = await ts.attendanceTypes();
    expect(att.map((a) => a.code)).toContain("0010");
    expect(att.find((a) => a.code === "0010")?.text).toBe("Holiday (full day)");

    const ch = await ts.chargeableOrders("Globex");
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ code: "3141993", text: "Globex Coupa Invoicing & RPMA", client: "GLOBEX PHARMA" });

    const nch = await ts.nonChargeableOrders();
    expect(nch.map((o) => o.code)).toEqual(["900140", "900004", "E90099010006"]);

    const items = await ts.salesOrderItems("3136787");
    expect(items.map((i) => i.code)).toEqual(["000401", "000112"]);
    const last = sap.requests.at(-1)!;
    expect(decodeURIComponent(last.path)).toContain("FieldName eq 'RKDPOS'");
    expect(decodeURIComponent(last.path)).toMatch(/FieldRelated eq 'RKDAUF = 3136787'/);
  });

  it("lists the worklist grouped by record", async () => {
    const wl = await ts.worklist("2026-09-01", "2026-09-30");
    expect(wl).toHaveLength(2);
    expect(wl[0]).toMatchObject({ item: { salesOrder: "3136787", salesOrderItem: "000401" }, label: expect.stringContaining("Acme") });
    expect(wl[1]).toMatchObject({ item: { order: "900140" } });
  });
});

describe("StandardTimesheet · writing", () => {
  it("fills several days with one item in a single $batch (one changeset per entry) and releases", async () => {
    const before = sap.state.entries.length;
    const res = await ts.fill(["2026-09-03", "2026-09-04"], { order: "900140", attendanceType: "0081" }, 8, { shortText: "NovaLabs dev" });
    expect(res.every((r) => r.ok)).toBe(true);
    expect(res.map((r) => r.date)).toEqual(["2026-09-03", "2026-09-04"]);
    expect(res[0].counter).toMatch(/^\d{12}$/);
    expect(sap.state.entries).toHaveLength(before + 2);
    const created = sap.state.entries.at(-1)!;
    expect(created).toMatchObject({ workdate: "20260904", hours: 8, status: "RELEASED", fields: { RAUFNR: "000000900140", AWART: "0081", LTXA1: "NovaLabs dev" } });

    const batch = sap.requests.filter((r) => r.path.endsWith("/$batch")).at(-1)!;
    expect(batch.body.match(/POST TimeEntries HTTP\/1\.1/g)).toHaveLength(2);
    expect(batch.body.match(/Content-Type: multipart\/mixed; boundary=/g)!.length).toBe(2); // one changeset per entry
    expect(batch.body).toContain('"WORKDATE":"2026-09-03T00:00:00"');
    expect(batch.body).toContain('"TimeEntryRelease":"X"');
    expect(batch.body).toContain('"Line_Count":"2"');
  });

  it("can save without releasing", async () => {
    const res = await ts.fill(["2026-09-08"], { attendanceType: "0010" }, 8, { release: false });
    expect(res[0].ok).toBe(true);
    expect(sap.state.entries.find((e) => e.counter === res[0].counter)?.status).toBe("MSAVE");
  });

  it("reports per-entry errors from the batch without failing the others", async () => {
    const res = await ts.fill(["2026-08-20", "2026-09-09"], { attendanceType: "0010" }, 8);
    expect(res[0]).toMatchObject({ ok: false, date: "2026-08-20", error: expect.stringMatching(/closed/i) });
    expect(res[1]).toMatchObject({ ok: true, date: "2026-09-09" });
  });

  it("rejects an item with no order and no attendance type before calling SAP", async () => {
    await expect(ts.fill(["2026-09-10"], {}, 8)).rejects.toThrow(/attendance type or an order/i);
  });

  it("fills from a favorite (hours default to the favorite's)", async () => {
    const favs = await ts.favorites();
    const holiday = favs.find((f) => f.name === "Holiday")!;
    const res = await ts.fillFromFavorite(["2026-09-11"], holiday);
    expect(res[0].ok).toBe(true);
    expect(sap.state.entries.find((e) => e.counter === res[0].counter)).toMatchObject({ hours: 8, fields: { AWART: "0010" } });
  });

  it("removes entries by counter (looking up their dates) and reports unknown counters", async () => {
    const res = await ts.fill(["2026-09-15"], { attendanceType: "0077" }, 8);
    const counter = res[0].counter!;
    const removed = await ts.remove([counter, "000000000001"], { from: "2026-09-01", to: "2026-09-30" });
    expect(removed).toEqual([
      { ok: true, counter, date: "2026-09-15" },
      { ok: false, counter: "000000000001", error: expect.stringMatching(/not found/i) },
    ]);
    expect(sap.state.entries.some((e) => e.counter === counter)).toBe(false);
    const batch = sap.requests.filter((r) => r.path.endsWith("/$batch")).at(-1)!;
    expect(batch.body).toContain('"TimeEntryOperation":"D"');
    expect(batch.body).not.toContain("TimeEntryRelease");
  });

  it("updates an existing entry's hours", async () => {
    const [created] = await ts.fill(["2026-09-16"], { attendanceType: "0077" }, 8);
    const [upd] = await ts.update([{ counter: created.counter!, date: "2026-09-16", item: { attendanceType: "0077" }, hours: 4 }]);
    expect(upd.ok).toBe(true);
    expect(sap.state.entries.find((e) => e.counter === created.counter)?.hours).toBe(4);
  });

  it("adds and deletes favorites", async () => {
    const fav = await ts.addFavorite("Admin", { attendanceType: "0077" }, 8);
    expect(fav).toMatchObject({ name: "Admin", item: { attendanceType: "0077" }, hours: 8 });
    expect((await ts.favorites()).some((f) => f.id === fav.id)).toBe(true);
    await ts.deleteFavorite(fav.id);
    expect((await ts.favorites()).some((f) => f.id === fav.id)).toBe(false);
  });
});

describe("StandardTimesheet · user flows", () => {
  // Fresh server so the expectations below do not depend on what earlier tests booked.
  let flowSap: FakeXflow;
  beforeAll(async () => {
    flowSap = await startFakeXflow();
    sap = flowSap;
  });
  afterAll(() => flowSap.close());

  it("days(): every working day of the range with filled / missing state", async () => {
    const days = await ts.days("2026-08-31", "2026-09-04");
    expect(days.map((d) => [d.date, d.filled, d.closed])).toEqual([
      ["2026-08-31", false, true], // closed period, nothing booked
      ["2026-09-01", true, false], // 8h booked
      ["2026-09-02", false, false], // 4h of 8
      ["2026-09-03", false, false],
      ["2026-09-04", false, false],
    ]);
    expect(days[1]).toMatchObject({ bookedHours: 8, missingHours: 0, entries: [expect.objectContaining({ counter: "000054598801" })] });
  });

  it("set(): replaces whatever is on the given days with the item", async () => {
    const res = await ts.set(["2026-09-02", "2026-09-17"], { attendanceType: "0010" }, 8);
    expect(res.removed).toEqual([{ ok: true, counter: "000054598802", date: "2026-09-02" }]);
    expect(res.created.map((r) => [r.date, r.ok])).toEqual([
      ["2026-09-02", true],
      ["2026-09-17", true],
    ]);
    const sept2 = sap.state.entries.filter((e) => e.workdate === "20260902");
    expect(sept2).toHaveLength(1);
    expect(sept2[0]).toMatchObject({ hours: 8, fields: { AWART: "0010" } });
    // one batch carried both the delete and the creates
    const batch = sap.requests.filter((r) => r.path.endsWith("/$batch")).at(-1)!;
    expect(batch.body).toContain('"TimeEntryOperation":"D"');
    expect(batch.body.match(/"TimeEntryOperation":"C"/g)).toHaveLength(2);
  });

  it("jobcodes(): which codes the range contains, with day counts, hours and share", async () => {
    const stats = await ts.jobcodes("2026-09-01", "2026-09-30");
    const ftv = stats.find((s) => s.item.salesOrder === "3136787")!;
    expect(ftv).toMatchObject({ days: 1, hours: 8, dates: ["2026-09-01"] });
    expect(ftv.share).toBeGreaterThan(0);
    expect(stats.reduce((a, s) => a + s.share, 0)).toBeCloseTo(100, 1);
    // filter by code(s): order, sales order or attendance type
    const only = await ts.jobcodes("2026-09-01", "2026-09-30", { codes: ["0010", "900140"] });
    expect(only.every((s) => s.item.attendanceType === "0010" || s.item.order === "900140")).toBe(true);
    expect(await ts.jobcodes("2026-09-01", "2026-09-30", { codes: ["9999999"] })).toEqual([]);
  });

  it("staffing(): planned entries from MDS for the range", async () => {
    const plan = await ts.staffing("2026-09-01", "2026-09-30");
    expect(plan.length).toBe(9);
    expect(plan[0]).toMatchObject({ date: "2026-09-01", hours: 8, status: "Planned", order: { code: "900140" }, attendanceType: { code: "0081" } });
  });

  it("applyStaffing(): books the plan on open days that still miss the hours (skipping closed / full days)", async () => {
    const before = sap.state.entries.length;
    const res = await ts.applyStaffing("2026-09-01", "2026-09-11");
    // 09-01 already full (8h), 09-02 was set to 8h holiday above => skipped; remaining planned days booked
    expect(res.skipped.map((s) => s.date)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(res.created.filter((r) => r.ok).map((r) => r.date)).toEqual(["2026-09-03", "2026-09-04", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]);
    expect(sap.state.entries.length).toBe(before + 7);
    expect(sap.state.entries.at(-1)).toMatchObject({ workdate: "20260911", hours: 8, fields: { RAUFNR: "000000900140", AWART: "0081" } });
    // restricted to specific dates
    const again = await ts.applyStaffing("2026-09-01", "2026-09-11", { dates: ["2026-09-03"] });
    expect(again.created).toEqual([]);
    expect(again.skipped.map((s) => s.date)).toEqual(["2026-09-03"]);
  });

  it("fillOpen(): fills every open day of the range with the item, hours = what is missing", async () => {
    // 09-14 .. 09-18 are empty working days; 09-17 got 8h above => not open
    const res = await ts.fillOpen("2026-09-14", "2026-09-18", { attendanceType: "0077" });
    expect(res.map((r) => [r.date, r.hours])).toEqual([
      ["2026-09-14", 8],
      ["2026-09-15", 8],
      ["2026-09-16", 8],
      ["2026-09-18", 8],
    ]);
    expect(res.every((r) => r.ok)).toBe(true);
    // capped hours per day
    const capped = await ts.fillOpen("2026-09-21", "2026-09-22", { attendanceType: "0077" }, { maxHours: 2 });
    expect(capped.map((r) => r.hours)).toEqual([2, 2]);
    expect((await ts.openDays("2026-09-21", "2026-09-22")).map((d) => d.missingHours)).toEqual([6, 6]);
  });
});

describe("StandardTimesheet · previews (dry runs)", () => {
  let flowSap: FakeXflow;
  beforeAll(async () => {
    flowSap = await startFakeXflow();
    sap = flowSap;
  });
  afterAll(() => flowSap.close());

  it("planSet(): what would be removed and created, without writing", async () => {
    const before = sap.state.entries.length;
    const plan = await ts.planSet(["2026-09-02", "2026-09-03"], { attendanceType: "0010" }, 8);
    expect(plan.toRemove.map((e) => e.counter)).toEqual(["000054598802"]);
    expect(plan.toCreate).toEqual([
      { date: "2026-09-02", hours: 8 },
      { date: "2026-09-03", hours: 8 },
    ]);
    expect(sap.state.entries).toHaveLength(before);
  });

  it("planFillOpen(): the days and hours fill-open would book", async () => {
    const plan = await ts.planFillOpen("2026-09-01", "2026-09-04", { attendanceType: "0077" }, { maxHours: 2 });
    expect(plan).toEqual([
      { date: "2026-09-02", hours: 2 },
      { date: "2026-09-03", hours: 2 },
      { date: "2026-09-04", hours: 2 },
    ]);
  });

  it("planStaffing(): what apply would book and skip", async () => {
    const plan = await ts.planStaffing("2026-09-01", "2026-09-04");
    expect(plan.toBook.map((b) => b.date)).toEqual(["2026-09-03", "2026-09-04"]);
    expect(plan.toBook[0]).toMatchObject({ hours: 8, item: { order: "900140", attendanceType: "0081" } });
    expect(plan.skipped.map((s) => s.date)).toEqual(["2026-09-01", "2026-09-02"]);
  });
});
