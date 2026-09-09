# User guide — the timesheet flows

Each section is one flow from [specs/user-flows-timesheets.md](../specs/user-flows-timesheets.md),
with the CLI command and the equivalent MCP tool call. Codes used in the
examples are real ones from this tenant:

| Code | Meaning |
| --- | --- |
| `0077` | Administration (attendance type) |
| `0010` | Holiday, full day (absence type) |
| `0800` | Chargeable hours (attendance type used with a sales order) |
| `0081` | NCH-Order BAP (attendance type used with a non-chargeable order) |
| `900140` | non-chargeable order "AI Incubator - NovaLabs" |
| `3141993` / `000401` | chargeable sales order "Globex Coupa Invoicing & RPMA", item "CM Strategy" |

Everything below assumes a stored session (`xflow-timesheet login`, or the
`login_start` / `login_submit_otp` MCP tools). `--from/--to` default to the
current month. Add `--json` to any command for machine-readable output; MCP
tools always return JSON.

A "jobcode" is given with the same options everywhere: an attendance/absence
type (`--attendance-type` / `-a`), a non-chargeable order (`--order` / `-o`,
usually with `-a 0081`) or a chargeable sales order + item (`--sales-order` /
`-s` + `--sales-order-item` / `-i`, usually with `-a 0800`). Favorites
(`std favorites`) bundle a jobcode and default hours under a name (`--favorite`).

**Every command that writes accepts `--dry-run`**: it prints exactly what would
be booked (per day, with hours) and writes nothing. Run it first, then drop the
flag. The MCP tools have the same `dryRun: true` parameter.

---

## Standard timesheet

### 1. Which days are filled, which are missing

```bash
xflow-timesheet std days                          # this month
xflow-timesheet std days --from 2026-09-01 --to 2026-09-15
xflow-timesheet std open-days                     # only the days that still miss hours
```

```
date        state    target  booked  missing  entries
2026-09-01  filled   8       8       0        8h AI Incubator - NovaLabs (900140) · NCH-Order BAP (0081)
2026-09-02  MISSING  8       4       4        4h Administration (0077)
2026-09-03  MISSING  8       0       8
…
1 filled, 21 missing (172h)
```

MCP: `std_days {from, to}` (every working day with `filled`, `bookedHours`,
`missingHours`, `entries`) or `std_open_days {from, to}` (missing days only).

### 2. Set one or several days to a jobcode or absence type

`std set` makes the days contain *exactly* that item: whatever was booked on
them is deleted first, then the item is created (one `$batch`). `std fill`
adds without deleting.

```bash
# preview first: shows what would be removed and what would be created
xflow-timesheet std set 2026-09-15 --attendance-type 0010 --hours 8 --dry-run
# one day of holiday
xflow-timesheet std set 2026-09-15 --attendance-type 0010 --hours 8
# several days on a non-chargeable order (working days of a range, weekends skipped)
xflow-timesheet std set 2026-09-08..2026-09-12 --order 900140 --attendance-type 0081 --hours 8 --short-text "NovaLabs"
# chargeable work
xflow-timesheet std set 2026-09-16 2026-09-17 --sales-order 3141993 --sales-order-item 000401 --attendance-type 0800
# from a favorite (its item and default hours)
xflow-timesheet std set 2026-09-18 --favorite Holiday
# add 2h without touching what is already there
xflow-timesheet std fill 2026-09-19 --attendance-type 0077 --hours 2
# change one existing entry (counter from `std entries`)
xflow-timesheet std update 000054851366 2026-09-19 --attendance-type 0077 --hours 4
# delete entries by counter
xflow-timesheet std remove 000054851366 --from 2026-09-01 --to 2026-09-30
```

MCP: `std_set {dates:["2026-09-08","2026-09-09"], item:{order:"900140", attendanceType:"0081"}, hours:8}`,
`std_fill {…}`, `std_update {counter, date, item, hours}`, `std_remove {counters, from, to}`.
Find codes with `std_chargeable_orders {query:"Globex"}`,
`std_sales_order_items {salesOrder:"3141993"}`, `std_non_chargeable_orders {query:"NovaLabs"}`,
`std_attendance_types {}` (queries are case-sensitive substrings).

