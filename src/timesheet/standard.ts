import { SapError, type SapClient } from "../sap/client.js";
import { buildBatch, isoDate, odataFilter, odataQuote, parseBatchResponse, queryString, sapDate, unwrapResults } from "../sap/odata.js";
import {
  itemLabel,
  stripZeros,
  TimesheetError,
  validateItem,
  type CalendarDay,
  type CodeText,
  type EntryItem,
  type Favorite,
  type OpenDay,
  type SubmitResult,
  type TimeEntry,
  type ValueHelpItem,
  type WorklistItem,
  type DaySummary,
  type JobcodeStat,
  type SetResult,
  type StaffingApplyResult,
  type StaffingPlan,
  type SetPlan,
  type FillOpenResult,
} from "./types.js";

export interface InitialInfo {
  pernr: string;
  employeeName: string;
  profileId: string;
  releaseDirectly: boolean;
  releaseFuture: boolean;
  favoriteAvailable: boolean;
  clockEntry: boolean;
  country: string;
  companyCode: string;
}

export type ValueHelpField = "AWART" | "RKDAUF" | "RAUFNR" | "RKDPOS" | "ZZLAND" | "ZZBLAND";

export interface ValueHelpOptions {
  /** substring search on the text */
  query?: string;
  /** e.g. `RKDAUF = 3136787` to list items of a sales order */
  related?: string;
  from?: string;
  to?: string;
  top?: number;
  skip?: number;
}

export interface FillOptions {
  /**
   * Send the release flag (default true, like the app's "Submit"). Note: profiles with
   * ReleaseDirectly (e.g. MA-FACHL) auto-approve on save, so `false` has no visible effect there.
   */
  release?: boolean;
  shortText?: string;
  notes?: string;
}

export interface EntryUpdate {
  counter: string;
  date: string;
  item: EntryItem;
  hours: number;
  shortText?: string;
  notes?: string;
  release?: boolean;
}

type Row = { FieldName: string; FieldValue: string; FieldValueText: string; FieldText: string; Level: number | string; RecordNumber: string };

/** Field name (SAP) -> EntryItem key */
const FIELD_TO_ITEM: Record<string, keyof EntryItem> = {
  AWART: "attendanceType",
  RAUFNR: "order",
  RKDAUF: "salesOrder",
  RKDPOS: "salesOrderItem",
  LTXA1: "shortText",
  ZZTEXT: "text",
  ZZLAND: "country",
  ZZBLAND: "state",
};
const ITEM_TO_FIELD = Object.fromEntries(Object.entries(FIELD_TO_ITEM).map(([k, v]) => [v, k])) as Record<keyof EntryItem, string>;

/** Client for the "Standard Timesheet" Fiori app (ZHCM_TIMESHEET_MAN_SRV). */
export class StandardTimesheet {
  static readonly SERVICE = "/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/";
  private pernrCache?: string;

  constructor(private readonly client: SapClient) {}

  private url(entity: string, filter?: string, params: Record<string, string | number> = {}): string {
    return StandardTimesheet.SERVICE + entity + queryString({ ...(filter ? { $filter: filter } : {}), ...params });
  }

  private async list<T = Record<string, string>>(entity: string, filter?: string, params?: Record<string, string | number>): Promise<T[]> {
    return unwrapResults<T>(await this.client.getJson(this.url(entity, filter, params)));
  }

  async pernr(): Promise<string> {
    if (!this.pernrCache) {
      const rows = await this.list("ConcurrentEmploymentSet");
      if (!rows[0]?.Pernr) throw new TimesheetError("Could not determine the personnel number (ConcurrentEmploymentSet is empty).");
      this.pernrCache = rows[0].Pernr;
    }
    return this.pernrCache;
  }

  async info(date: string = today()): Promise<InitialInfo> {
    const pernr = await this.pernr();
    const d = sapDate(date);
    const [r] = await this.list("InitialInfos", odataFilter({ Pernr: pernr, StartDate: d, EndDate: d }));
    if (!r) throw new TimesheetError("InitialInfos returned nothing");
    return {
      pernr,
      employeeName: r.EmployeeName ?? "",
      profileId: r.ProfileID ?? "",
      releaseDirectly: r.ReleaseDirectly === "TRUE",
      releaseFuture: r.ReleaseFuture === "TRUE",
      favoriteAvailable: String(r.FavoriteAvailable) === "true",
      clockEntry: r.ClockEntry === "TRUE",
      country: r.Country ?? "",
      companyCode: r.CompanyCode ?? "",
    };
  }

