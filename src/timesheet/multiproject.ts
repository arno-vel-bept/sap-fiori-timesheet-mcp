import type { SapClient } from "../sap/client.js";
import { monthRange, odataFilter, queryString, unwrapResults } from "../sap/odata.js";
import { LockService } from "./lock.js";
import { stripZeros, TimesheetError, validateItem, type EntryItem, type Favorite } from "./types.js";

export interface MonthSummary {
  year: number;
  month: number;
  status: string;
  closed: boolean;
  totalHours: number;
  missingHours: number;
  chargeableHours: number;
}

/** A column of the multiproject grid. Codes are kept as SAP returns them (with leading zeros). */
export interface Project {
  column: string; // PROJECT1 …
  order: string; // RAUFNR
  attendanceType: string; // AWART
  salesOrder: string; // RKDAUF
  salesOrderItem: string; // RKDPOS
  text: string; // ZZTEXT
  country: string;
  state: string;
  /** Human-readable label */
  label: string;
}

export interface Cell {
  hours: number;
  counter: string;
  text: string;
  longText: string;
}

export interface SheetDay {
  date: string;
  targetHours: number;
  workingDay: boolean;
  status: string;
  cells: Record<string, Cell>;
  totalHours: number;
}

export interface MonthSheet {
  year: number;
  month: number;
  status: string;
  closed: boolean;
  projects: Project[];
  days: SheetDay[];
  totalHours: number;
}

export interface Allocation {
  date: string; // ISO
  hours: number;
  text?: string;
}

/** One project with either explicit days or a date range (working days) at `hours` per day. */
export interface Slot {
  project: EntryItem;
  days?: Allocation[];
  range?: { from: string; to: string };
  hours?: number;
  text?: string;
}

export interface ProjectStat {
  project: Project;
  hours: number;
  days: number;
  /** Percentage of the booked hours in the range. */
  share: number;
}

export interface MonthStats {
  year: number;
  month: number;
  from: string;
  to: string;
  totalHours: number;
  targetHours: number;
  projects: ProjectStat[];
  perDay: { date: string; targetHours: number; totalHours: number; cells: Record<string, number> }[];
}

export interface ShareSlot {
  project: EntryItem;
  /** Percentage, all slots must add up to 100. */
  share: number;
}

/**
 * whole-days: consecutive whole days per project (X on the first days, then Y; one day split where a quota ends).
 * every-day: each working day is split according to the shares (quarter-hour rounding, totals kept exact).
 */
export type BalanceMode = "whole-days" | "every-day";
export const BALANCE_MODES: BalanceMode[] = ["whole-days", "every-day"];

/** Per-day plan shared by allocateMany / balance previews. `hours[i]` belongs to `slots[i]`. */
export interface DayPlan {
  date: string;
  targetHours: number;
  hours: number[];
}

export interface AllocationPlan {
  year: number;
  month: number;
  slots: { project: EntryItem; label: string; hours: number }[];
  days: DayPlan[];
  totalHours: number;
}

export interface BalancePlan extends AllocationPlan {
  mode: BalanceMode;
  range: { from: string; to: string };
  targetHours: number;
  slots: { project: EntryItem; label: string; hours: number; share: number }[];
}

interface ColumnData {
  COLNAME: string;
  COLINFO: { RAUFNR: string; AWART: string; RKDAUF: string; RKDPOS: string; ZZTEXT: string; ZZLAND: string; ZZBLAND: string } | "";
}
interface RawCell {
  HOURS: string;
  COUNTER: string;
  TEXT: string;
  LONGTEXT: string;
}
type RawRow = { DATE: string; TOTAL_HOURS?: string } & Record<string, RawCell | string | undefined>;

/** Client for the "Multiproject Timesheet" Fiori app (ZHCM_TIMESHEET_MAN_V2_SRV_01). */
export class MultiprojectTimesheet {
  static readonly SERVICE = "/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_V2_SRV_01/";
  private readonly lock: LockService;

