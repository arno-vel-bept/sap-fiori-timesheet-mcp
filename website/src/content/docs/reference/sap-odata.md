---
title: SAP OData services
description: The recorded protocol of the two timesheet apps, entity sets, filters, the $batch write format and the lock service.
sidebar:
  order: 6
---

<span class="doc-kind">Reference</span>

Field notes recorded from the BearingPoint system on 2026-09-09 with `scripts/record-traffic.ts` and by reading the two UI5 apps' controllers. Host `https://xflow.bearingpoint.com`, SAP client `006`. Dates in OData filters are `yyyymmdd`; payload dates for entry creation are `YYYY-MM-DDT00:00:00`. This page is for people who want to understand or extend the tool; nothing here is needed to use it.

## Launchpad intents

| Tile | Intent | UI5 app | OData service |
| --- | --- | --- | --- |
| Standard Timesheet | `#StandardTimesheet-manage` | `zhcm_tme_man` (`zhcm.mytimesheet`) | `/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/` |
| Multiproject Timesheet | `#MultiprojectTimesheet-manage` | `zhcm_tme_man_v2` (`timesheet2ns`) | `/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_V2_SRV_01/` |
| (lock used by Multiproject) | | | `/sap/opu/odata/sap/ZB_LOCK_SRV/` |

`GET /sap/bc/ui2/start_up` returns the user (`id`, `fullName`, `client`, `language`). It authenticates off the SSO ticket alone, so the tool does **not** use it to decide whether a session is alive; it probes the Standard timesheet service root instead.

## Standard timesheet (`ZHCM_TIMESHEET_MAN_SRV`)

### Read

- `ConcurrentEmploymentSet` → `Pernr`.
- `InitialInfos?$filter=Pernr eq 'P' and StartDate eq 'D' and EndDate eq 'D'` → `ProfileID`, `ReleaseDirectly`, `ReleaseFuture`, `FavoriteAvailable`, `Country`, `CompanyCode`.
- `WorkCalendars?$filter=Pernr … StartDate … EndDate …` → one row per day: `Status` (`YACTION` open, `PER_CLOSED`), `TargetHours`, `WorkingDay`.
- `TimeDataList?$filter=Pernr … StartDate … EndDate …` → **flat rows** (`FieldName`, `FieldValue`, `FieldValueText`, `Level`). A new entry starts at each `WORKDATE` row, followed by `MEINH`, the order fields, `AWART`, `ZZTEXT`, `TIME` (hours, `8.000`), `NOTES`, `STARTTIME`, `ENDTIME`, `COUNTER` (12 digits), `REASON`, `STATUS` (`MSAVE`, `DONE` = Approved / CATS 30, `REJECTED`, `PER_CLOSED`, `Planned`). All three filter fields are required, otherwise HTTP 500. On profile `MA-FACHL` (`ReleaseDirectly = TRUE`) a new entry is approved immediately even when `TimeEntryRelease` is omitted.
- `WorkListCollection?$filter=…` → worklist rows grouped by `RecordNumber` (Level 0 = main).
- `ValueHelpList?$filter=Pernr eq 'P' and FieldName eq 'AWART|RKDAUF|RAUFNR|RKDPOS|ZZLAND' and StartDate … and EndDate … [and substringof('txt', FieldValue)] [and FieldRelated eq 'RKDAUF = 3136787']&$top=&$skip=` → `FieldId` (code), `FieldValue` (text), plus `Client`, `PartnerName`, `ManagerName`, `CostCenterResp`. The `substringof` search is case-sensitive and matches the text only.
  - For a code-shaped query the tool first tries `(substringof('code', FieldValue) or FieldId eq 'code' or FieldId eq '<zero-padded>')` and, if the server rejects a `FieldId` filter or returns nothing, pages the unfiltered list and matches the code client-side, leading zeros ignored. Padded widths: `RKDAUF` 10, `RAUFNR` 12, `RKDPOS` 6.
  - Without an explicit `$top` the tool pages with `$top=500`, advancing `$skip` by the number of rows actually returned, and stops on an empty page or one that repeats rows.
  - A `salesOrder` without `salesOrderItem` is completed from `salesOrderItems(order, range)`: exactly one row → used; several → error listing them; none → error.
- `Favorites?$filter=Pernr eq 'P'` → `ID`, `Name`, `ObjType` (`F` / `FW`), `Field_Text`, `FavoriteDataFields{AWART, RAUFNR, RKDAUF, RKDPOS, CATSHOURS, …}`.

### Write

The app fetches a CSRF token (`GET` with `x-csrf-token: Fetch`), then sends a `$batch` with one changeset per entry:

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

Per-entry errors come back as OData error bodies inside the batch part (`error.message.value`, `error.innererror.errordetails[]`).

Favorites: `POST Favorites {Name, Pernr, FavoriteDataFields{…}}`, `PUT|DELETE Favorites(ID='…',Pernr='…')`.

## Multiproject timesheet (`ZHCM_TIMESHEET_MAN_V2_SRV_01`)

- `GetMasterListSet` → months: `Gjahr`, `Perio`, `Status`, `TotalHours`, `MissingHours`, `ChargeableHours`.
- `InitialInfos`, `ConcurrentEmploymentSet`, `ProfileFields`, `Favorites`, `ValueHelpList` (no `Pernr` filter needed).
- `WorkCalendars?$filter=StartDate eq 'yyyymm01' and EndDate eq 'yyyymmdd'`.
- `GetTimeDataSet?$filter=Gjahr eq '2026' and Perio eq '09'` → one row with two JSON strings:
  - `ColumnData`: `{"DATA":[{"COLNAME":"PROJECT1","COLINFO":{"RAUFNR","AWART","RKDAUF","RKDPOS","ZZTEXT","ZZLAND","ZZBLAND"}}]}`
  - `RowData`: `{"DATA":[{"DATE":"2026-08-01","PROJECT1":{"HOURS":"8.00","COUNTER":"0000…","TEXT":"","LONGTEXT":""},"TOTAL_HOURS":"8"}]}`
- Save = `POST UpdateTimeDataSet {ColumnData, RowData}` where both are JSON **strings of bare arrays** (no `DATA` wrapper): the project columns (`ZZTEXT` blanked) and the day rows. Empty `HOURS` on a cell with a `COUNTER` deletes that entry; a new column is `PROJECT<n+1>`.
- Locking (`ZB_LOCK_SRV`): `GET CatsLock` → `LockObject: "X"` when acquired (anything else = locked elsewhere); `GET CatsRelock` every 60 s while editing; `GET CatsUnlock` when done. The tool locks before a save and unlocks afterwards, like the app.

## Recording your own system

```bash
pnpm exec tsx scripts/record-traffic.ts '#StandardTimesheet-manage' out.json
xflow-timesheet http get '/sap/opu/odata/sap/ZHCM_TIMESHEET_MAN_SRV/$metadata'
```

The first records an app's OData traffic; the second is raw authenticated access to any path on the SAP host.