  async calendar(from: string, to: string): Promise<CalendarDay[]> {
    const pernr = await this.pernr();
    const rows = await this.list("WorkCalendars", odataFilter({ Pernr: pernr, StartDate: sapDate(from), EndDate: sapDate(to) }));
    return rows.map((r) => ({
      date: isoDate(r.Date),
      status: r.Status,
      targetHours: Number(r.TargetHours) || 0,
      workingDay: r.WorkingDay === "TRUE",
      closed: r.Status === "PER_CLOSED",
    }));
  }

  async entries(from: string, to: string): Promise<TimeEntry[]> {
    const pernr = await this.pernr();
    const rows = await this.list<Row>("TimeDataList", odataFilter({ Pernr: pernr, StartDate: sapDate(from), EndDate: sapDate(to) }));
    return parseTimeDataList(rows);
  }

  /**
   * Every working day of the range (open or closed) with booked / missing hours, the
   * entries on it and a `filled` flag (booked >= target).
   */
  async days(from: string, to: string): Promise<DaySummary[]> {
    const [days, entries] = await Promise.all([this.calendar(from, to), this.entries(from, to)]);
    const byDate = new Map<string, TimeEntry[]>();
    for (const e of entries) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
    return days
      .filter((d) => d.workingDay && d.targetHours > 0)
      .map((d) => {
        const es = byDate.get(d.date) ?? [];
        const booked = round2(es.reduce((a, e) => a + e.hours, 0));
        const missing = round2(Math.max(0, d.targetHours - booked));
        return { ...d, bookedHours: booked, missingHours: missing, entries: es, filled: missing === 0 };
      });
  }

  /** Working days of open periods where booked hours < target hours, with the entries already there. */
  async openDays(from: string, to: string): Promise<OpenDay[]> {
    return (await this.days(from, to)).filter((d) => !d.closed && d.missingHours > 0);
  }

  /**
   * Which jobcodes (orders / sales orders / attendance types) the range contains:
   * number of days, hours, dates and share of the booked hours. `codes` filters on
   * any code of the item (order, sales order, sales order item, attendance type).
   */
  async jobcodes(from: string, to: string, opts: { codes?: string[] } = {}): Promise<JobcodeStat[]> {
    const entries = await this.entries(from, to);
    const total = entries.reduce((a, e) => a + e.hours, 0);
    const groups = new Map<string, JobcodeStat>();
    for (const e of entries) {
      const key = jobcodeKey(e.item);
      const g = groups.get(key) ?? { key, label: itemLabel(e), item: pickJobcode(e.item), days: 0, hours: 0, share: 0, dates: [] };
      if (!g.dates.includes(e.date)) {
        g.dates.push(e.date);
        g.days++;
      }
      g.hours = round2(g.hours + e.hours);
      groups.set(key, g);
    }
    let stats = [...groups.values()].map((g) => ({ ...g, share: total ? round2((g.hours / total) * 100) : 0 }));
    if (opts.codes?.length) {
      const wanted = new Set(opts.codes.map((c) => stripZeros(c)));
      stats = stats.filter((g) => [g.item.order, g.item.salesOrder, g.item.salesOrderItem, g.item.attendanceType].some((c) => c && wanted.has(stripZeros(c))));
    }
    return stats.sort((a, b) => b.hours - a.hours);
  }

  /** Planned entries from the MDS staffing plan (what the app's "Retrieve staffing" button loads). */
  async staffing(from: string, to: string): Promise<TimeEntry[]> {
    const pernr = await this.pernr();
    const rows = await this.list<Row>("ZPlanDataList", odataFilter({ Pernr: pernr, StartDate: sapDate(from), EndDate: sapDate(to) }));
    return parseTimeDataList(rows).map((e) => ({ ...e, status: e.status || "Planned", statusText: e.statusText || "Planned", released: false }));
  }