  constructor(private readonly client: SapClient) {
    this.lock = new LockService(client);
  }

  private url(entity: string, filter?: string): string {
    return MultiprojectTimesheet.SERVICE + entity + queryString(filter ? { $filter: filter } : {});
  }

  private async list<T = Record<string, string>>(entity: string, filter?: string): Promise<T[]> {
    return unwrapResults<T>(await this.client.getJson(this.url(entity, filter)));
  }

  async months(): Promise<MonthSummary[]> {
    const rows = await this.list("GetMasterListSet");
    return rows.map((r) => ({
      year: Number(r.Gjahr),
      month: Number(r.Perio),
      status: r.Status,
      closed: r.Status === "PER_CLOSED",
      totalHours: Number(r.TotalHours) || 0,
      missingHours: Number(r.MissingHours) || 0,
      chargeableHours: Number(r.ChargeableHours) || 0,
    }));
  }

  async favorites(): Promise<Favorite[]> {
    const rows = await this.list<Record<string, unknown>>("Favorites");
    return rows.map((r) => {
      const df = (r.FavoriteDataFields ?? {}) as Record<string, string>;
      const item: EntryItem = {};
      if (df.AWART) item.attendanceType = df.AWART;
      if (df.RAUFNR) item.order = stripZeros(df.RAUFNR);
      if (df.RKDAUF) item.salesOrder = stripZeros(df.RKDAUF);
      if (df.RKDPOS && df.RKDPOS !== "000000") item.salesOrderItem = df.RKDPOS;
      const hours = Number(df.CATSHOURS);
      return { id: String(r.ID ?? "").trim(), name: String(r.Name ?? ""), type: String(r.ObjType ?? ""), ...(hours > 0 ? { hours } : {}), item, description: String(r.Field_Text ?? "") };
    });
  }

  async month(year: number, month: number): Promise<MonthSheet> {
    const range = monthRange(year, month);
    const perio = String(month).padStart(2, "0");
    const [calendar, [data]] = await Promise.all([
      this.list("WorkCalendars", odataFilter({ StartDate: range.start, EndDate: range.end })),
      this.list("GetTimeDataSet", odataFilter({ Gjahr: String(year), Perio: perio })),
    ]);
    if (!data) throw new TimesheetError(`No timesheet data for ${year}-${perio}`);
    const columns = (JSON.parse(data.ColumnData) as { DATA: ColumnData[] }).DATA;
    const rows = (JSON.parse(data.RowData) as { DATA: RawRow[] }).DATA;
    const byDate = new Map(calendar.map((c) => [c.Date, c]));
    const projects = columns.filter((c) => c.COLINFO && c.COLNAME.startsWith("PROJECT")).map(toProject);
    const days: SheetDay[] = rows.map((row) => {
      const cal = byDate.get(row.DATE.replace(/-/g, ""));
      const cells: Record<string, Cell> = {};
      for (const p of projects) {
        const raw = row[p.column] as RawCell | undefined;
        cells[p.column] = { hours: Number(raw?.HOURS) || 0, counter: raw?.COUNTER ?? "", text: raw?.TEXT ?? "", longText: raw?.LONGTEXT ?? "" };
      }
      return {
        date: row.DATE,
        targetHours: Number(cal?.TargetHours) || 0,
        workingDay: (Number(cal?.TargetHours) || 0) > 0,
        status: cal?.Status ?? "",
        cells,
        totalHours: Object.values(cells).reduce((a, c) => a + c.hours, 0),
      };
    });
    const status = calendar[0]?.Status ?? "";
    return { year, month, status, closed: status === "PER_CLOSED", projects, days, totalHours: days.reduce((a, d) => a + d.totalHours, 0) };
  }

