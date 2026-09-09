# xflow timesheet OData services — field notes

Everything below was recorded from the real system on 2026-09-09 with
`scripts/record-traffic.ts` and by reading the two UI5 apps' controllers.
Host: `https://fiori.example.com`, SAP client `006`. All dates in OData
filters are `yyyymmdd`; payload dates for entry creation are `YYYY-MM-DDT00:00:00`.

## Launchpad intents

| Tile | Intent | UI5 app | OData service |
| --- | --- | --- | --- |
| Standard Timesheet | `#StandardTimesheet-manage` | `zhcm_tme_man` (`zhcm.mytimesheet`) | `/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/` |
| Multiproject Timesheet | `#MultiprojectTimesheet-manage` | `zhcm_tme_man_v2` (`timesheet2ns`) | `/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_V2_SRV_01/` |
| (lock used by Multiproject) | – | – | `/sap/opu/odata/sap/ZB_LOCK_SRV/` |

`GET /sap/bc/ui2/start_up` returns the user (`id`, `fullName`, `client`, `language`).

## Field codes (CATS)

| Field | Meaning | UI label | Example |
| --- | --- | --- | --- |
| `AWART` | attendance / absence type | Att./Abs. type | `0010` Holiday (full day), `0800` Chargeable Hours, `0081` NCH-Order BAP, `0077` Administration, `F035` RTT |
| `RAUFNR` | receiver (internal) order = **non-chargeable order** | NonCh. order | `900140` AI Incubator - NovaLabs (stored as `000000900140`) |
| `RKDAUF` | receiving sales order = **chargeable order** | Ch. order | `3136787` (stored as `0003136787`) |
| `RKDPOS` | sales order item | Rec. item | `000401` Trip costs (required with `RKDAUF`) |
| `LTXA1` | short text (40 chars) | Short Text | free text |
| `ZZTEXT` | description filled by SAP from the order | Text (read-only) | |
| `ZZLAND` / `ZZBLAND` | country / state, some profiles | | |

Profile `MA-FACHL` (FR, company code 0810) exposes exactly these fields
(`ProfileFields`).

## Standard timesheet (`ZHCM_TIMESHEET_MAN_SRV`)

Read:

- `ConcurrentEmploymentSet` → `Pernr` (`08765432`).
- `InitialInfos?$filter=Pernr eq 'P' and StartDate eq 'D' and EndDate eq 'D'` →
  `ProfileID`, `ReleaseDirectly`, `ReleaseFuture`, `FavoriteAvailable`, `Country`, `CompanyCode`.
- `WorkCalendars?$filter=Pernr eq 'P' and StartDate eq … and EndDate eq …` → one row
  per day: `Status` (`YACTION` open, `PER_CLOSED`), `TargetHours`, `WorkingDay`.
- `TimeDataList?$filter=Pernr eq 'P' and StartDate … EndDate …` → **flat rows**
  (`FieldName`, `FieldValue`, `FieldValueText`, `Level`). A new entry starts at
  each `WORKDATE` row; then `MEINH`, order fields, `AWART`, `ZZTEXT`, `TIME`
  (hours, `8.000`), `NOTES`, `STARTTIME`, `ENDTIME`, `COUNTER` (12 digits),
  `REASON`, `STATUS` (`FieldValue` id / `FieldValueText`): `MSAVE` saved-not-released,
  `DONE` = "Approved" (CATS status 30), `REJECTED`, `PER_CLOSED` period closed,
  `Planned`. Requires all three filter fields, otherwise HTTP 500.
  Verified 2026-09-09: with profile `MA-FACHL` (`ReleaseDirectly = TRUE`) a
  new entry is approved immediately (create response `Status: "30"`, list shows
  `DONE`/Approved) **even when `TimeEntryRelease` is omitted** — the app always
  sends it anyway.
- `WorkListCollection?$filter=Pernr … StartDate … EndDate …` → worklist rows grouped by `RecordNumber` (Level 0 = main).
- `ValueHelpList?$filter=Pernr eq 'P' and FieldName eq 'AWART|RKDAUF|RAUFNR|RKDPOS|ZZLAND' and StartDate … and EndDate … [and substringof('txt', FieldValue)] [and FieldRelated eq 'RKDAUF = 3136787']&$top=&$skip=`
  → `FieldId` (code), `FieldValue` (text), plus `Client`, `PartnerName`, `ManagerName`, `CostCenterResp`.
  The `substringof` search is **case-sensitive** (`Globex` matches, `globex` does not).
- `Favorites?$filter=Pernr eq 'P'` → `ID`, `Name`, `ObjType` (`F`/`FW`), `Field_Text`, `FavoriteDataFields{AWART,RAUFNR,RKDAUF,RKDPOS,CATSHOURS,…}`.

Write (the app first fetches a CSRF token, then sends a `$batch` with **one
changeset per entry**):

```http
POST TimeEntries
{ "Counter": "" | "<12 digits>",           // "" for create
  "TimeEntryOperation": "C" | "U" | "D",
  "TimeEntryRelease": "X",                  // omitted for D; releases directly
  "Line_Count": "<number of entries in the batch>",
  "TimeEntryDataFields": {
    "WORKDATE": "2026-09-03T00:00:00", "CATSAMOUNT": "8", "BEGUZ": "", "ENDUZ": "",
    "RAUFNR": "900140", "AWART": "0081", "LTXA1": "…",
    "LONGTEXT_DATA": "notes", "LONGTEXT": "X" } }
```

Per-entry errors come back as OData error bodies inside the batch part
(`error.message.value`, `error.innererror.errordetails[]`).

Favorites: `POST Favorites {Name, Pernr, FavoriteDataFields{…}}`,
`PUT|DELETE Favorites(ID='…',Pernr='…')`.

## Multiproject timesheet (`ZHCM_TIMESHEET_MAN_V2_SRV_01`)

- `GetMasterListSet` → months: `Gjahr`, `Perio`, `Status`, `TotalHours`, `MissingHours`, `ChargeableHours`.
- `InitialInfos`, `ConcurrentEmploymentSet`, `ProfileFields`, `Favorites`, `ValueHelpList` (no Pernr filter needed).
- `WorkCalendars?$filter=StartDate eq 'yyyymm01' and EndDate eq 'yyyymmdd'`.
- `GetTimeDataSet?$filter=Gjahr eq '2026' and Perio eq '09'` → one row with two JSON strings:
  - `ColumnData`: `{"DATA":[{"COLNAME":"PROJECT1","COLINFO":{"RAUFNR","AWART","RKDAUF","RKDPOS","ZZTEXT","ZZLAND","ZZBLAND"}}]}`
  - `RowData`: `{"DATA":[{"DATE":"2026-08-01","PROJECT1":{"HOURS":"8.00","COUNTER":"0000…","TEXT":"","LONGTEXT":""},"TOTAL_HOURS":"8"}]}`
- Save = `POST UpdateTimeDataSet {ColumnData, RowData}` where both are JSON
  **strings of bare arrays** (no `DATA` wrapper — that is what the app sends):
  the PROJECT columns (`ZZTEXT` blanked) and the day rows. Empty `HOURS` on a
  cell with a `COUNTER` deletes that entry; a new column is `PROJECT<n+1>`.
- Locking (`ZB_LOCK_SRV`): `GET CatsLock` → `LockObject: "X"` when acquired
  (anything else = locked elsewhere); `GET CatsRelock` every 60 s while editing;
  `GET CatsUnlock` when done. The app locks before enabling edit mode and
  unlocks after saving.