  /**
   * Books the staffing plan: for each planned entry whose day is open and still misses at
   * least the planned hours, creates the entry (like loading the plan and pressing Submit).
   * `dates` restricts to specific days.
   */
  async applyStaffing(from: string, to: string, opts: { dates?: string[]; release?: boolean } = {}): Promise<StaffingApplyResult> {
    const plan = await this.planStaffing(from, to, opts);
    const ops: EntryOperation[] = plan.toBook.map((b) => ({ op: "C", date: b.date, counter: "", item: b.item, hours: b.hours, shortText: b.shortText, release: opts.release ?? true }));
    return { created: await this.submit(ops), skipped: plan.skipped };
  }

  /** Dry run of applyStaffing: which planned entries would be booked and which skipped (and why). */
  async planStaffing(from: string, to: string, opts: { dates?: string[] } = {}): Promise<StaffingPlan> {
    const [plan, days] = await Promise.all([this.staffing(from, to), this.days(from, to)]);
    const byDate = new Map(days.map((d) => [d.date, d]));
    const skipped: StaffingPlan["skipped"] = [];
    const toBook: StaffingPlan["toBook"] = [];
    const remaining = new Map<string, number>();
    for (const p of plan) {
      if (opts.dates && !opts.dates.includes(p.date)) continue;
      const day = byDate.get(p.date);
      const left = remaining.get(p.date) ?? day?.missingHours ?? 0;
      if (!day) skipped.push({ date: p.date, reason: "not a working day in the range" });
      else if (day.closed) skipped.push({ date: p.date, reason: "period closed" });
      else if (left < p.hours) skipped.push({ date: p.date, reason: left === 0 ? "day already filled" : `only ${left}h missing, ${p.hours}h planned` });
      else {
        remaining.set(p.date, round2(left - p.hours));
        toBook.push({ date: p.date, hours: p.hours, item: pickJobcode(p.item), label: p.label, ...(p.shortText ? { shortText: p.shortText } : {}) });
      }
    }
    return { toBook, skipped };
  }

  /** Books `item` on every open day of the range, with the missing hours of each day (capped by maxHours). */
  async fillOpen(from: string, to: string, item: EntryItem, opts: FillOptions & { maxHours?: number } = {}): Promise<FillOpenResult[]> {
    item = await this.resolveSalesOrderItem(item, { from, to });
    const plan = await this.planFillOpen(from, to, item, opts);
    const ops: EntryOperation[] = plan.map((d) => ({ op: "C", date: d.date, counter: "", item, hours: d.hours, shortText: opts.shortText, notes: opts.notes, release: opts.release ?? true }));
    const results = await this.submit(ops);
    return results.map((r, i) => ({ ...r, hours: ops[i].hours }));
  }

  /** Dry run of fillOpen: the days and hours that would be booked. */
  async planFillOpen(from: string, to: string, item: EntryItem, opts: { maxHours?: number } = {}): Promise<{ date: string; hours: number }[]> {
    validateItem(await this.resolveSalesOrderItem(item, { from, to }));
    const open = await this.openDays(from, to);
    return open.map((d) => ({ date: d.date, hours: opts.maxHours ? Math.min(opts.maxHours, d.missingHours) : d.missingHours }));
  }

  /** Dry run of set: the entries that would be removed and the days that would be created. */
  async planSet(dates: string[], item: EntryItem, hours: number): Promise<SetPlan> {
    const sorted = [...dates].sort();
    validateItem(await this.resolveSalesOrderItem(item, { from: sorted[0], to: sorted[sorted.length - 1] }));
    if (!(hours > 0)) throw new TimesheetError("hours must be > 0");
    const existing = (await this.entries(sorted[0], sorted[sorted.length - 1])).filter((e) => dates.includes(e.date));
    const closed = existing.filter((e) => e.status === "PER_CLOSED");
    if (closed.length) throw new TimesheetError(`Cannot change closed days: ${[...new Set(closed.map((e) => e.date))].join(", ")}`);
    return { toRemove: existing, toCreate: dates.map((date) => ({ date, hours })) };
  }