  /**
   * Allocates hours to a project on the given days (creating the project column
   * when needed, updating cells that already exist). Takes the CATS lock around
   * the save, like the app. Returns the refreshed month.
   */
  async allocate(year: number, month: number, project: EntryItem, allocations: Allocation[]): Promise<MonthSheet> {
    validateItem(project);
    for (const a of allocations) {
      if (!(a.hours >= 0)) throw new TimesheetError(`Invalid hours for ${a.date}`);
      if (!a.date.startsWith(`${year}-${String(month).padStart(2, "0")}`)) throw new TimesheetError(`${a.date} is not in ${year}-${String(month).padStart(2, "0")}`);
    }
    return this.edit(year, month, (columns, rows) => {
      const col = ensureColumn(columns, rows, project);
      for (const a of allocations) {
        const row = rows.find((r) => r.DATE === a.date);
        if (!row) throw new TimesheetError(`${a.date} is not part of the month`);
        const cell = row[col.COLNAME] as RawCell;
        cell.HOURS = a.hours > 0 ? a.hours.toFixed(2) : "";
        if (a.text !== undefined) cell.TEXT = a.text;
      }
    });
  }

  /**
   * Several projects in one save: e.g. every working day of a range 2h on X and 6h on Y.
   * Slots with `range` expand to the working days (target hours > 0) of the range.
   */
  async allocateMany(year: number, month: number, slots: Slot[]): Promise<MonthSheet> {
    const resolved = await this.resolveSlots(year, month, slots);
    return this.edit(year, month, (columns, rows) => {
      for (const { project, allocations } of resolved) {
        const col = ensureColumn(columns, rows, project);
        for (const a of allocations) {
          const row = rows.find((r) => r.DATE === a.date);
          if (!row) throw new TimesheetError(`${a.date} is not part of ${year}-${String(month).padStart(2, "0")}`);
          const cell = row[col.COLNAME] as RawCell;
          cell.HOURS = a.hours > 0 ? a.hours.toFixed(2) : "";
          if (a.text !== undefined) cell.TEXT = a.text;
        }
      }
    });
  }

  private async resolveSlots(year: number, month: number, slots: Slot[]) {
    if (slots.length === 0) throw new TimesheetError("No slots given");
    for (const s of slots) validateItem(s.project);
    const current = await this.month(year, month);
    return slots.map((s) => ({ project: s.project, allocations: expandSlot(s, current) }));
  }

  /** Dry run of allocateMany: per-day hours per slot, without writing. */
  async previewAllocateMany(year: number, month: number, slots: Slot[]): Promise<AllocationPlan> {
    const resolved = await this.resolveSlots(year, month, slots);
    const dates = [...new Set(resolved.flatMap((r) => r.allocations.map((a) => a.date)))].sort();
    const sheet = await this.month(year, month);
    const days: DayPlan[] = dates.map((date) => ({
      date,
      targetHours: sheet.days.find((d) => d.date === date)?.targetHours ?? 0,
      hours: resolved.map((r) => round2(r.allocations.filter((a) => a.date === date).reduce((acc, a) => acc + a.hours, 0))),
    }));
    return {
      year,
      month,
      slots: resolved.map((r, i) => ({ project: r.project, label: projectLabel(r.project), hours: round2(days.reduce((a, d) => a + d.hours[i], 0)) })),
      days,
      totalHours: round2(days.reduce((a, d) => a + d.hours.reduce((x, y) => x + y, 0), 0)),
    };
  }

  /** Which projects a day / range / month contains, with hours, days and proportion. */
  async stats(year: number, month: number, range: { from?: string; to?: string } = {}): Promise<MonthStats> {
    const sheet = await this.month(year, month);
    const mr = monthRange(year, month);
    const from = range.from ?? mr.startIso;
    const to = range.to ?? mr.endIso;
    const days = sheet.days.filter((d) => d.date >= from && d.date <= to);
    const totalHours = round2(days.reduce((a, d) => a + d.totalHours, 0));
    const targetHours = round2(days.reduce((a, d) => a + d.targetHours, 0));
    const projects: ProjectStat[] = sheet.projects
      .map((p) => {
        const cells = days.map((d) => d.cells[p.column]);
        const hours = round2(cells.reduce((a, c) => a + c.hours, 0));
        return { project: p, hours, days: cells.filter((c) => c.hours > 0).length, share: totalHours ? round2((hours / totalHours) * 100) : 0 };
      })
      .filter((p) => p.hours > 0)
      .sort((a, b) => b.hours - a.hours);
    return {
      year,
      month,
      from,
      to,
      totalHours,
      targetHours,
      projects,
      perDay: days.map((d) => ({ date: d.date, targetHours: d.targetHours, totalHours: d.totalHours, cells: Object.fromEntries(Object.entries(d.cells).filter(([, c]) => c.hours > 0).map(([k, c]) => [k, c.hours])) })),
    };
  }

