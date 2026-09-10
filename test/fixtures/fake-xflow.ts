/**
 * In-memory imitation of the xflow SAP Gateway services used by the two Fiori
 * timesheet apps. Shapes and field names mirror traffic recorded from the real
 * system (see docs/api-notes.md):
 *
 *   /sap/bc/ui2/start_up                                  user info
 *   /sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/            Standard timesheet
 *   /sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_V2_SRV_01/      Multiproject timesheet
 *   /sap/opu/odata/sap/ZB_LOCK_SRV/                       CatsLock / CatsRelock / CatsUnlock
 */
import http from "node:http";
import { AddressInfo } from "node:net";

export const PERNR = "08765432";
const STD = "/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/";
const MP = "/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_V2_SRV_01/";
const LOCK = "/sap/opu/odata/sap/ZB_LOCK_SRV/";

export interface StoredEntry {
  counter: string;
  workdate: string; // yyyymmdd
  hours: number;
  status: string; // MSAVE (saved, not released) | RELEASED | APPROVED | PER_CLOSED
  fields: Record<string, string>; // AWART, RAUFNR, RKDAUF, RKDPOS, LTXA1, ZZTEXT, LONGTEXT_DATA
}

export interface StoredFavorite {
  ID: string;
  Name: string;
  ObjType: string;
  Field_Text: string;
  FavoriteDataFields: Record<string, string | number>;
}

