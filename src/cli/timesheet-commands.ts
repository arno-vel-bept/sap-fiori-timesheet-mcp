import type { Command } from "commander";
import type { SapClient } from "../sap/client.js";
import { StandardTimesheet } from "../timesheet/standard.js";
import { BALANCE_MODES, MultiprojectTimesheet, type AllocationPlan, type BalanceMode } from "../timesheet/multiproject.js";
import type { EntryItem, SubmitResult } from "../timesheet/types.js";
import { TimesheetError } from "../timesheet/types.js";
import { currentMonthRange, expandDates, fmtHours, parseMonth, table } from "./format.js";

export interface CommandContext {
  client(): Promise<SapClient>;
  out(s: string): void;
  err(s: string): void;
  /** Mark the run as partially failed (exit code 4) without throwing. */
  fail(): void;
}

interface ItemOpts {
  attendanceType?: string;
  order?: string;
  salesOrder?: string;
  salesOrderItem?: string;
  shortText?: string;
  favorite?: string;
}

function itemFromOpts(o: ItemOpts): EntryItem {
  const item: EntryItem = {};
  if (o.attendanceType) item.attendanceType = o.attendanceType;
  if (o.order) item.order = o.order;
  if (o.salesOrder) item.salesOrder = o.salesOrder;
  if (o.salesOrderItem) item.salesOrderItem = o.salesOrderItem;
  return item;
}

/** The "jobcode" options shared by all booking commands. */
function addItemOptions(cmd: Command): Command {
  return cmd
    .option("-a, --attendance-type <code>", "jobcode: attendance/absence type, e.g. 0010 holiday, 0077 admin, 0800 chargeable, 0081 NCH order")
    .option("-o, --order <code>", "jobcode: non-chargeable order, e.g. 900140 (usually with -a 0081)")
    .option("-s, --sales-order <code>", "jobcode: chargeable sales order, e.g. 3141993 (usually with -a 0800)")
    .option("-i, --sales-order-item <code>", "item of the sales order, e.g. 000401; required with --sales-order");
}

const DRY_RUN = "show what would be booked, write nothing";

/** Renders a per-day plan (allocateMany / balance previews). */
function planTable(plan: AllocationPlan): string {
  const names = plan.slots.map((s, i) => `${i + 1}. ${s.label}`);
  const header = plan.slots.map((s) => s.label);
  return (
    table(
      plan.days.map((d) => {
        const row: Record<string, unknown> = { date: d.date, target: fmtHours(d.targetHours) };
        header.forEach((h, i) => (row[h] = fmtHours(d.hours[i])));
        row.total = fmtHours(d.hours.reduce((a, b) => a + b, 0));
        return row;
      }),
      ["date", "target", ...header, "total"],
    ) +
    "\n\n" +
    table(plan.slots.map((s) => ({ project: s.label, hours: fmtHours(s.hours), ...("share" in s ? { share: `${(s as { share: number }).share}%` } : {}) }))) +
    (names.length ? "" : "")
  );
}

async function resolveItem(ts: StandardTimesheet, o: ItemOpts & { hours?: string }): Promise<{ item: EntryItem; hours: number }> {
  let item = itemFromOpts(o);
  let hours = o.hours ? Number(o.hours) : undefined;
  if (o.favorite) {
    const favs = await ts.favorites();
    const f = favs.find((x) => x.id === o.favorite || x.name.toLowerCase() === o.favorite!.toLowerCase());
    if (!f) throw new TimesheetError(`No favorite "${o.favorite}". Known: ${favs.map((x) => x.name).join(", ")}`);
    item = { ...f.item, ...item };
    hours ??= f.hours;
  }
  return { item, hours: hours ?? 8 };
}

const printResults = (ctx: CommandContext, results: SubmitResult[], json: boolean) => {
  if (json) ctx.out(JSON.stringify(results, null, 2));
  else ctx.out(table(results.map((r) => ({ date: r.date, result: r.ok ? "ok" : "FAILED", counter: r.counter ?? "", status: r.status ?? "", error: r.error ?? "" }))));
  if (results.some((r) => !r.ok)) ctx.fail();
};