  /**
   * Dry run of balance: computes how the range's target hours would be split between the
   * projects for the requested shares, in the given mode. Nothing is written.
   */
  async previewBalance(year: number, month: number, range: { from: string; to: string }, slots: ShareSlot[], opts: { mode?: BalanceMode } = {}): Promise<BalancePlan> {
    const mode = opts.mode ?? "whole-days";
    if (!BALANCE_MODES.includes(mode)) throw new TimesheetError(`Unknown mode "${mode}": use ${BALANCE_MODES.join(" or ")}`);
    if (slots.length === 0) throw new TimesheetError("No slots given");
    for (const s of slots) validateItem(s.project);
    const total = slots.reduce((a, s) => a + s.share, 0);
    if (Math.abs(total - 100) > 0.01) throw new TimesheetError(`Shares must add up to 100 (got ${total})`);
    const current = await this.month(year, month);
    const days = current.days.filter((d) => d.date >= range.from && d.date <= range.to && d.targetHours > 0 && d.status !== "PER_CLOSED");
    if (days.length === 0) throw new TimesheetError(`No open working days between ${range.from} and ${range.to}`);
    const targetTotal = days.reduce((a, d) => a + d.targetHours, 0);
    const quotas = splitByShares(targetTotal, slots.map((s) => s.share));
    const plan: DayPlan[] = days.map((d) => ({ date: d.date, targetHours: d.targetHours, hours: slots.map(() => 0) }));
    if (mode === "every-day") {
      // split each day by the shares; fix rounding drift on the last days so slot totals equal the quotas
      const given = slots.map(() => 0);
      plan.forEach((p, idx) => {
        const isLast = idx === plan.length - 1;
        const parts = isLast ? quotas.map((q, i) => round2(q - given[i])) : splitByShares(p.targetHours, slots.map((s) => s.share));
        p.hours = parts;
        parts.forEach((h, i) => (given[i] = round2(given[i] + h)));
      });
    } else {
      let slotIdx = 0;
      let remainingQuota = quotas[0];
      for (const p of plan) {
        let dayLeft = p.targetHours;
        while (dayLeft > 0 && slotIdx < slots.length) {
          const take = round2(Math.min(dayLeft, remainingQuota));
          if (take > 0) p.hours[slotIdx] = round2(p.hours[slotIdx] + take);
          dayLeft = round2(dayLeft - take);
          remainingQuota = round2(remainingQuota - take);
          if (remainingQuota <= 0) {
            slotIdx++;
            remainingQuota = quotas[slotIdx] ?? 0;
          }
        }
      }
    }
    return {
      year,
      month,
      mode,
      range,
      targetHours: targetTotal,
      totalHours: round2(plan.reduce((a, d) => a + d.hours.reduce((x, y) => x + y, 0), 0)),
      slots: slots.map((s, i) => ({ project: s.project, label: projectLabel(s.project), share: s.share, hours: quotas[i] })),
      days: plan,
    };
  }