  /**
   * Makes the given days contain exactly `item` for `hours`: existing entries on those
   * days are deleted and the item is created, all in one $batch.
   */
  async set(dates: string[], item: EntryItem, hours: number, opts: FillOptions = {}): Promise<SetResult> {
    const sorted = [...dates].sort();
    item = await this.resolveSalesOrderItem(item, { from: sorted[0], to: sorted[sorted.length - 1] });
    const plan = await this.planSet(dates, item, hours);
    const deletes: EntryOperation[] = plan.toRemove.map((e) => ({ op: "D", date: e.date, counter: e.counter, item: e.item, hours: e.hours, release: false }));
    const creates: EntryOperation[] = plan.toCreate.map(({ date, hours: h }) => ({ op: "C", date, counter: "", item, hours: h, shortText: opts.shortText, notes: opts.notes, release: opts.release ?? true }));
    const results = await this.submit([...deletes, ...creates]);
    return {
      removed: results.slice(0, deletes.length).map((r, i) => ({ ok: r.ok, counter: deletes[i].counter, date: deletes[i].date, ...(r.error ? { error: r.error } : {}) })),
      created: results.slice(deletes.length),
    };
  }

  async favorites(): Promise<Favorite[]> {
    const pernr = await this.pernr();
    const rows = await this.list<Record<string, unknown>>("Favorites", odataFilter({ Pernr: pernr }));
    return rows.map(parseFavorite);
  }

  async addFavorite(name: string, item: EntryItem, hours?: number): Promise<Favorite> {
    item = await this.resolveSalesOrderItem(item);
    validateItem(item);
    const pernr = await this.pernr();
    const body = {
      Name: name,
      Pernr: pernr,
      FavoriteDataFields: { ...itemToFields(item), ...(hours !== undefined ? { CATSHOURS: hours.toFixed(2) } : {}) },
    };
    const res = await this.client.postJson<{ d: Record<string, unknown> }>(this.url("Favorites"), body);
    return parseFavorite(res.d);
  }

  async deleteFavorite(id: string): Promise<void> {
    const pernr = await this.pernr();
    await this.client.delete(this.url(`Favorites(ID=${odataQuote(id.trim())},Pernr=${odataQuote(pernr)})`));
  }

  /**
   * Looks up value-help entries for `field`. A `query` that reads as description text is
   * sent to the server as `substringof(query, FieldValue)` (case-sensitive, as the real
   * search box). A `query` that reads as a **code** (digits, no spaces — an order / item /
   * type number) is instead resolved by code: first with an exact `FieldId` filter, and,
   * if the server rejects that or returns nothing (e.g. it stores the key zero-padded),
   * by paging the unfiltered list and matching the code here. That mirrors the Fiori field,
   * which resolves a pasted/typed number regardless of how the list is ordered or paged.
   * Without an explicit `top`, the list is auto-paged so the result is the whole set,
   * not just the first server page.
   */
  async valueHelp(field: ValueHelpField, opts: ValueHelpOptions = {}): Promise<ValueHelpItem[]> {
    const pernr = await this.pernr();
    const range = defaultRange(opts.from, opts.to);
    const base = { Pernr: pernr, FieldName: field, StartDate: range.start, EndDate: range.end };
    const relatedClause = opts.related ? [`FieldRelated eq ${odataQuote(opts.related)}`] : [];
    const query = opts.query?.trim();
    const map = (rows: Record<string, string>[]) => rows.map((r) => valueHelpItem(field, r));

    if (!query || !isCodeQuery(query)) {
      const textClause = query ? [`substringof(${odataQuote(query)}, FieldValue)`] : [];
      return map(await this.fetchValueHelp(odataFilter(base, [...relatedClause, ...textClause]), opts));
    }

    // Code-shaped query: try an exact FieldId lookup on the server (OR'd with the text match).
    const idClause = codeCandidates(field, query)
      .map((c) => `FieldId eq ${odataQuote(c)}`)
      .join(" or ");
    const codeFilter = odataFilter(base, [...relatedClause, `(substringof(${odataQuote(query)}, FieldValue) or ${idClause})`]);
    try {
      const rows = await this.fetchValueHelp(codeFilter, opts);
      if (rows.length) return map(rows);
    } catch (e) {
      if (!(e instanceof SapError)) throw e; // server rejects an unfilterable FieldId — fall back
    }
    // Fallback: page the unfiltered list and match the code / text ourselves (pagination-proof).
    const all = await this.fetchValueHelp(odataFilter(base, relatedClause), { ...opts, top: undefined });
    const want = stripZeros(query).toUpperCase();
    const raw = query.toUpperCase();
    const hits = all.filter((r) => {
      const id = String(r.FieldId ?? "");
      return stripZeros(id).toUpperCase() === want || id.toUpperCase().includes(raw) || String(r.FieldValue ?? "").includes(query);
    });
    return map(opts.top !== undefined ? hits.slice(0, opts.top) : hits);
  }