export interface FakeXflow {
  baseUrl: string;
  launchpadUrl: string;
  state: {
    entries: StoredEntry[];
    /** Planned entries from MDS staffing (ZPlanDataList), same shape as entries but status Planned. */
    staffing: StoredEntry[];
    favorites: StoredFavorite[];
    closedMonths: Set<string>; // "2026-08"
    lock: { held: boolean; relocks: number; unlocks: number };
    csrf: string;
    /** When set, ValueHelpList rejects a `FieldId eq …` filter (models a Gateway where FieldId is not filterable). */
    rejectFieldIdFilter: boolean;
    /** When > 0, ValueHelpList returns at most this many rows per response, ignoring a larger `$top` (server-side page cap). */
    valueHelpPageCap: number;
  };
  requests: { method: string; path: string; body: string; headers: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

const VALUE_HELP: Record<string, { FieldId: string; FieldValue: string; extra?: Record<string, string> }[]> = {
  AWART: [
    { FieldId: "0010", FieldValue: "Holiday (full day)" },
    { FieldId: "0015", FieldValue: "Holiday (half day)" },
    { FieldId: "0077", FieldValue: "Administration" },
    { FieldId: "0081", FieldValue: "NCH-Order BAP" },
    { FieldId: "0800", FieldValue: "Chargeable Hours" },
    { FieldId: "F035", FieldValue: "RTT (full day)" },
  ],
  RKDAUF: [
    { FieldId: "3136787", FieldValue: "Acme Portal - User Data Study", extra: { Client: "ACME MEDIA GROUP", PartnerName: "MOORE", ManagerName: "HAYES" } },
    { FieldId: "3141993", FieldValue: "Globex Coupa Invoicing & RPMA", extra: { Client: "GLOBEX PHARMA", PartnerName: "REYES", ManagerName: "PRICE" } },
    { FieldId: "3150744", FieldValue: "DF_Fleet-System", extra: { Client: "NTA", PartnerName: "REYES", ManagerName: "PRICE" } },
    // Only resolvable by exact code: its number appears nowhere in the description text, and it has exactly one item.
    { FieldId: "2150634", FieldValue: "Pega-Migration BImA", extra: { Client: "BUND", PartnerName: "REYES", ManagerName: "PRICE" } },
  ],
  RKDPOS: [
    { FieldId: "000401", FieldValue: "Trip costs", extra: { FieldRelated: "RKDAUF = 3136787" } },
    { FieldId: "000112", FieldValue: "Consulting", extra: { FieldRelated: "RKDAUF = 3136787" } },
    { FieldId: "000401", FieldValue: "Trip costs", extra: { FieldRelated: "RKDAUF = 3141993" } },
    { FieldId: "000112", FieldValue: "Consulting", extra: { FieldRelated: "RKDAUF = 2150634" } },
  ],
  RAUFNR: [
    { FieldId: "900140", FieldValue: "AI Incubator - NovaLabs", extra: { CostCenterResp: "90600899" } },
    { FieldId: "900004", FieldValue: "Ops Support", extra: { CostCenterResp: "90600899" } },
    { FieldId: "E90099010006", FieldValue: "Core Training Program FR", extra: { CostCenterResp: "90007010" } },
  ],
};

const TEXT_FOR: Record<string, string> = Object.fromEntries(
  Object.values(VALUE_HELP)
    .flat()
    .map((v) => [v.FieldId, v.FieldValue]),
);

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const isWeekend = (yyyymmdd: string) => {
  const d = new Date(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)));
  return d.getDay() === 0 || d.getDay() === 6;
};
const daysBetween = (start: string, end: string): string[] => {
  const out: string[] = [];
  const d = new Date(Number(start.slice(0, 4)), Number(start.slice(4, 6)) - 1, Number(start.slice(6, 8)));
  const e = new Date(Number(end.slice(0, 4)), Number(end.slice(4, 6)) - 1, Number(end.slice(6, 8)));
  while (d <= e) {
    out.push(`${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
};
const monthKey = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}`;

function parseFilter(q: URLSearchParams): Record<string, string> & { substring?: string; fieldIds?: string[] } {
  const f = q.get("$filter") ?? "";
  const out: Record<string, string> = {};
  for (const m of f.matchAll(/(\w+) eq '((?:[^']|'')*)'/g)) out[m[1]] = m[2].replace(/''/g, "'");
  const s = /substringof\('([^']*)'\s*,\s*FieldValue\)/.exec(f);
  if (s) out.substring = s[1];
  const ids = [...f.matchAll(/FieldId eq '([^']*)'/g)].map((m) => m[1]);
  return ids.length ? { ...out, fieldIds: ids } : out;
}

/** Leading-zero-insensitive form of a numeric SAP key ("0003136787" -> "3136787"); non-numeric keys unchanged. */
const bareCode = (s: string) => (/^\d+$/.test(s) ? String(Number(s)) : s);

export async function startFakeXflow(seed: Partial<FakeXflow["state"]> = {}): Promise<FakeXflow> {
  let nextCounter = 54598700;
  const state: FakeXflow["state"] = {
    entries: seed.entries ?? [
      { counter: "000054598661", workdate: "20260803", hours: 8, status: "PER_CLOSED", fields: { RAUFNR: "000000900140", AWART: "0081", ZZTEXT: "AI Incubator - NovaLabs" } },
      { counter: "000054598671", workdate: "20260810", hours: 8, status: "PER_CLOSED", fields: { AWART: "0010", ZZTEXT: "Holiday (full day)" } },
      { counter: "000054598801", workdate: "20260901", hours: 8, status: "MSAVE", fields: { RKDAUF: "0003136787", RKDPOS: "000401", AWART: "0800", ZZTEXT: "Acme Portal - User Data Study" } },
      { counter: "000054598802", workdate: "20260902", hours: 4, status: "RELEASED", fields: { RAUFNR: "000000900140", AWART: "0081", ZZTEXT: "AI Incubator - NovaLabs" } },
    ],
    staffing:
      seed.staffing ??
      ["20260901", "20260902", "20260903", "20260904", "20260907", "20260908", "20260909", "20260910", "20260911"].map((d, i) => ({
        counter: String(10001 + i),
        workdate: d,
        hours: 8,
        status: "Planned",
        fields: { RAUFNR: "000000900140", AWART: "0081", ZZTEXT: "AI Incubator - NovaLabs" },
      })),
    favorites: seed.favorites ?? [
      { ID: "20211220104922.9994940 ", Name: "Acme Portal 2022", ObjType: "FW", Field_Text: "0800(Chargeable Hours), 0003136787(Rec. sales order), 000401(Trip costs)", FavoriteDataFields: { AWART: "0800", RKDAUF: "3136787", RKDPOS: "000401", ZZTEXT: "Acme Portal - User Data Study", CATSHOURS: "0.00" } },
      { ID: "20211220105904.4213750 ", Name: "Holiday", ObjType: "F", Field_Text: "0010(Holiday (full day))", FavoriteDataFields: { AWART: "0010", CATSHOURS: "8.00" } },
      { ID: "20240515153436.4624760 ", Name: "Core Training Program", ObjType: "F", Field_Text: "E90099010006(Core Training Program FR)", FavoriteDataFields: { RAUFNR: "E90099010006", CATSHOURS: "8.00" } },
    ],
    closedMonths: seed.closedMonths ?? new Set(["2026-08", "2026-07"]),
    lock: { held: false, relocks: 0, unlocks: 0 },
    csrf: "CSRF-1",
    rejectFieldIdFilter: seed.rejectFieldIdFilter ?? false,
    valueHelpPageCap: seed.valueHelpPageCap ?? 0,
  };
  const requests: FakeXflow["requests"] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      requests.push({ method: req.method!, path: url.pathname + url.search, body, headers: req.headers });
      const json = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...extra });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      const odataError = (status: number, message: string, code = "ZHCM/001") =>
        json(status, { error: { code, message: { lang: "en", value: message }, innererror: { errordetails: [{ code, message, severity: "error" }] } } });
      const results = (rows: unknown[]) => json(200, { d: { results: rows } });

      if (!/SAP_SESSIONID_SGW_006=ok/.test(req.headers.cookie ?? "")) {
        res.writeHead(302, { location: "https://login.microsoftonline.com/common/oauth2/authorize?client_id=x" });
        return res.end();
      }
      const csrfHeader = req.headers["x-csrf-token"];
      const tokenHeaders: Record<string, string> = typeof csrfHeader === "string" && csrfHeader.toLowerCase() === "fetch" ? { "x-csrf-token": state.csrf } : {};
      if (req.method !== "GET" && req.method !== "HEAD" && csrfHeader !== state.csrf) {
        res.writeHead(403, { "x-csrf-token": "Required" });
        return res.end("CSRF token validation failed");
      }

      if (url.pathname === "/sap/bc/ui2/start_up") return json(200, { id: "8765432", fullName: "Jane Doe", client: "006", language: "EN" });

      // ---------------- Standard timesheet ----------------
      if (url.pathname.startsWith(STD)) {
        const entity = url.pathname.slice(STD.length);
        const f = parseFilter(url.searchParams);
        if (entity === "" || entity === "$metadata") return json(200, { d: { EntitySets: ["TimeEntries", "Favorites"] } }, tokenHeaders);
        if (entity === "ConcurrentEmploymentSet") return results([{ Pernr: PERNR, AssignmentText: "" }]);
        if (entity === "InitialInfos")
          return results([{ Pernr: PERNR, EmployeeName: "Jane Doe", AllowNonWorkingDays: "1", ClockEntry: "FALSE", StartDate: "20260501", EndDate: "20260909", ReleaseDirectly: "TRUE", ReleaseFuture: "TRUE", FavoriteAvailable: true, ProfileID: "MA-FACHL", WithTargetHours: true, Country: "FR", CompanyCode: "0810" }]);
        if (entity === "ProfileFields")
          return results(
            [["RKDAUF", "Rec. sales order", "false"], ["RKDPOS", "RecSalesOrd. item", "false"], ["RAUFNR", "Receiver order", "false"], ["AWART", "Att./Absence type", "false"], ["LTXA1", "Short Text", "false"], ["ZZTEXT", "Text", "true"]].map(([FieldName, FieldText, ReadOnly]) => ({ Pernr: "00000000", ProfileId: "MA-FACHL", FieldName, FieldText, ReadOnly })),
          );
        if (entity === "WorkCalendars") {
          if (!f.StartDate || !f.EndDate) return odataError(500, "Internal error occurred, contact your system administrator.", "/IWBEP/CM_MGW_RT/032");
          return results(
            daysBetween(f.StartDate, f.EndDate).map((Date) => ({
              Pernr: "00000000",
              Date,
              Status: state.closedMonths.has(monthKey(Date)) ? "PER_CLOSED" : "YACTION",
              TargetHours: isWeekend(Date) ? "0.00" : "8.00",
              WorkingDay: isWeekend(Date) ? "FALSE" : "TRUE",
              EndDate: "",
              StartDate: "",
              FirstDayOfWeek: "MONDAY",
            })),
          );
        }
        if (entity === "TimeDataList" || entity === "ZPlanDataList") {
          if (!f.StartDate || !f.EndDate) return odataError(500, "Internal error occurred, contact your system administrator.", "/IWBEP/CM_MGW_RT/032");
          const rows: unknown[] = [];
          const source = entity === "ZPlanDataList" ? state.staffing : state.entries;
          const inRange = source.filter((e) => e.workdate >= f.StartDate && e.workdate <= f.EndDate).sort((a, b) => a.workdate.localeCompare(b.workdate));
          for (const e of inRange) {
            const row = (FieldName: string, FieldValue: string, FieldValueText = "", Level = 0, FieldText = "") => rows.push({ Pernr: PERNR, RecordNumber: "1 ", FieldName, FieldText, FieldValue, FieldValueText, Level, StartDate: "", EndDate: "" });
            row("WORKDATE", e.workdate);
            row("MEINH", "H", "", 99);
            if (e.fields.RKDAUF) row("RKDAUF", e.fields.RKDAUF, TEXT_FOR[e.fields.RKDAUF.replace(/^0+/, "")] ?? "", 0, "Rec. sales order");
            if (e.fields.RKDPOS) row("RKDPOS", e.fields.RKDPOS, TEXT_FOR[e.fields.RKDPOS] ?? "", 2, "RecSalesOrd. item");
            if (e.fields.RAUFNR) row("RAUFNR", e.fields.RAUFNR, TEXT_FOR[e.fields.RAUFNR.replace(/^0+/, "")] ?? "", 0, "Receiver order");
            if (e.fields.AWART) row("AWART", e.fields.AWART, TEXT_FOR[e.fields.AWART] ?? "", e.fields.RAUFNR || e.fields.RKDAUF ? 7 : 0, "Att./Absence type");
            if (e.fields.LTXA1) row("LTXA1", e.fields.LTXA1, e.fields.LTXA1, 8, "Short Text");
            row("ZZTEXT", e.fields.ZZTEXT ?? "", e.fields.ZZTEXT ?? "", 99, "Text");
            row("TIME", e.hours.toFixed(3), "Hour");
            row("NOTES", "", e.fields.LONGTEXT_DATA ?? "");
            row("STARTTIME", "000000", "000000");
            row("ENDTIME", "000000", "000000");
            row("COUNTER", e.counter, e.counter);
            row("REASON", "", "");
            row("STATUS", e.status, { MSAVE: "Saved", DONE: "Approved", RELEASED: "Released", PER_CLOSED: "PER_CLOSED" }[e.status] ?? e.status);
          }
          return results(rows);
        }
        if (entity === "WorkListCollection") {
          if (!f.StartDate || !f.EndDate) return odataError(500, "Internal error occurred, contact your system administrator.", "/IWBEP/CM_MGW_RT/032");
          return results([
            { Pernr: PERNR, DataEntryProfileId: "MA-FACHL", FieldName: "RKDAUF", FieldText: "Rec. sales order", FieldValue: "0003136787", FieldValueText: "Acme Portal - User Data Study", RecordNumber: 1, StartDate: "", EndDate: "", Level: 0 },
            { Pernr: PERNR, DataEntryProfileId: "MA-FACHL", FieldName: "RKDPOS", FieldText: "RecSalesOrd. item", FieldValue: "000401", FieldValueText: "Trip costs", RecordNumber: 1, StartDate: "", EndDate: "", Level: 1 },
            { Pernr: PERNR, DataEntryProfileId: "MA-FACHL", FieldName: "RAUFNR", FieldText: "Receiver order", FieldValue: "000000900140", FieldValueText: "AI Incubator - NovaLabs", RecordNumber: 2, StartDate: "", EndDate: "", Level: 0 },
          ]);
        }
        if (entity === "ValueHelpList") {
          if (!f.Pernr || !f.FieldName) return odataError(500, "Internal error occurred, contact your system administrator.", "/IWBEP/CM_MGW_RT/032");
          if (f.fieldIds && state.rejectFieldIdFilter) return odataError(400, "Property 'FieldId' is not filterable in $filter.", "/IWBEP/CM_MGW_RT/021");
          let rows = VALUE_HELP[f.FieldName] ?? [];
          if (f.FieldRelated) {
            const norm = (s: string) => s.replace(/\s+/g, "").replace(/^(\w+)=0*/, "$1=");
            rows = rows.filter((r) => norm(r.extra?.FieldRelated ?? "") === norm(f.FieldRelated));
          }
          // Text search (case-sensitive, as the real system) OR'd with an exact FieldId lookup (leading-zero-insensitive).
          if (f.substring !== undefined || f.fieldIds) {
            const ids = (f.fieldIds ?? []).map(bareCode);
            rows = rows.filter((r) => (f.substring !== undefined && r.FieldValue.includes(f.substring)) || ids.includes(bareCode(r.FieldId)));
          }
          const top = Number(url.searchParams.get("$top") ?? rows.length);
          const skip = Number(url.searchParams.get("$skip") ?? 0);
          let page = rows.slice(skip, skip + top);
          if (state.valueHelpPageCap > 0) page = page.slice(0, state.valueHelpPageCap); // Gateway caps the page below $top
          return results(
            page.map((r) => ({ Pernr: PERNR, FieldId: r.FieldId, FieldName: f.FieldName, FieldValue: r.FieldValue, FieldRelated: "", StartDate: f.StartDate ?? "", EndDate: f.EndDate ?? "", PartnerName: "", ManagerName: "", Client: "", Description: r.FieldValue, CostCenterResp: "", LocalOffice: "", ...(r.extra ?? {}) })),
          );
        }
        if (entity === "Favorites" && req.method === "GET") return results(state.favorites.map((fv) => ({ ...fv, Pernr: PERNR, Field_Id: "", Field_Value: "", FavoriteOperation: "" })));
        if (entity === "Favorites" && req.method === "POST") {
          const b = JSON.parse(body) as { Name?: string; FavoriteDataFields?: Record<string, string> };
          if (!b.Name) return odataError(400, "Favorite name is required");
          const fields = b.FavoriteDataFields ?? {};
          const fav: StoredFavorite = {
            ID: `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.${pad(state.favorites.length, 7)} `,
            Name: b.Name,
            ObjType: "F",
            Field_Text: Object.entries(fields).filter(([k]) => k !== "CATSHOURS").map(([k, v]) => `${v}(${TEXT_FOR[v] ?? k})`).join(", "),
            FavoriteDataFields: fields,
          };
          state.favorites.push(fav);
          return json(201, { d: { ...fav, Pernr: PERNR } });
        }
        const favKey = /^Favorites\(ID='([^']*)',Pernr='([^']*)'\)$/.exec(decodeURIComponent(entity));
        if (favKey && req.method === "DELETE") {
          const before = state.favorites.length;
          state.favorites = state.favorites.filter((fv) => fv.ID.trim() !== favKey[1].trim());
          if (state.favorites.length === before) return odataError(404, "Favorite not found");
          res.writeHead(204);
          return res.end();
        }
        if (entity === "$batch" && req.method === "POST") return handleBatch(body, req.headers["content-type"] ?? "");
        if (entity === "TimeEntries" && req.method === "POST") {
          const r = applyTimeEntry(JSON.parse(body));
          return r.ok ? json(201, { d: r.entity }) : odataError(400, r.error!);
        }
        return json(404, { error: { code: "404", message: { lang: "en", value: `Resource not found for segment '${entity}'` } } });
      }

      // ---------------- Multiproject timesheet ----------------
      if (url.pathname.startsWith(MP)) {
        const entity = url.pathname.slice(MP.length);
        const f = parseFilter(url.searchParams);
        if (entity === "" || entity === "$metadata") return json(200, { d: {} }, tokenHeaders);
        if (entity === "InitialInfos") return results([{ Pernr: PERNR, AllowNonWorkingDays: "1", Clockentry: "MONDAY", StartDate: "20260501", EndDate: "20260909", FavoriteAvailable: true, ProfileID: "MA-FACHL", Country: "FR", CompanyCode: "0810" }]);
        if (entity === "ConcurrentEmploymentSet") return results([{ Pernr: PERNR, AssignmentText: "" }]);
        if (entity === "GetMasterListSet" || entity === "GetMasterListSet/$count") {
          const months = ["2026-09", "2026-08", "2026-07", "2026-06"];
          if (entity.endsWith("$count")) {
            res.writeHead(200, { "content-type": "text/plain" });
            return res.end(String(months.length));
          }
          return results(
            months.map((m) => {
              const [y, mo] = m.split("-");
              const total = state.entries.filter((e) => monthKey(e.workdate) === m).reduce((a, e) => a + e.hours, 0);
              const target = daysBetween(`${y}${mo}01`, `${y}${mo}${pad(new Date(Number(y), Number(mo), 0).getDate(), 2)}`).filter((d) => !isWeekend(d)).length * 8;
              return { Perio: String(Number(mo)), Gjahr: y, MissingHours: `${Math.max(0, target - total).toFixed(2)} `, ChargeableHours: "0.00 ", Status: state.closedMonths.has(m) ? "PER_CLOSED" : "YACTION", Unit: "Total Hours", TotalHours: total.toFixed(2) };
            }),
          );
        }
        if (entity === "WorkCalendars") {
          if (!f.StartDate || !f.EndDate) return odataError(500, "Internal error occurred, contact your system administrator.", "/IWBEP/CM_MGW_RT/032");
          return results(daysBetween(f.StartDate, f.EndDate).map((Date) => ({ Pernr: PERNR, Date, Status: state.closedMonths.has(monthKey(Date)) ? "PER_CLOSED" : "YACTION", TargetHours: isWeekend(Date) ? "0.00" : "8.00", WorkingDay: isWeekend(Date) ? "TRUE" : "TRUE", EndDate: f.EndDate, StartDate: f.StartDate })));
        }
        if (entity === "GetTimeDataSet") {
          if (!f.Gjahr || !f.Perio) return odataError(500, "Internal error occurred, contact your system administrator.", "/IWBEP/CM_MGW_RT/032");
          const y = f.Gjahr;
          const mo = pad(Number(f.Perio), 2);
          const start = `${y}${mo}01`;
          const end = `${y}${mo}${pad(new Date(Number(y), Number(mo), 0).getDate(), 2)}`;
          const monthEntries = state.entries.filter((e) => e.workdate >= start && e.workdate <= end);
          // one column per distinct (RAUFNR, AWART, RKDAUF, RKDPOS)
          const colKey = (e: StoredEntry) => [e.fields.RAUFNR ?? "", e.fields.AWART ?? "", e.fields.RKDAUF ?? "", e.fields.RKDPOS ?? ""].join("|");
          const keys = [...new Set(monthEntries.map(colKey))];
          const columns = keys.map((k, i) => {
            const e = monthEntries.find((x) => colKey(x) === k)!;
            return { COLNAME: `PROJECT${i + 1}`, COLINFO: { RAUFNR: e.fields.RAUFNR ?? "", AWART: e.fields.AWART ?? "", RKDAUF: e.fields.RKDAUF ?? "", RKDPOS: e.fields.RKDPOS ? pad(Number(e.fields.RKDPOS), 6) : "000000", ZZTEXT: e.fields.ZZTEXT ?? "", ZZLAND: "", ZZBLAND: "" } };
          });
          const rows = daysBetween(start, end).map((d) => {
            const row: Record<string, unknown> = { DATE: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` };
            let total = 0;
            columns.forEach((c, i) => {
              const e = monthEntries.find((x) => x.workdate === d && colKey(x) === keys[i]);
              row[c.COLNAME] = e ? { HOURS: e.hours.toFixed(2), COUNTER: e.counter, TEXT: e.fields.LTXA1 ?? "", LONGTEXT: e.fields.LONGTEXT_DATA ?? "" } : { HOURS: "", COUNTER: "", TEXT: "", LONGTEXT: "" };
              total += e?.hours ?? 0;
            });
            row.TOTAL_HOURS = total ? String(total) : "0";
            return row;
          });
          return results([{ Gjahr: y, Perio: `${Number(f.Perio)} `, ColumnData: JSON.stringify({ DATA: columns }), RowData: JSON.stringify({ DATA: rows }), TotalHours: `${monthEntries.reduce((a, e) => a + e.hours, 0)} ` }]);
        }
        if (entity === "Favorites" && req.method === "GET") return results(state.favorites.map((fv) => ({ ...fv, Pernr: PERNR, Field_Id: "", Field_Value: "", FavoriteOperation: "" })));
        if (entity === "ValueHelpList") {
          const rows = VALUE_HELP[f.FieldName ?? ""] ?? [];
          return results(rows.map((r) => ({ Pernr: PERNR, FieldId: r.FieldId, FieldName: f.FieldName, FieldValue: r.FieldValue, FieldRelated: "", StartDate: "", EndDate: "", ...(r.extra ?? {}) })));
        }
        if (entity === "UpdateTimeDataSet" && req.method === "POST") {
          if (!state.lock.held) return odataError(400, "Timesheet is not locked by this user");
          const b = JSON.parse(body) as { ColumnData: string; RowData: string };
          const columns = JSON.parse(b.ColumnData) as { COLNAME: string; COLINFO: Record<string, string> }[];
          const rows = JSON.parse(b.RowData) as Record<string, unknown>[];
          for (const row of rows) {
            const date = String(row.DATE).replace(/-/g, "");
            if (state.closedMonths.has(monthKey(date))) return odataError(400, `Period ${monthKey(date)} is closed`);
            for (const col of columns) {
              const cell = row[col.COLNAME] as { HOURS?: string; COUNTER?: string; TEXT?: string; LONGTEXT?: string } | undefined;
              if (!cell) continue;
              const hours = Number(cell.HOURS || 0);
              const existing = cell.COUNTER ? state.entries.find((e) => e.counter === cell.COUNTER) : undefined;
              if (existing) {
                if (hours === 0) state.entries = state.entries.filter((e) => e !== existing);
                else {
                  existing.hours = hours;
                  existing.fields.LTXA1 = cell.TEXT ?? "";
                }
              } else if (hours > 0) {
                if (!col.COLINFO.AWART && !col.COLINFO.RAUFNR && !col.COLINFO.RKDAUF) return odataError(400, "Column has no order or attendance type");
                if (col.COLINFO.AWART && !VALUE_HELP.AWART.some((a) => a.FieldId === col.COLINFO.AWART)) return odataError(400, `Unknown attendance type ${col.COLINFO.AWART}`);
                state.entries.push({
                  counter: pad(nextCounter++, 12),
                  workdate: date,
                  hours,
                  status: "RELEASED",
                  fields: {
                    ...(col.COLINFO.RAUFNR ? { RAUFNR: pad(Number(col.COLINFO.RAUFNR) || 0, 12) } : {}),
                    ...(col.COLINFO.AWART ? { AWART: col.COLINFO.AWART } : {}),
                    ...(col.COLINFO.RKDAUF ? { RKDAUF: pad(Number(col.COLINFO.RKDAUF), 10) } : {}),
                    ...(col.COLINFO.RKDPOS && col.COLINFO.RKDPOS !== "000000" ? { RKDPOS: pad(Number(col.COLINFO.RKDPOS), 6) } : {}),
                    ZZTEXT: TEXT_FOR[String(Number(col.COLINFO.RAUFNR) || col.COLINFO.RKDAUF || col.COLINFO.AWART)] ?? "",
                    ...(cell.TEXT ? { LTXA1: cell.TEXT } : {}),
                  },
                });
              }
            }
          }
          return json(201, { d: { ColumnData: b.ColumnData, RowData: b.RowData } });
        }
        if (entity === "$batch" && req.method === "POST") return handleBatch(body, req.headers["content-type"] ?? "");
        return json(404, { error: { code: "404", message: { lang: "en", value: `Resource not found for segment '${entity}'` } } });
      }

      // ---------------- Lock service ----------------
      if (url.pathname.startsWith(LOCK)) {
        const entity = url.pathname.slice(LOCK.length);
        if (entity === "" || entity === "$metadata") return json(200, { d: {} }, tokenHeaders);
        if (entity === "CatsLock") {
          if (state.lock.held) return json(200, { d: { LockObject: "" } });
          state.lock.held = true;
          return json(200, { d: { LockObject: "X" } });
        }
        if (entity === "CatsRelock") {
          state.lock.relocks++;
          return json(200, { d: { LockObject: "X" } });
        }
        if (entity === "CatsUnlock") {
          state.lock.held = false;
          state.lock.unlocks++;
          return json(200, { d: { LockObject: "" } });
        }
      }
      json(404, { error: { code: "404", message: { lang: "en", value: "not found" } } });

      /** Apply one TimeEntries POST (C/U/D). Mirrors backend validation loosely. */
      function applyTimeEntry(b: { Counter?: string; TimeEntryOperation?: string; TimeEntryRelease?: string; TimeEntryDataFields?: Record<string, string> }): { ok: boolean; entity?: unknown; error?: string } {
        const op = b.TimeEntryOperation;
        const df = b.TimeEntryDataFields ?? {};
        const workdate = (df.WORKDATE ?? "").replace(/-/g, "").slice(0, 8);
        if (!/^\d{8}$/.test(workdate)) return { ok: false, error: `Invalid WORKDATE "${df.WORKDATE}"` };
        if (state.closedMonths.has(monthKey(workdate))) return { ok: false, error: `Period ${monthKey(workdate)} is closed for time recording` };
        if (op === "D") {
          const before = state.entries.length;
          state.entries = state.entries.filter((e) => e.counter !== b.Counter);
          if (state.entries.length === before) return { ok: false, error: `Entry ${b.Counter} not found` };
          return { ok: true, entity: { Counter: b.Counter, TimeEntryOperation: "D", Status: "" } };
        }
        const hours = Number(df.CATSAMOUNT ?? df.CATSHOURS ?? 0);
        if (!(hours > 0)) return { ok: false, error: "Hours must be greater than zero" };
        if (!df.AWART && !df.RAUFNR && !df.RKDAUF) return { ok: false, error: "Enter an attendance/absence type or an order" };
        if (df.RKDAUF && !df.RKDPOS) return { ok: false, error: "Sales order item (RKDPOS) is required with a sales order" };
        const fields: Record<string, string> = {};
        for (const k of ["AWART", "RAUFNR", "RKDAUF", "RKDPOS", "LTXA1", "ZZTEXT", "LONGTEXT_DATA"]) if (df[k]) fields[k] = df[k];
        if (fields.RAUFNR) fields.RAUFNR = pad(Number(fields.RAUFNR) || 0, 12) === "000000000000" ? fields.RAUFNR : pad(Number(fields.RAUFNR), 12);
        if (fields.RKDAUF) fields.RKDAUF = pad(Number(fields.RKDAUF), 10);
        fields.ZZTEXT ??= TEXT_FOR[String(Number(fields.RAUFNR) || Number(fields.RKDAUF) || fields.AWART)] ?? "";
        const status = b.TimeEntryRelease === "X" ? "RELEASED" : "MSAVE";
        if (op === "U") {
          const e = state.entries.find((x) => x.counter === b.Counter);
          if (!e) return { ok: false, error: `Entry ${b.Counter} not found` };
          e.hours = hours;
          e.fields = fields;
          e.status = status;
          return { ok: true, entity: { Counter: e.counter, TimeEntryOperation: "U", Status: status, TimeEntryDataFields: { ...fields, WORKDATE: df.WORKDATE, CATSHOURS: hours.toFixed(2) } } };
        }
        const counter = pad(nextCounter++, 12);
        state.entries.push({ counter, workdate, hours, status, fields });
        return { ok: true, entity: { Counter: counter, TimeEntryOperation: "C", Status: status, TimeEntryDataFields: { ...fields, WORKDATE: df.WORKDATE, CATSHOURS: hours.toFixed(2) } } };
      }

      function handleBatch(batchBody: string, contentType: string) {
        const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
        if (!boundary) return json(400, { error: { message: { value: "missing boundary" } } });
        const responses: string[] = [];
        const rb = "BATCHRESP";
        for (const part of batchBody.split(`--${boundary}`).slice(1)) {
          if (part.startsWith("--")) break;
          const isChangeset = /Content-Type: multipart\/mixed; boundary=([^\r\n]+)/.exec(part);
          const httpParts = isChangeset ? part.split(`--${isChangeset[1]}`).slice(1).filter((p) => !p.startsWith("--")) : [part];
          const inner: string[] = [];
          for (const hp of httpParts) {
            const m = /(GET|POST|PUT|MERGE|DELETE) ([^ ]+) HTTP\/1\.1\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(hp);
            if (!m) continue;
            const [, method, relPath, , rawBody] = m;
            const bodyText = rawBody.trim().replace(/\r?\n?--$/, "").trim();
            let status = 200;
            let payload: unknown;
            if (method === "POST" && relPath.startsWith("TimeEntries")) {
              const r = applyTimeEntry(JSON.parse(bodyText));
              status = r.ok ? 201 : 400;
              payload = r.ok ? { d: r.entity } : { error: { code: "ZHCM/001", message: { lang: "en", value: r.error }, innererror: { errordetails: [{ code: "ZHCM/001", message: r.error, severity: "error" }] } } };
            } else {
              status = 501;
              payload = { error: { message: { value: `fake: unsupported batch op ${method} ${relPath}` } } };
            }
            const text = JSON.stringify(payload);
            inner.push(`Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nHTTP/1.1 ${status} ${status === 201 ? "Created" : status === 200 ? "OK" : "Error"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}\r\n`);
          }
          if (isChangeset) {
            const cb = `CS${responses.length}`;
            responses.push(`--${rb}\r\nContent-Type: multipart/mixed; boundary=${cb}\r\n\r\n${inner.map((i) => `--${cb}\r\n${i}`).join("")}--${cb}--\r\n`);
          } else {
            responses.push(...inner.map((i) => `--${rb}\r\n${i}`));
          }
        }
        res.writeHead(202, { "content-type": `multipart/mixed; boundary=${rb}` });
        res.end(responses.join("") + `--${rb}--\r\n`);
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    launchpadUrl: `${baseUrl}/fiori/shells/abap/FioriLaunchpad.html#Shell-home`,
    state,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export const fakeSession = (baseUrl: string) => ({
  launchpadUrl: `${baseUrl}/fiori/shells/abap/FioriLaunchpad.html#Shell-home`,
  createdAt: new Date().toISOString(),
  cookies: [{ name: "SAP_SESSIONID_SGW_006", value: "ok", domain: "127.0.0.1", path: "/", httpOnly: true }],
});