  /**
   * Rewrites the working days of a range so the given projects hold the requested
   * proportions of the range's target hours (e.g. 60 % X / 40 % Y). See BalanceMode for
   * how the hours are laid out. Other projects' hours on those days are cleared so every
   * day equals its target.
   */
  async balance(year: number, month: number, range: { from: string; to: string }, slots: ShareSlot[], opts: { mode?: BalanceMode } = {}): Promise<MonthSheet> {
    const plan = await this.previewBalance(year, month, range, slots, opts);
    const dates = new Set(plan.days.map((d) => d.date));
    return this.edit(year, month, (columns, rows) => {
      for (const r of rows) if (dates.has(r.DATE)) for (const c of columns) (r[c.COLNAME] as RawCell).HOURS = "";
      plan.slots.forEach((slot, i) => {
        const col = ensureColumn(columns, rows, slot.project);
        for (const d of plan.days) if (d.hours[i] > 0) (rows.find((r) => r.DATE === d.date)![col.COLNAME] as RawCell).HOURS = d.hours[i].toFixed(2);
      });
    });
  }

  /** Removes the hours of a project on the given days (all days of the month when `dates` is omitted). */
  async clear(year: number, month: number, project: EntryItem, dates?: string[]): Promise<MonthSheet> {
    return this.edit(year, month, (columns, rows) => {
      const col = columns.find((c) => sameProject(c, project));
      if (!col) throw new TimesheetError("No column for that project in this month");
      for (const r of rows) {
        if (dates && !dates.includes(r.DATE)) continue;
        const cell = r[col.COLNAME] as RawCell | undefined;
        if (cell) cell.HOURS = "";
      }
    });
  }

  private async edit(year: number, month: number, mutate: (columns: ColumnData[], rows: RawRow[]) => void): Promise<MonthSheet> {
    const current = await this.month(year, month);
    if (current.closed) throw new TimesheetError(`${year}-${String(month).padStart(2, "0")} is closed for time recording`);
    const perio = String(month).padStart(2, "0");
    const [data] = await this.list("GetTimeDataSet", odataFilter({ Gjahr: String(year), Perio: perio }));
    const columns = (JSON.parse(data.ColumnData) as { DATA: ColumnData[] }).DATA.filter((c) => c.COLINFO && c.COLNAME.startsWith("PROJECT"));
    const rows = (JSON.parse(data.RowData) as { DATA: RawRow[] }).DATA.map((r) => cleanRow(r, columns));
    mutate(columns, rows);
    for (const c of columns) if (c.COLINFO) c.COLINFO.ZZTEXT = ""; // the app blanks ZZTEXT before saving
    const payload = { ColumnData: JSON.stringify(columns), RowData: JSON.stringify(rows.map((r) => withTotals(r, columns))) };
    await this.lock.withLock(async () => {
      await this.client.postJson(this.url("UpdateTimeDataSet"), payload);
    });
    return this.month(year, month);
  }
}

function ensureColumn(columns: ColumnData[], rows: RawRow[], project: EntryItem): ColumnData {
  let col = columns.find((c) => sameProject(c, project));
  if (!col) {
    col = { COLNAME: `PROJECT${columns.length + 1}`, COLINFO: toColInfo(project) };
    columns.push(col);
    for (const r of rows) r[col.COLNAME] = { HOURS: "", COUNTER: "", TEXT: "", LONGTEXT: "" };
  }
  return col;
}