  /** One ValueHelpList page (explicit `top`), or every page concatenated (no `top`). */
  private async fetchValueHelp(filter: string, opts: { top?: number; skip?: number }): Promise<Record<string, string>[]> {
    if (opts.top !== undefined) {
      const params: Record<string, string | number> = { $top: opts.top };
      if (opts.skip !== undefined) params.$skip = opts.skip;
      return this.list<Record<string, string>>("ValueHelpList", filter, params);
    }
    const out: Record<string, string>[] = [];
    const seen = new Set<string>();
    let skip = opts.skip ?? 0;
    for (let page = 0; page < VALUE_HELP_MAX_PAGES; page++) {
      const rows = await this.list<Record<string, string>>("ValueHelpList", filter, { $top: VALUE_HELP_PAGE, $skip: skip });
      if (!rows.length) break; // past the end
      const key = (r: Record<string, string>) => `${r.FieldId ?? ""}|${r.FieldValue ?? ""}`;
      const fresh = rows.filter((r) => !seen.has(key(r)));
      for (const r of fresh) seen.add(key(r));
      out.push(...fresh);
      if (fresh.length === 0) break; // the server ignored $skip and returned the same page
      // Advance by what actually came back — the Gateway may cap a page below VALUE_HELP_PAGE,
      // so a short page is not necessarily the last one.
      skip += rows.length;
    }
    return out;
  }

  /**
   * Fills in a missing sales-order item (RKDPOS) the way the Fiori field does: when a
   * `salesOrder` is given without a `salesOrderItem` and the order has exactly one
   * compatible item, that item is used. Several items → a TimesheetError listing them so
   * the caller can choose; none → a TimesheetError (the order cannot be booked without one).
   * `range` scopes the item lookup to the days being booked (item validity can be dated).
   */
  async resolveSalesOrderItem(item: EntryItem, range: { from?: string; to?: string } = {}): Promise<EntryItem> {
    if (!item.salesOrder || item.salesOrderItem) return item;
    const items = await this.salesOrderItems(item.salesOrder, range);
    if (items.length === 1) return { ...item, salesOrderItem: items[0].code };
    if (items.length === 0) {
      throw new TimesheetError(`Sales order ${stripZeros(item.salesOrder)} has no bookable items (RKDPOS); check the order number.`);
    }
    throw new TimesheetError(
      `Sales order ${stripZeros(item.salesOrder)} has ${items.length} items — pass salesOrderItem explicitly: ${items.map((i) => `${i.code} (${i.text})`).join(", ")}.`,
    );
  }

  /** Attendance / absence types (AWART). */
  attendanceTypes(query?: string, opts: ValueHelpOptions = {}) {
    return this.valueHelp("AWART", { ...opts, query });
  }
  /** Chargeable orders = receiving sales orders (RKDAUF). */
  chargeableOrders(query?: string, opts: ValueHelpOptions = {}) {
    return this.valueHelp("RKDAUF", { ...opts, query });
  }
  /** Non-chargeable orders = receiver (internal) orders (RAUFNR). */
  nonChargeableOrders(query?: string, opts: ValueHelpOptions = {}) {
    return this.valueHelp("RAUFNR", { ...opts, query });
  }
  /** Items (RKDPOS) of a chargeable sales order. */
  salesOrderItems(salesOrder: string, opts: ValueHelpOptions = {}) {
    return this.valueHelp("RKDPOS", { ...opts, related: `RKDAUF = ${stripZeros(salesOrder)}` });
  }

