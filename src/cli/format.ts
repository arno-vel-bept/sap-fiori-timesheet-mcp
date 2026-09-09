/** Tiny table / output helpers for the CLI. */

export function table(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return "(none)";
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join("\n");
}

export const fmtHours = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(2));

/**
 * Expands date arguments: `2026-09-03`, `2026-09-01..2026-09-05` (working days
 * only unless `includeWeekends`), or a comma-separated mix.
 */
export function expandDates(args: string[], opts: { includeWeekends?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const arg of args.flatMap((a) => a.split(","))) {
    const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(arg.trim());
    if (range) {
      const d = new Date(range[1] + "T00:00:00");
      const end = new Date(range[2] + "T00:00:00");
      if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime())) throw new Error(`Invalid date range "${arg}"`);
      while (d <= end) {
        const dow = d.getDay();
        if (opts.includeWeekends || (dow !== 0 && dow !== 6)) out.push(iso(d));
        d.setDate(d.getDate() + 1);
      }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg.trim())) {
      out.push(arg.trim());
    } else {
      throw new Error(`Invalid date "${arg}": use YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD`);
    }
  }
  return [...new Set(out)];
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function parseMonth(arg: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{1,2})$/.exec(arg);
  if (!m) throw new Error(`Invalid month "${arg}": use YYYY-MM`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const last = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}