function expandSlot(s: Slot, sheet: MonthSheet): Allocation[] {
  const out: Allocation[] = [...(s.days ?? [])];
  if (s.range) {
    if (s.hours === undefined) throw new TimesheetError("A slot with a range needs hours per day");
    for (const d of sheet.days) {
      if (d.date >= s.range.from && d.date <= s.range.to && d.targetHours > 0) out.push({ date: d.date, hours: s.hours, text: s.text });
    }
  }
  if (out.length === 0) throw new TimesheetError("Slot has neither days nor a range with working days");
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Splits `total` hours by percentage shares into quarter hours; largest remainders absorb the rounding so the parts add up exactly. */
function splitByShares(total: number, shares: number[]): number[] {
  const raw = shares.map((sh) => (total * sh) / 100);
  const parts = raw.map((q) => Math.floor(q * 4) / 4);
  let leftover = round2(total - parts.reduce((a, q) => a + q, 0));
  const order = raw.map((q, i) => ({ i, frac: q - parts[i] })).sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (leftover > 0.001 && order.length) {
    const { i } = order[k % order.length];
    parts[i] = round2(parts[i] + 0.25);
    leftover = round2(leftover - 0.25);
    k++;
  }
  return parts;
}

/** Human label for a project given as an EntryItem. */
export function projectLabel(p: EntryItem): string {
  const bits: string[] = [];
  if (p.salesOrder) bits.push(`sales order ${p.salesOrder}${p.salesOrderItem ? `/${p.salesOrderItem}` : ""}`);
  if (p.order) bits.push(`order ${p.order}`);
  if (p.attendanceType) bits.push(`type ${p.attendanceType}`);
  return bits.join(" · ");
}

function toProject(c: ColumnData): Project {
  const i = c.COLINFO as Exclude<ColumnData["COLINFO"], "">;
  const bits = [
    i.RKDAUF ? `${i.ZZTEXT || stripZeros(i.RKDAUF)} (${stripZeros(i.RKDAUF)}${i.RKDPOS && i.RKDPOS !== "000000" ? `/${i.RKDPOS}` : ""})` : "",
    i.RAUFNR ? `${i.ZZTEXT || stripZeros(i.RAUFNR)} (${stripZeros(i.RAUFNR)})` : "",
    i.AWART ? (!i.RAUFNR && !i.RKDAUF && i.ZZTEXT ? `${i.ZZTEXT} (${i.AWART})` : i.AWART) : "",
  ].filter(Boolean);
  return { column: c.COLNAME, order: i.RAUFNR ?? "", attendanceType: i.AWART ?? "", salesOrder: i.RKDAUF ?? "", salesOrderItem: i.RKDPOS ?? "", text: i.ZZTEXT ?? "", country: i.ZZLAND ?? "", state: i.ZZBLAND ?? "", label: bits.join(" · ") };
}

function toColInfo(p: EntryItem): Exclude<ColumnData["COLINFO"], ""> {
  return {
    RAUFNR: p.order ?? "",
    AWART: p.attendanceType ?? "",
    RKDAUF: p.salesOrder ?? "",
    RKDPOS: p.salesOrderItem ? p.salesOrderItem.padStart(6, "0") : "000000",
    ZZTEXT: "",
    ZZLAND: p.country ?? "",
    ZZBLAND: p.state ?? "",
  };
}

function sameProject(c: ColumnData, p: EntryItem): boolean {
  if (!c.COLINFO) return false;
  const i = c.COLINFO;
  const eq = (a: string | undefined, b: string | undefined) => stripZeros(a ?? "") === stripZeros(b ?? "");
  const eqItem = (a: string | undefined, b: string | undefined) => (a ?? "000000").padStart(6, "0") === (b ?? "000000").padStart(6, "0");
  return eq(i.RAUFNR, p.order) && (i.AWART ?? "") === (p.attendanceType ?? "") && eq(i.RKDAUF, p.salesOrder) && eqItem(i.RKDPOS, p.salesOrderItem);
}

/** Keeps only the keys the backend reads: DATE, PROJECTn cells, TOTAL_HOURS. */
function cleanRow(r: RawRow, columns: ColumnData[]): RawRow {
  const out: RawRow = { DATE: r.DATE };
  for (const c of columns) {
    const cell = r[c.COLNAME] as RawCell | undefined;
    out[c.COLNAME] = { HOURS: cell?.HOURS ?? "", COUNTER: cell?.COUNTER ?? "", TEXT: cell?.TEXT ?? "", LONGTEXT: cell?.LONGTEXT ?? "" };
  }
  return out;
}

function withTotals(r: RawRow, columns: ColumnData[]): RawRow {
  const total = columns.reduce((a, c) => a + (Number((r[c.COLNAME] as RawCell).HOURS) || 0), 0);
  return { ...r, TOTAL_HOURS: total.toFixed(2) };
}