  async worklist(from: string, to: string): Promise<WorklistItem[]> {
    const pernr = await this.pernr();
    const rows = await this.list<Record<string, string | number>>("WorkListCollection", odataFilter({ Pernr: pernr, StartDate: sapDate(from), EndDate: sapDate(to) }));
    const byRecord = new Map<number, WorklistItem>();
    for (const r of rows) {
      const rec = Number(r.RecordNumber);
      const wl = byRecord.get(rec) ?? { recordNumber: rec, label: "", item: {} };
      const key = FIELD_TO_ITEM[String(r.FieldName)];
      if (key) wl.item[key] = stripZerosForField(String(r.FieldName), String(r.FieldValue));
      if (Number(r.Level) === 0) wl.label = String(r.FieldValueText || r.FieldValue);
      else if (r.FieldValueText) wl.label += ` / ${r.FieldValueText}`;
      byRecord.set(rec, wl);
    }
    return [...byRecord.values()];
  }

  /** Books `hours` on every given day with the same item. One $batch, one changeset per day. */
  async fill(dates: string[], item: EntryItem, hours: number, opts: FillOptions = {}): Promise<SubmitResult[]> {
    const sorted = [...dates].sort();
    item = await this.resolveSalesOrderItem(item, { from: sorted[0], to: sorted[sorted.length - 1] });
    validateItem(item);
    if (!(hours > 0)) throw new TimesheetError("hours must be > 0");
    const ops = dates.map((date) => ({ op: "C" as const, date, counter: "", item, hours, shortText: opts.shortText, notes: opts.notes, release: opts.release ?? true }));
    return this.submit(ops);
  }

  async fillFromFavorite(dates: string[], fav: Favorite, hours?: number, opts: FillOptions = {}): Promise<SubmitResult[]> {
    const h = hours ?? fav.hours;
    if (!h) throw new TimesheetError(`Favorite "${fav.name}" has no default hours; pass hours explicitly.`);
    return this.fill(dates, fav.item, h, opts);
  }

  async update(updates: EntryUpdate[]): Promise<SubmitResult[]> {
    const resolved = await Promise.all(updates.map(async (u) => ({ ...u, item: await this.resolveSalesOrderItem(u.item, { from: u.date, to: u.date }) })));
    for (const u of resolved) validateItem(u.item);
    return this.submit(resolved.map((u) => ({ op: "U" as const, date: u.date, counter: u.counter, item: u.item, hours: u.hours, shortText: u.shortText, notes: u.notes, release: u.release ?? true })));
  }

  /** Deletes entries by counter. The entries must lie within [from, to] (their dates are looked up there). */
  async remove(counters: string[], range: { from: string; to: string }): Promise<SubmitResult[]> {
    const existing = await this.entries(range.from, range.to);
    const byCounter = new Map(existing.map((e) => [e.counter, e]));
    const known = counters.filter((c) => byCounter.has(c));
    const results = new Map<string, SubmitResult>();
    for (const c of counters) if (!byCounter.has(c)) results.set(c, { ok: false, counter: c, error: `Entry ${c} not found between ${range.from} and ${range.to}` });
    if (known.length) {
      const res = await this.submit(known.map((c) => ({ op: "D" as const, date: byCounter.get(c)!.date, counter: c, item: byCounter.get(c)!.item, hours: byCounter.get(c)!.hours, release: false })));
      res.forEach((r, i) => results.set(known[i], { ...r, counter: known[i] }));
    }
    return counters.map((c) => results.get(c)!);
  }

