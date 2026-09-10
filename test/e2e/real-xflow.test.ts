/**
 * End-to-end tests against the REAL xflow system, using the stored login session.
 *
 *   XFLOW_E2E=1 pnpm test:e2e                  read-only checks
 *   XFLOW_E2E=1 XFLOW_E2E_WRITE=1 pnpm test:e2e   also creates, updates and deletes test entries
 *
 * Write tests only touch the current open month, book "Administration" (0077)
 * for 1 hour on a working day that still has missing hours, never release
 * standard entries to the manager, and delete everything they create.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config.js";
import { SessionStore } from "../../src/auth/session-store.js";
import { SapClient } from "../../src/sap/client.js";
import { StandardTimesheet } from "../../src/timesheet/standard.js";
import { MultiprojectTimesheet } from "../../src/timesheet/multiproject.js";
import { runCli } from "../../src/cli/main.js";
import { PassThrough } from "node:stream";

const enabled = process.env.XFLOW_E2E === "1";
const writes = enabled && process.env.XFLOW_E2E_WRITE === "1";
const cfg = resolveConfig();
const ADMIN = "0077"; // Administration (attendance type used for test bookings)

let client: SapClient;
let std: StandardTimesheet;
let mp: MultiprojectTimesheet;
let month: { year: number; month: number; from: string; to: string };

beforeAll(async () => {
  if (!enabled) return;
  const session = await new SessionStore(cfg.sessionFile).load();
  if (!session) throw new Error(`No session at ${cfg.sessionFile}; run "pnpm cli login" first`);
  client = new SapClient(session, { language: cfg.language });
  std = new StandardTimesheet(client);
  mp = new MultiprojectTimesheet(client);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const mm = String(m).padStart(2, "0");
  month = { year: y, month: m, from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}` };
});

async function cli(args: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c.toString()));
  stderr.on("data", (c) => (err += c.toString()));
  const code = await runCli(args, { stdin: new PassThrough(), stdout, stderr });
  return { code, out, err };
}

describe.skipIf(!enabled)("real xflow · read-only", () => {
  it("whoami resolves the SAP user", async () => {
    const r = await cli(["whoami"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/User\s+\d+/);
    expect(r.out).toMatch(/Client\s+006/);
  });

  it("standard: info, calendar, entries, open days are consistent", async () => {
    const info = await std.info();
    expect(info.pernr).toMatch(/^\d{8}$/);
    expect(info.profileId).not.toBe("");
    const cal = await std.calendar(month.from, month.to);
    expect(cal.length).toBeGreaterThanOrEqual(28);
    const entries = await std.entries(month.from, month.to);
    for (const e of entries) {
      expect(e.counter).toMatch(/^\d{12}$/);
      expect(e.hours).toBeGreaterThan(0);
      expect(e.label).not.toBe("");
    }
    const open = await std.openDays(month.from, month.to);
    for (const d of open) {
      expect(d.workingDay).toBe(true);
      expect(d.closed).toBe(false);
      expect(d.missingHours).toBeGreaterThan(0);
      expect(d.bookedHours + d.missingHours).toBeCloseTo(d.targetHours);
    }
  });

  it("standard: favorites and value helps return codes with texts", async () => {
    const favs = await std.favorites();
    expect(favs.length).toBeGreaterThan(0);
    expect(favs[0].id).not.toBe("");
    const att = await std.attendanceTypes();
    expect(att.some((a) => a.code === "0010")).toBe(true);
    expect(att.find((a) => a.code === ADMIN)?.text).toMatch(/admin/i);
    const ch = await std.chargeableOrders(undefined, { top: 5 });
    expect(ch.length).toBeGreaterThan(0);
    expect(ch[0]).toMatchObject({ code: expect.stringMatching(/^\d+$/), text: expect.any(String) });
    const items = await std.salesOrderItems(ch[0].code);
    expect(items.length).toBeGreaterThan(0);
    const nch = await std.nonChargeableOrders(undefined, { top: 5 });
    expect(nch.length).toBeGreaterThan(0);
  });

  it("standard: a chargeable order resolves by its own number, and a single-item order auto-fills RKDPOS", async () => {
    // Take a real order, then look it up by code alone (no text) — this is the path the UI's field uses.
    const [sample] = await std.chargeableOrders(undefined, { top: 1 });
    expect(sample?.code).toMatch(/^\d+$/);
    const byCode = await std.chargeableOrders(sample.code);
    expect(byCode.map((o) => o.code)).toContain(sample.code);

    // resolveSalesOrderItem mirrors the field: exactly one item → filled in; several → throws listing them; none → throws.
    const items = await std.salesOrderItems(sample.code);
    if (items.length === 1) {
      expect(await std.resolveSalesOrderItem({ salesOrder: sample.code })).toMatchObject({ salesOrder: sample.code, salesOrderItem: items[0].code });
    } else if (items.length > 1) {
      await expect(std.resolveSalesOrderItem({ salesOrder: sample.code })).rejects.toThrow(/pass salesOrderItem explicitly/);
    }
  });

  it("multiproject: months and the current month grid match the standard entries", async () => {
    const months = await mp.months();
    const cur = months.find((m) => m.year === month.year && m.month === month.month);
    expect(cur).toBeDefined();
    const sheet = await mp.month(month.year, month.month);
    expect(sheet.days.length).toBe(new Date(month.year, month.month, 0).getDate());
    const stdHours = (await std.entries(month.from, month.to)).reduce((a, e) => a + e.hours, 0);
    expect(sheet.totalHours).toBeCloseTo(stdHours, 1);
  });

  it("CLI std / mp read commands run against the real system", async () => {
    for (const args of [["std", "open-days", "--json"], ["std", "favorites", "--json"], ["std", "attendance-types", "--json"], ["mp", "months", "--json"], ["mp", "month", `${month.year}-${String(month.month).padStart(2, "0")}`, "--json"]]) {
      const r = await cli(args);
      expect(r.code, `${args.join(" ")}: ${r.err}`).toBe(0);
      expect(() => JSON.parse(r.out)).not.toThrow();
    }
  });
});

describe.skipIf(!writes)("real xflow · writes (create → update → delete, current month)", () => {
  const created: string[] = [];
  let day: string;

  beforeAll(async () => {
    const open = await std.openDays(month.from, month.to);
    const candidate = open.find((d) => d.missingHours >= 2 && d.date <= new Date().toISOString().slice(0, 10)) ?? open[0];
    if (!candidate) throw new Error("No open day with missing hours in the current month to test on");
    day = candidate.date;
  });

  afterAll(async () => {
    // Safety net: delete anything we created that is still there.
    if (created.length) {
      const existing = new Set((await std.entries(month.from, month.to)).map((e) => e.counter));
      const left = created.filter((c) => c && existing.has(c));
      if (left.length) await std.remove(left, month);
    }
  });

  it("standard: fill (unreleased) → visible in entries → update hours → remove", async () => {
    const [res] = await std.fill([day], { attendanceType: ADMIN }, 1, { release: false, shortText: "xflow-timesheet e2e" });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, date: day });
    expect(res.counter).toMatch(/^\d{12}$/);
    created.push(res.counter!);

    let mine = (await std.entries(day, day)).find((e) => e.counter === res.counter);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({ hours: 1, attendanceType: { code: ADMIN } });
    // Profiles with ReleaseDirectly auto-approve on save: status DONE ("Approved") even without the release flag.
    expect(["MSAVE", "DONE", "RELEASED", "Planned"]).toContain(mine!.status);
    expect(mine!.statusText).not.toBe("");

    const [upd] = await std.update([{ counter: res.counter!, date: day, item: { attendanceType: ADMIN }, hours: 2, shortText: "xflow-timesheet e2e", release: false }]);
    expect(upd, JSON.stringify(upd)).toMatchObject({ ok: true });
    const afterUpdate = await std.entries(day, day);
    mine = afterUpdate.find((e) => e.counter === (upd.counter ?? res.counter));
    expect(mine?.hours).toBe(2);
    if (upd.counter && upd.counter !== res.counter) created.push(upd.counter);

    const target = mine!.counter;
    const [rm] = await std.remove([target], { from: day, to: day });
    expect(rm, JSON.stringify(rm)).toMatchObject({ ok: true, counter: target });
    expect((await std.entries(day, day)).some((e) => e.counter === target)).toBe(false);
  });

  it("standard: set (replace) → jobcodes shows it → fill-open caps → remove all", async () => {
    // set makes the day contain exactly 1h ADMIN, replacing anything there
    const set = await std.set([day], { attendanceType: ADMIN }, 1, { shortText: "xflow-timesheet e2e set" });
    expect(set.created[0], JSON.stringify(set)).toMatchObject({ ok: true, date: day });
    created.push(set.created[0].counter!);
    const stats = await std.jobcodes(day, day, { codes: [ADMIN] });
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ days: 1, hours: 1, dates: [day] });
    // fill-open books the remaining hours of the day (capped at 1h)
    const open = await std.fillOpen(day, day, { attendanceType: ADMIN }, { maxHours: 1, shortText: "xflow-timesheet e2e fill-open" });
    expect(open, JSON.stringify(open)).toHaveLength(1);
    expect(open[0]).toMatchObject({ ok: true, hours: 1 });
    created.push(open[0].counter!);
    const summary = (await std.days(day, day))[0];
    expect(summary.bookedHours).toBe(2);
    const rm = await std.remove([set.created[0].counter!, open[0].counter!], { from: day, to: day });
    expect(rm.every((r) => r.ok), JSON.stringify(rm)).toBe(true);
  });

  it("standard: staffing plan is readable and applying it on an already-filled day is a no-op", async () => {
    const plan = await std.staffing(month.from, month.to);
    for (const p of plan) expect(p.status).toBe("Planned");
    // pick a day of the plan; book its hours as ADMIN so the plan is skipped there, then clean up
    const target = plan.find((p) => p.date === day) ?? plan[0];
    if (!target) return; // no staffing this month: nothing to verify
    const summary = (await std.days(target.date, target.date))[0];
    if (!summary || summary.closed) return;
    const [fill] = await std.fill([target.date], { attendanceType: ADMIN }, summary.missingHours || 1, { shortText: "xflow-timesheet e2e staffing" });
    expect(fill.ok, JSON.stringify(fill)).toBe(true);
    created.push(fill.counter!);
    const applied = await std.applyStaffing(target.date, target.date);
    expect(applied.created.filter((c) => c.ok)).toHaveLength(0);
    expect(applied.skipped.map((x) => x.date)).toContain(target.date);
    const [rm] = await std.remove([fill.counter!], { from: target.date, to: target.date });
    expect(rm.ok).toBe(true);
  });

  it("standard: favorite add → listed → remove", async () => {
    const name = `e2e ${Date.now()}`;
    const fav = await std.addFavorite(name, { attendanceType: ADMIN }, 1);
    expect(fav.id).not.toBe("");
    expect((await std.favorites()).some((f) => f.id === fav.id)).toBe(true);
    await std.deleteFavorite(fav.id);
    expect((await std.favorites()).some((f) => f.id === fav.id)).toBe(false);
  });

  it("multiproject: plan two slots on one day → stats show 50/50 → balance to 75/25 → clear", async () => {
    const admin = { attendanceType: ADMIN };
    const holidayHalf = { attendanceType: "0015" }; // Holiday (half day) — second project for the split
    const sheet = await mp.allocateMany(month.year, month.month, [
      { project: admin, days: [{ date: day, hours: 1, text: "xflow-timesheet e2e" }] },
      { project: holidayHalf, days: [{ date: day, hours: 1 }] },
    ]);
    const cols = sheet.projects.filter((p) => !p.order && !p.salesOrder && [ADMIN, "0015"].includes(p.attendanceType));
    expect(cols).toHaveLength(2);
    for (const c of cols) created.push(sheet.days.find((d) => d.date === day)!.cells[c.column].counter);
    const st = await mp.stats(month.year, month.month, { from: day, to: day });
    expect(st.projects.map((p) => p.share).sort()).toEqual([50, 50]);

    await mp.balance(month.year, month.month, { from: day, to: day }, [{ project: admin, share: 75 }, { project: holidayHalf, share: 25 }]);
    const after = await mp.stats(month.year, month.month, { from: day, to: day });
    expect(after.totalHours).toBe(after.targetHours);
    expect(after.projects.find((p) => p.project.attendanceType === ADMIN)?.share).toBe(75);
    const grid = await mp.month(month.year, month.month);
    for (const c of grid.projects) created.push(grid.days.find((d) => d.date === day)!.cells[c.column].counter);

    await mp.clear(month.year, month.month, admin, [day]);
    await mp.clear(month.year, month.month, holidayHalf, [day]);
    expect((await std.entries(day, day)).filter((e) => [ADMIN, "0015"].includes(e.attendanceType?.code ?? ""))).toHaveLength(0);
  });

  it("multiproject: allocate 1h on a project → visible in grid → clear", async () => {
    const project = { attendanceType: ADMIN };
    const sheet = await mp.allocate(month.year, month.month, project, [{ date: day, hours: 1, text: "xflow-timesheet e2e" }]);
    const col = sheet.projects.find((p) => p.attendanceType === ADMIN && !p.order && !p.salesOrder);
    expect(col).toBeDefined();
    const cell = sheet.days.find((d) => d.date === day)!.cells[col!.column];
    expect(cell.hours).toBe(1);
    expect(cell.counter).toMatch(/^\d{12}$/);
    created.push(cell.counter);

    const cleared = await mp.clear(month.year, month.month, project, [day]);
    const col2 = cleared.projects.find((p) => p.attendanceType === ADMIN && !p.order && !p.salesOrder);
    expect(col2 ? cleared.days.find((d) => d.date === day)!.cells[col2.column].hours : 0).toBe(0);
    expect((await std.entries(day, day)).some((e) => e.counter === cell.counter)).toBe(false);
  });
});