### 3. Does my month contain jobcode X (or a set of jobcodes), and how often

```bash
xflow-timesheet std jobcodes                       # everything booked this month, with counts
xflow-timesheet std jobcodes 0010 900140           # only these codes (empty = not present)
xflow-timesheet std jobcodes 3141993 --from 2026-08-01 --to 2026-08-31
```

```
jobcode                                                 days  hours  share   dates
AI Incubator - NovaLabs (900140) · NCH-Order BAP (0081)  5    40     23.81%  2026-08-03,2026-08-04,…
Holiday (full day) (0010)                               16   128    76.19%  2026-08-10,…
```

MCP: `std_jobcodes {from, to, codes:["0010","900140"]}` → `[{item, days, hours, share, dates}]`.
A code matches an order, a sales order, a sales order item or an attendance type.

### 4. Retrieve staffing

In the app, "Retrieve staffing" (the MDS button) loads the staffing plan as
*Planned* entries which you then submit. The tool splits that in two:

```bash
xflow-timesheet std staffing                       # show the plan for this month
xflow-timesheet std staffing --apply --dry-run     # what would be booked / skipped
xflow-timesheet std staffing --apply               # book it on open days that still miss the planned hours
xflow-timesheet std staffing --apply --dates 2026-09-03,2026-09-04
```

```
date        hours  planned
2026-09-01  8      AI Incubator - NovaLabs (900140) · NCH-Order BAP (0081)
…
```

`--apply` reports what it created and what it skipped (period closed, day
already filled, fewer hours missing than planned).

MCP: `std_staffing {from, to}` then `std_staffing_apply {from, to, dates?}`.

### 5. Quick actions: fill the entire open period

`std fill-open` books one item on every open day of the range, each day with
its missing hours (so a day with 4h already booked gets 4h).

```bash
# preview, then fill everything still open this month with admin code 0077
xflow-timesheet std fill-open --attendance-type 0077 --dry-run
xflow-timesheet std fill-open --attendance-type 0077
# fill the open period with a jobcode
xflow-timesheet std fill-open --order 900140 --attendance-type 0081 --short-text "NovaLabs"
# at most 2h per day, in a sub-range
xflow-timesheet std fill-open --from 2026-09-15 --to 2026-09-30 --favorite "Admin Day" --max-hours 2
```

MCP: `std_fill_open {from, to, item:{attendanceType:"0077"}}` or
`std_fill_open {favorite:"Admin Day", maxHours:2}`.

---

## Multiproject timesheet

The multiproject app shows a month as a grid: one column per *project*
(order / sales order + attendance type), one row per day. All writes below lock
the timesheet like the app does and release the lock afterwards. Months are
`YYYY-MM`.

### 6. Several jobcodes on given days or a date range

```bash
# one project, explicit days
xflow-timesheet mp allocate 2026-09 --order 900140 --attendance-type 0081 --day 2026-09-03=4 --day 2026-09-04=8
# one project, every working day of a range
xflow-timesheet mp allocate 2026-09 --attendance-type 0077 --range 2026-09-08..2026-09-12 --hours 2
# several projects per day in ONE save: every working day 2h on NovaLabs and 6h on admin
xflow-timesheet mp plan 2026-09 --range 2026-09-08..2026-09-12 \
  --slot order=900140,attendance=0081:2 \
  --slot attendance=0077:6 \
  --dry-run            # remove to save
# chargeable slot syntax: salesOrder=<order>/<item>
xflow-timesheet mp plan 2026-09 --range 2026-09-15..2026-09-19 --slot salesOrder=3141993/000401,attendance=0800:8
# remove a project's hours on some days
xflow-timesheet mp clear 2026-09 --attendance-type 0077 --dates 2026-09-08,2026-09-09
```

Slot syntax: `key=value[,key=value]:hours` with keys `attendance` (or `att`),
`order`, `salesOrder[/item]`. The dry run prints a per-day table:

```
date        target  order 900140 · type 0081  type 0077  total
2026-09-08  8       2                          6          8
2026-09-09  8       2                          6          8
…
```

MCP: `mp_allocate {year:2026, month:9, project:{order:"900140", attendanceType:"0081"}, days:[{date:"2026-09-03", hours:4}]}` or
`mp_allocate_many {year, month, slots:[{project:{order:"900140",attendanceType:"0081"}, range:{from:"2026-09-08",to:"2026-09-12"}, hours:2}, {project:{attendanceType:"0077"}, range:{…}, hours:6}]}`.
`mp_clear {year, month, project, dates?}` removes hours.

### 7. Which jobcodes are in a day / range / the open period, and their proportion

```bash
xflow-timesheet mp stats 2026-09                              # whole month
xflow-timesheet mp stats 2026-09 --from 2026-09-08 --to 2026-09-12
xflow-timesheet mp stats 2026-09 --from 2026-09-10 --to 2026-09-10   # one day
xflow-timesheet mp month 2026-09                              # the full grid
```

```
2026-09-08 .. 2026-09-12: 40h booked of 40h target
project                                    hours  days  share
Administration (0077)                      30     5     75%
AI Incubator - NovaLabs (900140) · 0081   10     5     25%
```

MCP: `mp_stats {year, month, from?, to?}` → `{totalHours, targetHours, projects:[{project, hours, days, share}], perDay}`;
`mp_month {year, month}` for the grid.

### 8. Edit a range to match an overall proportion

`mp balance` rewrites the working days of a range so the given jobcodes hold
the requested shares of the range's *target* hours. Any other hours on those
days are cleared, so every day ends up exactly at its target. Two layouts:

- `--mode whole-days` (default): consecutive whole days per jobcode — X on the
  first days, then Y; only the day where a quota ends is split.
- `--mode every-day`: every day is split by the shares (4.8h/3.2h for 60/40,
  rounded to quarter hours; the totals stay exact).

Always preview with `--dry-run`; the table shows each day's split.

```bash
# first two weeks: 60% NovaLabs, 40% admin  (10 days × 8h = 80h → 48h + 32h), whole days
xflow-timesheet mp balance 2026-09 --range 2026-09-01..2026-09-12 \
  --slot order=900140,attendance=0081:60% \
  --slot attendance=0077:40% --dry-run
```

```
Dry run — nothing written. Balance 2026-09-01..2026-09-12 (80h target), mode whole-days:

date        target  order 900140 · type 0081  type 0077  total
2026-09-01  8       8                          0          8
…
2026-09-08  8       8                          0          8
2026-09-09  8       0                          8          8
…
2026-09-12  8       0                          8          8

project                    hours  share
order 900140 · type 0081   48     60%
type 0077                  32     40%
```

```bash
# same shares, but every single day split 60/40
xflow-timesheet mp balance 2026-09 --range 2026-09-01..2026-09-12 \
  --slot order=900140,attendance=0081:60% --slot attendance=0077:40% --mode every-day
```

Shares must add up to 100. MCP:
`mp_balance {year:2026, month:9, range:{from:"2026-09-01", to:"2026-09-12"}, slots:[{project:{order:"900140",attendanceType:"0081"}, share:60}, {project:{attendanceType:"0077"}, share:40}], mode:"every-day", dryRun:true}`
→ the per-day plan; without `dryRun` it writes and returns the resulting `mp_stats`.

---

## Notes that apply everywhere

- Closed periods (`PER_CLOSED`, e.g. last month once payroll ran) are read-only; writes to them are rejected with a clear message.
- On this tenant's profile entries are approved immediately on save (status `DONE`, "Approved"); `--no-release` therefore changes nothing visible.
- Exit codes: `0` ok · `1` usage / no session · `2` login rejected · `3` session expired · `4` SAP rejected something (per-day results are still printed).
- Every write command prints the per-day outcome; with `--json` the same structure the MCP tools return.