  /** Low-level: posts C/U/D operations as the app does (POST TimeEntries inside a $batch). */
  async submit(ops: EntryOperation[]): Promise<SubmitResult[]> {
    if (ops.length === 0) return [];
    const bodies = ops.map((o) => toPostBody(o, ops.length));
    const { body, contentType } = buildBatch(bodies.map((b) => ({ method: "POST" as const, path: "TimeEntries", body: b })));
    const res = await this.client.mutateRaw("POST", `${StandardTimesheet.SERVICE}$batch`, body, { "content-type": contentType, accept: "multipart/mixed" });
    const parts = parseBatchResponse(await res.text(), res.headers.get("content-type") ?? "");
    return ops.map((o, i) => {
      const p = parts[i];
      if (!p) return { ok: false, date: o.date, counter: o.counter || undefined, error: "No response for this entry in the batch" };
      if (p.status >= 400) return { ok: false, date: o.date, counter: o.counter || undefined, error: p.errorMessage ?? `HTTP ${p.status}` };
      const d = (p.json as { d?: { Counter?: string; Status?: string } })?.d ?? {};
      return { ok: true, date: o.date, counter: (d.Counter ?? o.counter) || undefined, ...(d.Status ? { status: d.Status } : {}) };
    });
  }
}

export interface EntryOperation {
  op: "C" | "U" | "D";
  date: string;
  counter: string;
  item: EntryItem;
  hours: number;
  shortText?: string;
  notes?: string;
  release: boolean;
}

function toPostBody(o: EntryOperation, lineCount: number) {
  const fields: Record<string, string> = {
    WORKDATE: `${isoDate(sapDate(o.date))}T00:00:00`,
    CATSAMOUNT: String(o.hours),
    BEGUZ: "",
    ENDUZ: "",
    ...itemToFields(o.item),
  };
  if (o.shortText) fields.LTXA1 = o.shortText;
  if (o.notes) {
    fields.LONGTEXT_DATA = o.notes;
    fields.LONGTEXT = "X";
  }
  const body: Record<string, unknown> = { Counter: o.counter, TimeEntryOperation: o.op, Line_Count: String(lineCount), TimeEntryDataFields: fields };
  if (o.op !== "D" && o.release) body.TimeEntryRelease = "X";
  return body;
}

function itemToFields(item: EntryItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, field] of Object.entries(ITEM_TO_FIELD) as [keyof EntryItem, string][]) {
    const v = item[key];
    if (v !== undefined && v !== "") out[field] = String(v);
  }
  return out;
}

/** Numeric SAP keys keep their leading zeros for RKDPOS (item numbers are positional) but not for orders. */
function stripZerosForField(field: string, value: string): string {
  if (field === "RKDPOS" || field === "AWART") return value.trim();
  return stripZeros(value);
}

const VALUE_HELP_PAGE = 500;
const VALUE_HELP_MAX_PAGES = 40; // safety stop; the Gateway may cap pages well below VALUE_HELP_PAGE

/** Width SAP stores a numeric value-help key at, used to build exact `FieldId` lookups. */
const FIELD_PAD: Partial<Record<ValueHelpField, number>> = { RKDAUF: 10, RAUFNR: 12, RKDPOS: 6 };

/** True when a value-help query reads as a code (has a digit, no whitespace) rather than description text. */
function isCodeQuery(q: string): boolean {
  return /\d/.test(q) && !/\s/.test(q) && /^[A-Za-z0-9._/-]+$/.test(q);
}

/** The forms of `code` worth trying in a `FieldId eq …` filter: as given, plus zero-padded to the field width. */
function codeCandidates(field: ValueHelpField, code: string): string[] {
  const t = code.trim();
  const out = new Set<string>([t]);
  const width = FIELD_PAD[field];
  if (width && /^\d+$/.test(t)) out.add(t.padStart(width, "0"));
  return [...out];
}

function valueHelpItem(field: ValueHelpField, r: Record<string, string>): ValueHelpItem {
  return {
    code: stripZerosForField(field, r.FieldId),
    text: r.FieldValue,
    ...(r.Client ? { client: r.Client } : {}),
    ...(r.PartnerName ? { partner: r.PartnerName } : {}),
    ...(r.ManagerName ? { manager: r.ManagerName } : {}),
    ...(r.Description && r.Description !== r.FieldValue ? { description: r.Description } : {}),
    ...(r.CostCenterResp ? { costCenter: r.CostCenterResp } : {}),
  };
}