export function registerTimesheetCommands(program: Command, ctx: CommandContext): void {
  const std = program.command("std").description("Standard timesheet (#StandardTimesheet-manage)");
  const rangeOpts = (c: Command) =>
    c.option("--from <date>", "start date YYYY-MM-DD (default: first day of this month)").option("--to <date>", "end date YYYY-MM-DD (default: last day of this month)");
  const range = (o: { from?: string; to?: string }) => {
    const def = currentMonthRange();
    return { from: o.from ?? def.from, to: o.to ?? def.to };
  };
  const jsonOpt = (c: Command) => c.option("--json", "print JSON", false);

  jsonOpt(rangeOpts(std.command("open-days").description("Working days in open periods that still miss hours, with what is already booked"))).action(
    async (o: { from?: string; to?: string; json: boolean }) => {
      const ts = new StandardTimesheet(await ctx.client());
      const { from, to } = range(o);
      const days = await ts.openDays(from, to);
      if (o.json) return ctx.out(JSON.stringify(days, null, 2));
      if (days.length === 0) return ctx.out(`No open days with missing hours between ${from} and ${to}.`);
      ctx.out(
        table(
          days.map((d) => ({
            date: d.date,
            target: fmtHours(d.targetHours),
            booked: fmtHours(d.bookedHours),
            missing: fmtHours(d.missingHours),
            entries: d.entries.map((e) => `${fmtHours(e.hours)}h ${e.label} [${e.status}]`).join(" | "),
          })),
        ),
      );
    },
  );

  jsonOpt(rangeOpts(std.command("entries").description("List time entries in a date range"))).action(async (o: { from?: string; to?: string; json: boolean }) => {
    const ts = new StandardTimesheet(await ctx.client());
    const { from, to } = range(o);
    const entries = await ts.entries(from, to);
    if (o.json) return ctx.out(JSON.stringify(entries, null, 2));
    ctx.out(table(entries.map((e) => ({ date: e.date, hours: fmtHours(e.hours), status: e.status, counter: e.counter, entry: e.label, notes: e.notes ?? "" }))));
  });

  jsonOpt(rangeOpts(std.command("calendar").description("Calendar days with target hours and period status"))).action(async (o: { from?: string; to?: string; json: boolean }) => {
    const ts = new StandardTimesheet(await ctx.client());
    const { from, to } = range(o);
    const days = await ts.calendar(from, to);
    if (o.json) return ctx.out(JSON.stringify(days, null, 2));
    ctx.out(table(days.map((d) => ({ date: d.date, target: fmtHours(d.targetHours), workingDay: d.workingDay ? "yes" : "no", status: d.status }))));
  });

  jsonOpt(std.command("info").description("Profile info (personnel number, data entry profile, release settings)")).action(async (o: { json: boolean }) => {
    const info = await new StandardTimesheet(await ctx.client()).info();
    if (o.json) return ctx.out(JSON.stringify(info, null, 2));
    for (const [k, v] of Object.entries(info)) ctx.out(`${k.padEnd(18)} ${String(v)}`);
  });

  jsonOpt(std.command("favorites").description("List favorite entries")).action(async (o: { json: boolean }) => {
    const favs = await new StandardTimesheet(await ctx.client()).favorites();
    if (o.json) return ctx.out(JSON.stringify(favs, null, 2));
    ctx.out(table(favs.map((f) => ({ name: f.name, hours: f.hours !== undefined ? fmtHours(f.hours) : "", item: itemToText(f.item), id: f.id }))));
  });

  const fav = std.command("favorite").description("Manage favorites");
  jsonOpt(addItemOptions(fav.command("add <name>").description("Create a favorite")).option("-h, --hours <n>", "default hours")).action(async (name: string, o: ItemOpts & { hours?: string; json: boolean }) => {
    const created = await new StandardTimesheet(await ctx.client()).addFavorite(name, itemFromOpts(o), o.hours ? Number(o.hours) : undefined);
    ctx.out(o.json ? JSON.stringify(created, null, 2) : `Favorite "${created.name}" created (id ${created.id})`);
  });
  fav.command("remove <id>").description("Delete a favorite by id").action(async (id: string) => {
    await new StandardTimesheet(await ctx.client()).deleteFavorite(id);
    ctx.out(`Favorite ${id} deleted`);
  });

  const vh = (name: string, desc: string, run: (ts: StandardTimesheet, q: string | undefined, o: { from?: string; to?: string; top?: string }) => Promise<unknown[]>) =>
    jsonOpt(rangeOpts(std.command(`${name} [query]`).description(desc).option("--top <n>", "max results")))
      .action(async (query: string | undefined, o: { from?: string; to?: string; top?: string; json: boolean }) => {
        const rows = (await run(new StandardTimesheet(await ctx.client()), query, o)) as Record<string, unknown>[];
        if (o.json) return ctx.out(JSON.stringify(rows, null, 2));
        ctx.out(table(rows));
      });
  const vhOpts = (o: { from?: string; to?: string; top?: string }) => ({ from: o.from, to: o.to, top: o.top ? Number(o.top) : undefined });
  vh("attendance-types", "Attendance / absence types (AWART). Query is a case-sensitive substring of the text.", (ts, q, o) => ts.attendanceTypes(q, vhOpts(o)));
  vh("chargeable-orders", "Chargeable sales orders (RKDAUF). Query is a case-sensitive substring of the text.", (ts, q, o) => ts.chargeableOrders(q, vhOpts(o)));
  vh("non-chargeable-orders", "Non-chargeable receiver orders (RAUFNR). Query is a case-sensitive substring of the text.", (ts, q, o) => ts.nonChargeableOrders(q, vhOpts(o)));
  jsonOpt(rangeOpts(std.command("sales-order-items <salesOrder>").description("Items (RKDPOS) of a chargeable sales order"))).action(async (so: string, o: { from?: string; to?: string; json: boolean }) => {
    const rows = await new StandardTimesheet(await ctx.client()).salesOrderItems(so, { from: o.from, to: o.to });
    ctx.out(o.json ? JSON.stringify(rows, null, 2) : table(rows as unknown as Record<string, unknown>[]));
  });
  jsonOpt(rangeOpts(std.command("worklist").description("Worklist (assignments) for a date range"))).action(async (o: { from?: string; to?: string; json: boolean }) => {
    const { from, to } = range(o);
    const rows = await new StandardTimesheet(await ctx.client()).worklist(from, to);
    ctx.out(o.json ? JSON.stringify(rows, null, 2) : table(rows.map((w) => ({ label: w.label, item: itemToText(w.item) }))));
  });

  jsonOpt(
    addItemOptions(
      std
        .command("fill <dates...>")
        .description("Book the same item on several days. Dates: YYYY-MM-DD, or YYYY-MM-DD..YYYY-MM-DD (working days only), comma-separated allowed"),
    )
      .option("-f, --favorite <name-or-id>", "use a favorite instead of item options")
      .option("-h, --hours <n>", "hours per day (default: favorite's hours, else 8)")
      .option("-t, --short-text <text>", "short text (LTXA1)")
      .option("-n, --notes <text>", "long text / notes")
      .option("--include-weekends", "also fill Saturdays/Sundays in ranges", false)
      .option("--no-release", "omit the release flag (no effect on auto-approving profiles such as MA-FACHL)"),
  ).action(async (dateArgs: string[], o: ItemOpts & { hours?: string; notes?: string; includeWeekends: boolean; release: boolean; json: boolean }) => {
    const ts = new StandardTimesheet(await ctx.client());
    const dates = expandDates(dateArgs, { includeWeekends: o.includeWeekends });
    let item = itemFromOpts(o);
    let hours = o.hours ? Number(o.hours) : undefined;
    if (o.favorite) {
      const favs = await ts.favorites();
      const f = favs.find((x) => x.id === o.favorite || x.name.toLowerCase() === o.favorite!.toLowerCase());
      if (!f) throw new TimesheetError(`No favorite "${o.favorite}". Known: ${favs.map((x) => x.name).join(", ")}`);
      item = { ...f.item, ...item };
      hours ??= f.hours;
    }
    hours ??= 8;
    const results = await ts.fill(dates, item, hours, { release: o.release, shortText: o.shortText, notes: o.notes });
    printResults(ctx, results, o.json);
  });

  jsonOpt(rangeOpts(std.command("remove <counters...>").description("Delete entries by counter (the entries must lie in --from/--to, default this month)"))).action(
    async (counters: string[], o: { from?: string; to?: string; json: boolean }) => {
      const ts = new StandardTimesheet(await ctx.client());
      const results = await ts.remove(counters, range(o));
      if (o.json) ctx.out(JSON.stringify(results, null, 2));
      else ctx.out(table(results.map((r) => ({ counter: r.counter, result: r.ok ? "ok" : "FAILED", date: r.date ?? "", error: r.error ?? "" }))));
      if (results.some((r) => !r.ok)) ctx.fail();
    },
  );

  jsonOpt(
    addItemOptions(std.command("update <counter> <date>").description("Change hours/item of an existing entry"))
      .requiredOption("-h, --hours <n>", "new hours")
      .option("-t, --short-text <text>", "short text (LTXA1)")
      .option("--no-release", "save only"),
  ).action(async (counter: string, date: string, o: ItemOpts & { hours: string; release: boolean; json: boolean }) => {
    const ts = new StandardTimesheet(await ctx.client());
    const results = await ts.update([{ counter, date, item: itemFromOpts(o), hours: Number(o.hours), shortText: o.shortText, release: o.release }]);
    printResults(ctx, results, o.json);
  });

  jsonOpt(rangeOpts(std.command("days").description("Every working day of the range: filled or missing, with hours and entries"))).action(async (o: { from?: string; to?: string; json: boolean }) => {
    const ts = new StandardTimesheet(await ctx.client());
    const { from, to } = range(o);
    const days = await ts.days(from, to);
    if (o.json) return ctx.out(JSON.stringify(days, null, 2));
    ctx.out(
      table(
        days.map((d) => ({
          date: d.date,
          state: d.closed ? "closed" : d.filled ? "filled" : "MISSING",
          target: fmtHours(d.targetHours),
          booked: fmtHours(d.bookedHours),
          missing: fmtHours(d.missingHours),
          entries: d.entries.map((e) => `${fmtHours(e.hours)}h ${e.label}`).join(" | "),
        })),
      ),
    );
    const missing = days.filter((d) => !d.closed && !d.filled);
    ctx.out(`\n${days.filter((d) => d.filled).length} filled, ${missing.length} missing (${fmtHours(missing.reduce((a, d) => a + d.missingHours, 0))}h)`);
  });

  jsonOpt(
    addItemOptions(std.command("set <dates...>").description("Make the given days contain exactly this item: existing entries on those days are deleted first"))
      .option("-f, --favorite <name-or-id>", "use a favorite instead of item options")
      .option("-h, --hours <n>", "hours per day (default: favorite's hours, else 8)")
      .option("-t, --short-text <text>", "short text (LTXA1)")
      .option("--include-weekends", "also include Saturdays/Sundays in ranges", false)
      .option("--no-release", "omit the release flag")
      .option("--dry-run", DRY_RUN, false),
  ).action(async (dateArgs: string[], o: ItemOpts & { hours?: string; includeWeekends: boolean; release: boolean; json: boolean; dryRun: boolean }) => {
    const ts = new StandardTimesheet(await ctx.client());
    const dates = expandDates(dateArgs, { includeWeekends: o.includeWeekends });
    const { item, hours } = await resolveItem(ts, o);
    if (o.dryRun) {
      const plan = await ts.planSet(dates, item, hours);
      if (o.json) return ctx.out(JSON.stringify({ dryRun: true, ...plan }, null, 2));
      ctx.out(`Dry run — nothing written. Would set ${itemToText(item)} for ${fmtHours(hours)}h on ${dates.length} day(s):`);
      if (plan.toRemove.length) ctx.out("\nRemove:\n" + table(plan.toRemove.map((e) => ({ date: e.date, counter: e.counter, hours: fmtHours(e.hours), entry: e.label }))));
      return ctx.out("\nCreate:\n" + table(plan.toCreate.map((c) => ({ date: c.date, hours: fmtHours(c.hours), jobcode: itemToText(item) }))));
    }
    const res = await ts.set(dates, item, hours, { release: o.release, shortText: o.shortText });
    if (o.json) ctx.out(JSON.stringify(res, null, 2));
    else {
      if (res.removed.length) ctx.out(table(res.removed.map((r) => ({ removed: r.counter, date: r.date, result: r.ok ? "ok" : "FAILED", error: r.error ?? "" }))));
      ctx.out(table(res.created.map((r) => ({ date: r.date, result: r.ok ? "ok" : "FAILED", counter: r.counter ?? "", error: r.error ?? "" }))));
    }
    if ([...res.removed, ...res.created].some((r) => !r.ok)) ctx.fail();
  });

  jsonOpt(rangeOpts(std.command("jobcodes [codes...]").description("Which jobcodes (orders / sales orders / attendance types) the range contains, with day counts, hours and share; optional codes filter"))).action(
    async (codes: string[], o: { from?: string; to?: string; json: boolean }) => {
      const ts = new StandardTimesheet(await ctx.client());
      const { from, to } = range(o);
      const stats = await ts.jobcodes(from, to, { codes });
      if (o.json) return ctx.out(JSON.stringify(stats, null, 2));
      if (stats.length === 0) return ctx.out(codes.length ? `None of ${codes.join(", ")} between ${from} and ${to}.` : `No entries between ${from} and ${to}.`);
      ctx.out(table(stats.map((s) => ({ jobcode: s.label, days: s.days, hours: fmtHours(s.hours), share: `${s.share}%`, dates: s.dates.join(",") }))));
    },
  );

  jsonOpt(rangeOpts(std.command("staffing").description("Staffing plan (MDS) for the range — what the app's 'Retrieve staffing' loads. --apply books it on open days that still miss the hours")))
    .option("--apply", "create the planned entries", false)
    .option("--dates <dates>", "with --apply: only these comma-separated days")
    .option("--no-release", "with --apply: omit the release flag")
    .option("--dry-run", `with --apply: ${DRY_RUN}`, false)
    .action(async (o: { from?: string; to?: string; json: boolean; apply: boolean; dates?: string; release: boolean; dryRun: boolean }) => {
      const ts = new StandardTimesheet(await ctx.client());
      const { from, to } = range(o);
      if (o.apply && o.dryRun) {
        const plan = await ts.planStaffing(from, to, { dates: o.dates ? expandDates([o.dates], { includeWeekends: true }) : undefined });
        if (o.json) return ctx.out(JSON.stringify({ dryRun: true, ...plan }, null, 2));
        ctx.out(`Dry run — nothing written. Would book ${plan.toBook.length} planned entr${plan.toBook.length === 1 ? "y" : "ies"}:`);
        ctx.out(table(plan.toBook.map((b) => ({ date: b.date, hours: fmtHours(b.hours), planned: b.label }))));
        if (plan.skipped.length) ctx.out("\nSkipped:\n" + table(plan.skipped));
        return;
      }
      if (!o.apply) {
        const plan = await ts.staffing(from, to);
        if (o.json) return ctx.out(JSON.stringify(plan, null, 2));
        if (plan.length === 0) return ctx.out(`No staffing data between ${from} and ${to}.`);
        return ctx.out(table(plan.map((e) => ({ date: e.date, hours: fmtHours(e.hours), planned: e.label }))));
      }
      const res = await ts.applyStaffing(from, to, { dates: o.dates ? expandDates([o.dates], { includeWeekends: true }) : undefined, release: o.release });
      if (o.json) ctx.out(JSON.stringify(res, null, 2));
      else {
        ctx.out(table(res.created.map((r) => ({ date: r.date, result: r.ok ? "ok" : "FAILED", counter: r.counter ?? "", error: r.error ?? "" }))));
        if (res.skipped.length) ctx.out("\nSkipped:\n" + table(res.skipped));
      }
      if (res.created.some((r) => !r.ok)) ctx.fail();
    });

  jsonOpt(
    addItemOptions(rangeOpts(std.command("fill-open").description("Quick action: book the item on every open day of the range, with each day's missing hours")))
      .option("-f, --favorite <name-or-id>", "use a favorite instead of item options")
      .option("--max-hours <n>", "cap hours per day")
      .option("-t, --short-text <text>", "short text (LTXA1)")
      .option("--no-release", "omit the release flag")
      .option("--dry-run", DRY_RUN, false),
  ).action(async (o: ItemOpts & { from?: string; to?: string; maxHours?: string; release: boolean; json: boolean; dryRun: boolean }) => {
    const ts = new StandardTimesheet(await ctx.client());
    const { from, to } = range(o);
    const { item } = await resolveItem(ts, o);
    if (o.dryRun) {
      const plan = await ts.planFillOpen(from, to, item, { maxHours: o.maxHours ? Number(o.maxHours) : undefined });
      if (o.json) return ctx.out(JSON.stringify({ dryRun: true, item, days: plan }, null, 2));
      ctx.out(`Dry run — nothing written. Would book ${itemToText(item)} on ${plan.length} day(s), ${fmtHours(plan.reduce((a, d) => a + d.hours, 0))}h in total:`);
      return ctx.out(table(plan.map((d) => ({ date: d.date, hours: fmtHours(d.hours) }))));
    }
    const res = await ts.fillOpen(from, to, item, { maxHours: o.maxHours ? Number(o.maxHours) : undefined, shortText: o.shortText, release: o.release });
    if (o.json) ctx.out(JSON.stringify(res, null, 2));
    else if (res.length === 0) ctx.out(`Nothing to fill between ${from} and ${to}.`);
    else ctx.out(table(res.map((r) => ({ date: r.date, hours: fmtHours(r.hours), result: r.ok ? "ok" : "FAILED", counter: r.counter ?? "", error: r.error ?? "" }))));
    if (res.some((r) => !r.ok)) ctx.fail();
  });

  // ---------------- Multiproject ----------------
  const mp = program.command("mp").description("Multiproject timesheet (#MultiprojectTimesheet-manage)");

  jsonOpt(mp.command("months").description("Months with status and hour totals")).action(async (o: { json: boolean }) => {
    const months = await new MultiprojectTimesheet(await ctx.client()).months();
    if (o.json) return ctx.out(JSON.stringify(months, null, 2));
    ctx.out(table(months.map((m) => ({ month: `${m.year}-${String(m.month).padStart(2, "0")}`, status: m.status, total: fmtHours(m.totalHours), missing: fmtHours(m.missingHours), chargeable: fmtHours(m.chargeableHours) }))));
  });

  jsonOpt(mp.command("month <yyyy-mm>").description("Project x day grid of a month")).action(async (arg: string, o: { json: boolean }) => {
    const { year, month } = parseMonth(arg);
    const sheet = await new MultiprojectTimesheet(await ctx.client()).month(year, month);
    if (o.json) return ctx.out(JSON.stringify(sheet, null, 2));
    ctx.out(`${arg}  status=${sheet.status}  total=${fmtHours(sheet.totalHours)}h`);
    ctx.out("");
    ctx.out(table(sheet.projects.map((p) => ({ column: p.column, project: p.label, order: p.order, attendanceType: p.attendanceType, salesOrder: p.salesOrder, item: p.salesOrderItem }))));
    ctx.out("");
    const rows = sheet.days.map((d) => {
      const row: Record<string, unknown> = { date: d.date, target: fmtHours(d.targetHours) };
      for (const p of sheet.projects) {
        const c = d.cells[p.column];
        row[p.column] = c.hours ? `${fmtHours(c.hours)}${c.text ? ` "${c.text}"` : ""}` : "";
      }
      row.total = fmtHours(d.totalHours);
      return row;
    });
    ctx.out(table(rows));
  });

  jsonOpt(mp.command("favorites").description("Favorites as seen by the multiproject app")).action(async (o: { json: boolean }) => {
    const favs = await new MultiprojectTimesheet(await ctx.client()).favorites();
    if (o.json) return ctx.out(JSON.stringify(favs, null, 2));
    ctx.out(table(favs.map((f) => ({ name: f.name, hours: f.hours !== undefined ? fmtHours(f.hours) : "", item: itemToText(f.item), id: f.id }))));
  });

  jsonOpt(
    addItemOptions(mp.command("allocate <yyyy-mm>").description("Allocate hours per day to a project (creates the project column if needed)"))
      .option("-d, --day <date=hours...>", "e.g. --day 2026-09-03=4 --day 2026-09-04=8 (0 clears the day)")
      .option("-r, --range <from..to>", "every working day of the range, with --hours per day")
      .option("-h, --hours <n>", "hours per day for --range")
      .option("-t, --text <text>", "short text stored on each cell"),
  ).action(async (arg: string, o: ItemOpts & { day?: string[]; range?: string; hours?: string; text?: string; json: boolean }) => {
    const { year, month } = parseMonth(arg);
    const allocations = (o.day ?? []).map((d) => {
      const m = /^(\d{4}-\d{2}-\d{2})=(\d+(?:\.\d+)?)$/.exec(d.trim());
      if (!m) throw new TimesheetError(`Invalid --day "${d}": use YYYY-MM-DD=hours`);
      return { date: m[1], hours: Number(m[2]), text: o.text };
    });
    if (o.range) {
      if (!o.hours) throw new TimesheetError("--range needs --hours");
      for (const date of expandDates([o.range])) allocations.push({ date, hours: Number(o.hours), text: o.text });
    }
    if (allocations.length === 0) throw new TimesheetError("Give --day date=hours and/or --range from..to --hours n");
    const sheet = await new MultiprojectTimesheet(await ctx.client()).allocate(year, month, itemFromOpts(o), allocations);
    if (o.json) return ctx.out(JSON.stringify(sheet, null, 2));
    const p = sheet.projects.find((x) => sameItem(x, itemFromOpts(o)));
    ctx.out(`Saved. ${arg} total=${fmtHours(sheet.totalHours)}h; project ${p?.label ?? itemToText(itemFromOpts(o))}:`);
    ctx.out(table(allocations.map((a) => ({ date: a.date, hours: fmtHours(p ? sheet.days.find((d) => d.date === a.date)?.cells[p.column].hours ?? 0 : a.hours) }))));
  });

  jsonOpt(
    mp.command("plan <yyyy-mm>")
      .description("Several projects per day over a range in one save, e.g. every day 2h on X and 6h on Y")
      .requiredOption("-r, --range <from..to>", "working days of the range")
      .requiredOption("-s, --slot <spec...>", "jobcode:hours-per-day, e.g. --slot order=900140,attendance=0081:2 --slot attendance=0077:6 --slot salesOrder=3141993/000401,attendance=0800:4")
      .option("-t, --text <text>", "short text stored on each cell")
      .option("--dry-run", DRY_RUN, false),
  ).action(async (arg: string, o: { range: string; slot: string[]; text?: string; json: boolean; dryRun: boolean }) => {
    const { year, month } = parseMonth(arg);
    const { from, to } = parseRange(o.range);
    const slots = o.slot.map((sp) => {
      const { item, value } = parseSlot(sp);
      return { project: item, range: { from, to }, hours: value, text: o.text };
    });
    const mpc = new MultiprojectTimesheet(await ctx.client());
    const plan = await mpc.previewAllocateMany(year, month, slots);
    if (o.dryRun) {
      if (o.json) return ctx.out(JSON.stringify({ dryRun: true, ...plan }, null, 2));
      ctx.out(`Dry run — nothing written. Plan for ${arg}, ${from}..${to} (${fmtHours(plan.totalHours)}h):\n`);
      return ctx.out(planTable(plan));
    }
    const sheet = await mpc.allocateMany(year, month, slots);
    if (o.json) return ctx.out(JSON.stringify(sheet, null, 2));
    ctx.out(`Saved ${arg} (month total ${fmtHours(sheet.totalHours)}h). Booked:\n`);
    ctx.out(planTable(plan));
  });

  jsonOpt(rangeOpts(mp.command("stats <yyyy-mm>").description("Which projects a day / range / month contains, with hours, days and proportion"))).action(
    async (arg: string, o: { from?: string; to?: string; json: boolean }) => {
      const { year, month } = parseMonth(arg);
      const st = await new MultiprojectTimesheet(await ctx.client()).stats(year, month, { from: o.from, to: o.to });
      if (o.json) return ctx.out(JSON.stringify(st, null, 2));
      ctx.out(`${st.from} .. ${st.to}: ${fmtHours(st.totalHours)}h booked of ${fmtHours(st.targetHours)}h target`);
      ctx.out(table(st.projects.map((p) => ({ project: p.project.label, hours: fmtHours(p.hours), days: p.days, share: `${p.share}%` }))));
    },
  );

  jsonOpt(
    mp.command("balance <yyyy-mm>")
      .description(
        "Rewrite the working days of a range so the jobcodes hold the given shares of the target hours (e.g. 60% X / 40% Y). " +
          "--mode whole-days (default): consecutive whole days per jobcode; --mode every-day: each day split by the shares. Use --dry-run to preview.",
      )
      .requiredOption("-r, --range <from..to>", "working days of the range, e.g. 2026-09-01..2026-09-12")
      .requiredOption("-s, --slot <spec...>", "jobcode:share%, e.g. --slot order=900140,attendance=0081:60% --slot attendance=0077:40%")
      .option("-m, --mode <mode>", `${BALANCE_MODES.join(" | ")}`, "whole-days")
      .option("--dry-run", DRY_RUN, false),
  ).action(async (arg: string, o: { range: string; slot: string[]; mode: string; json: boolean; dryRun: boolean }) => {
    const { year, month } = parseMonth(arg);
    const { from, to } = parseRange(o.range);
    if (!BALANCE_MODES.includes(o.mode as BalanceMode)) throw new TimesheetError(`Unknown --mode "${o.mode}": use ${BALANCE_MODES.join(" or ")}`);
    const mode = o.mode as BalanceMode;
    const slots = o.slot.map((sp) => {
      const { item, value } = parseSlot(sp, true);
      return { project: item, share: value };
    });
    const mpc = new MultiprojectTimesheet(await ctx.client());
    const plan = await mpc.previewBalance(year, month, { from, to }, slots, { mode });
    if (o.dryRun) {
      if (o.json) return ctx.out(JSON.stringify({ dryRun: true, ...plan }, null, 2));
      ctx.out(`Dry run — nothing written. Balance ${from}..${to} (${fmtHours(plan.targetHours)}h target), mode ${mode}:\n`);
      return ctx.out(planTable(plan));
    }
    await mpc.balance(year, month, { from, to }, slots, { mode });
    const st = await mpc.stats(year, month, { from, to });
    if (o.json) return ctx.out(JSON.stringify({ mode, ...st }, null, 2));
    ctx.out(`Balanced ${from}..${to} (mode ${mode}): ${fmtHours(st.totalHours)}h of ${fmtHours(st.targetHours)}h target\n`);
    ctx.out(planTable(plan));
  });

  jsonOpt(addItemOptions(mp.command("clear <yyyy-mm>").description("Remove a project's hours on given days (or the whole month)")).option("--dates <dates>", "comma-separated YYYY-MM-DD; default: all days")).action(
    async (arg: string, o: ItemOpts & { dates?: string; json: boolean }) => {
      const { year, month } = parseMonth(arg);
      const dates = o.dates ? expandDates([o.dates], { includeWeekends: true }) : undefined;
      const sheet = await new MultiprojectTimesheet(await ctx.client()).clear(year, month, itemFromOpts(o), dates);
      if (o.json) return ctx.out(JSON.stringify(sheet, null, 2));
      ctx.out(`Cleared. ${arg} total=${fmtHours(sheet.totalHours)}h`);
    },
  );
}

