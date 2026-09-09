/** Shared domain types for both timesheet apps. */

/** What an entry is booked on. Codes as the user knows them (no leading zeros required). */
export interface EntryItem {
  /** Attendance/absence type (AWART), e.g. "0010" holiday, "0800" chargeable hours, "0081" NCH order. */
  attendanceType?: string;
  /** Non-chargeable receiver order (RAUFNR), e.g. "900140". */
  order?: string;
  /** Chargeable receiving sales order (RKDAUF), e.g. "3136787". */
  salesOrder?: string;
  /** Sales order item (RKDPOS), e.g. "000401"; required with a sales order. */
  salesOrderItem?: string;
  /** Short text (LTXA1), max 40 chars. */
  shortText?: string;
  /** Free text (ZZTEXT) — read-only on most profiles; usually filled by SAP from the order. */
  text?: string;
  /** Country / state (ZZLAND / ZZBLAND) for profiles that require them. */
  country?: string;
  state?: string;
}

export interface CodeText {
  code: string;
  text: string;
}

export interface CalendarDay {
  date: string; // ISO
  status: string; // YACTION (open) | PER_CLOSED | …
  targetHours: number;
  workingDay: boolean;
  closed: boolean;
}

export interface TimeEntry {
  counter: string;
  date: string; // ISO
  hours: number;
  /** Status id: MSAVE (saved, not released) | DONE (approved) | REJECTED | PER_CLOSED (period closed) | Planned … */
  status: string;
  /** Status text from SAP, e.g. "Approved". */
  statusText: string;
  released: boolean;
  attendanceType?: CodeText;
  order?: CodeText;
  salesOrder?: CodeText;
  salesOrderItem?: CodeText;
  shortText?: string;
  text?: string;
  notes?: string;
  rejectionReason?: string;
  /** Human-readable one-liner. */
  label: string;
  /** The entry as an EntryItem (for re-use / update). */
  item: EntryItem;
}

export interface OpenDay extends CalendarDay {
  bookedHours: number;
  missingHours: number;
  entries: TimeEntry[];
}

export interface DaySummary extends OpenDay {
  /** booked >= target */
  filled: boolean;
}

export interface JobcodeStat {
  key: string;
  label: string;
  item: EntryItem;
  days: number;
  hours: number;
  /** Percentage of the booked hours in the range. */
  share: number;
  dates: string[];
}

export interface SetResult {
  removed: { ok: boolean; counter: string; date: string; error?: string }[];
  created: SubmitResult[];
}

export interface StaffingApplyResult {
  created: SubmitResult[];
  skipped: { date: string; reason: string }[];
}

export interface StaffingPlan {
  toBook: { date: string; hours: number; item: EntryItem; label: string; shortText?: string }[];
  skipped: { date: string; reason: string }[];
}

export interface SetPlan {
  toRemove: TimeEntry[];
  toCreate: { date: string; hours: number }[];
}

export interface FillOpenResult extends SubmitResult {
  hours: number;
}

export interface Favorite {
  id: string;
  name: string;
  /** F = favorite, FW = favorite from worklist */
  type: string;
  hours?: number;
  item: EntryItem;
  description: string;
}

export interface ValueHelpItem extends CodeText {
  client?: string;
  partner?: string;
  manager?: string;
  description?: string;
  costCenter?: string;
}

export interface WorklistItem {
  recordNumber: number;
  label: string;
  item: EntryItem;
}

export interface SubmitResult {
  ok: boolean;
  date?: string;
  counter?: string;
  status?: string;
  error?: string;
}

/** Strip leading zeros from numeric SAP keys (keeps alphanumeric ones like E90099010006). */
export const stripZeros = (v: string | undefined): string => {
  if (!v) return "";
  const t = v.trim();
  return /^\d+$/.test(t) ? String(Number(t)) : t;
};

export class TimesheetError extends Error {
  override readonly name = "TimesheetError";
}

export function validateItem(item: EntryItem): void {
  if (!item.attendanceType && !item.order && !item.salesOrder) {
    throw new TimesheetError("An entry needs an attendance type or an order (order / salesOrder + salesOrderItem).");
  }
  if (item.salesOrder && !item.salesOrderItem) {
    throw new TimesheetError("A sales order needs a salesOrderItem (use salesOrderItems(<order>) to find it).");
  }
}

export function itemLabel(parts: { attendanceType?: CodeText; order?: CodeText; salesOrder?: CodeText; salesOrderItem?: CodeText; shortText?: string }): string {
  const bits: string[] = [];
  const ct = (c?: CodeText) => (c ? (c.text && c.text !== c.code ? `${c.text} (${c.code})` : c.code) : "");
  if (parts.salesOrder) bits.push(ct(parts.salesOrder) + (parts.salesOrderItem ? ` / ${ct(parts.salesOrderItem)}` : ""));
  if (parts.order) bits.push(ct(parts.order));
  if (parts.attendanceType) bits.push(ct(parts.attendanceType));
  if (parts.shortText) bits.push(`"${parts.shortText}"`);
  return bits.join(" · ");
}