/** Groups the flat TimeDataList rows into entries; a new record starts at every WORKDATE row. */
export function parseTimeDataList(rows: Row[]): TimeEntry[] {
  const entries: TimeEntry[] = [];
  let cur: Partial<TimeEntry> & { item: EntryItem } = { item: {} };
  const flush = () => {
    if (cur.date) {
      const e = cur as TimeEntry;
      e.released = e.status !== "MSAVE" && e.status !== "Planned" && e.status !== "";
      e.label = itemLabel(e);
      entries.push(e);
    }
    cur = { item: {} };
  };
  for (const r of rows) {
    const name = r.FieldName.trim();
    const value = (r.FieldValue ?? "").trim();
    const text = (r.FieldValueText ?? "").trim();
    switch (name) {
      case "WORKDATE":
        flush();
        cur.date = isoDate(value);
        break;
      case "TIME":
        cur.hours = Number(value) || 0;
        break;
      case "COUNTER":
        cur.counter = text || value;
        break;
      case "STATUS":
        cur.status = value;
        cur.statusText = text || value;
        break;
      case "REASON":
        if (text) cur.rejectionReason = text;
        break;
      case "NOTES":
        if (text) cur.notes = text;
        break;
      case "AWART":
        cur.attendanceType = { code: value, text: text || value };
        cur.item.attendanceType = value;
        break;
      case "RAUFNR":
        cur.order = { code: stripZeros(value), text: text || stripZeros(value) };
        cur.item.order = stripZeros(value);
        break;
      case "RKDAUF":
        cur.salesOrder = { code: stripZeros(value), text: text || stripZeros(value) };
        cur.item.salesOrder = stripZeros(value);
        break;
      case "RKDPOS":
        cur.salesOrderItem = { code: value, text: text || value };
        cur.item.salesOrderItem = value;
        break;
      case "LTXA1":
        if (value) {
          cur.shortText = value;
          cur.item.shortText = value;
        }
        break;
      case "ZZTEXT":
        if (value) {
          cur.text = value;
          cur.item.text = value;
        }
        break;
      default:
        break; // MEINH, STARTTIME, ENDTIME …
    }
  }
  flush();
  return entries;
}

function parseFavorite(r: Record<string, unknown>): Favorite {
  const df = (r.FavoriteDataFields ?? {}) as Record<string, string | number>;
  const item: EntryItem = {};
  for (const [field, key] of Object.entries(FIELD_TO_ITEM)) {
    const v = df[field];
    if (v !== undefined && v !== "" && v !== null && !(field === "RKDPOS" && String(v) === "000000")) item[key] = stripZerosForField(field, String(v));
  }
  const hours = Number(df.CATSHOURS);
  const codeTexts = {
    attendanceType: item.attendanceType ? { code: item.attendanceType, text: item.attendanceType } : undefined,
    order: item.order ? { code: item.order, text: item.order } : undefined,
    salesOrder: item.salesOrder ? { code: item.salesOrder, text: item.salesOrder } : undefined,
    salesOrderItem: item.salesOrderItem ? { code: item.salesOrderItem, text: item.salesOrderItem } : undefined,
  };
  return {
    id: String(r.ID ?? "").trim(),
    name: String(r.Name ?? ""),
    type: String(r.ObjType ?? ""),
    ...(hours > 0 ? { hours } : {}),
    item,
    description: String(r.Field_Text ?? "") || itemLabel(codeTexts as Parameters<typeof itemLabel>[0]),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The part of an item that identifies a jobcode (no texts). */
function pickJobcode(item: EntryItem): EntryItem {
  const out: EntryItem = {};
  if (item.attendanceType) out.attendanceType = item.attendanceType;
  if (item.order) out.order = item.order;
  if (item.salesOrder) out.salesOrder = item.salesOrder;
  if (item.salesOrderItem) out.salesOrderItem = item.salesOrderItem;
  return out;
}

export function jobcodeKey(item: EntryItem): string {
  return [stripZeros(item.salesOrder), item.salesOrderItem ?? "", stripZeros(item.order), item.attendanceType ?? ""].join("|");
}
const today = () => new Date().toISOString().slice(0, 10);

function defaultRange(from?: string, to?: string) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const last = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, "0");
  return { start: from ? sapDate(from) : `${y}${mm}01`, end: to ? sapDate(to) : `${y}${mm}${String(last).padStart(2, "0")}` };
}

export type { CodeText };