/**
 * Parses a compact slot: `order=900140,att=0081:2` / `salesOrder=3141993/000401,att=0800:4` /
 * `att=0077:60%`. Keys: att|order|salesOrder (salesOrder may carry `/item`), value after `:` is
 * hours (or a percentage when `percent` is set).
 */
export function parseSlot(spec: string, percent = false): { item: EntryItem; value: number } {
  const m = /^(.+?):(\d+(?:\.\d+)?)(%?)$/.exec(spec.trim());
  if (!m) throw new TimesheetError(`Invalid slot "${spec}": expected e.g. order=900140,attendance=0081:${percent ? "60%" : "2"}`);
  if (percent && !m[3]) throw new TimesheetError(`Slot "${spec}": share must be a percentage like 60%`);
  const item: EntryItem = {};
  for (const part of m[1].split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (!k || !v) throw new TimesheetError(`Invalid slot part "${part}" in "${spec}"`);
    if (k === "att" || k === "attendance" || k === "attendanceType") item.attendanceType = v;
    else if (k === "order") item.order = v;
    else if (k === "salesOrder" || k === "so") {
      const [so, it] = v.split("/");
      item.salesOrder = so;
      if (it) item.salesOrderItem = it;
    } else if (k === "item") item.salesOrderItem = v;
    else throw new TimesheetError(`Unknown slot key "${k}" in "${spec}" (use attendance, order, salesOrder[/item])`);
  }
  return { item, value: Number(m[2]) };
}

function parseRange(spec: string): { from: string; to: string } {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(spec.trim());
  if (!m) throw new TimesheetError(`Invalid --range "${spec}": use YYYY-MM-DD..YYYY-MM-DD`);
  return { from: m[1], to: m[2] };
}

function itemToText(item: EntryItem): string {
  const bits: string[] = [];
  if (item.salesOrder) bits.push(`salesOrder=${item.salesOrder}${item.salesOrderItem ? `/${item.salesOrderItem}` : ""}`);
  if (item.order) bits.push(`order=${item.order}`);
  if (item.attendanceType) bits.push(`att=${item.attendanceType}`);
  if (item.shortText) bits.push(`"${item.shortText}"`);
  if (item.text) bits.push(item.text);
  return bits.join(" ");
}

function sameItem(p: { order: string; attendanceType: string; salesOrder: string; salesOrderItem: string }, item: EntryItem): boolean {
  const z = (v: string | undefined) => (v ?? "").replace(/^0+/, "");
  return z(p.order) === z(item.order) && p.attendanceType === (item.attendanceType ?? "") && z(p.salesOrder) === z(item.salesOrder) && (p.salesOrderItem === "000000" ? "" : p.salesOrderItem) === (item.salesOrderItem ?? "");
}
