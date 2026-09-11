---
title: Timesheet concepts
description: The vocabulary the tool and the SAP apps share, standard versus multiproject, entries, items, favorites, periods, release and approval.
sidebar:
  order: 4
---

<span class="doc-kind">Explanation</span>

## Two apps, one CATS

Both timesheet apps write into SAP's Cross-Application Time Sheet (CATS). They are two views of the same data:

- The **Standard timesheet** is a list of entries. Each entry is one day, one item, some hours, and a twelve-digit **counter** that identifies it. A day with hours on two projects has two entries. This is where absences, staffing plans and favorites live.
- The **Multiproject timesheet** is a grid: rows are the days of a month, columns are **projects** (an order or a sales order, plus an attendance type), cells are hours. Saving the grid creates, updates and deletes the underlying entries in one go, under a lock so that nobody else edits the month meanwhile.

The tool mirrors that split: `std` commands and `std_*` tools work on entries and days, `mp` commands and `mp_*` tools work on the grid. Both see the same hours.

## Items, jobcodes, projects

An **item** is what time is booked on: an attendance/absence type, a non-chargeable order, or a chargeable sales order and item, possibly combined (order plus attendance type `0081` is the usual pairing). "Jobcode" is the everyday word for the same thing; "project" is the Multiproject app's word for it. [Jobcodes and codes](../../reference/jobcodes/) lists the fields and the syntax.

A **favorite** is an item with default hours saved under a name in SAP. It is a convenience for you and for the assistant: "book Thursday from my Holiday favorite" needs no codes.

## Working days, target hours, periods

SAP's work calendar says, for each day, whether it is a working day and how many **target hours** it carries (8 on a normal day). A day is **filled** when its booked hours reach the target; the difference is what the tool calls **missing hours**. Ranges written as `a..b` expand to the working days only.

Days belong to **periods**. An open period (`YACTION`) accepts writes; a closed one (`PER_CLOSED`, typically last month once payroll ran) is read-only and every write to it is refused.

## Release and approval

A saved entry can be *released* (sent for approval) and later *approved*. The apps release on save, and so does the tool (`--no-release` / `release: false` omits the flag). On profiles configured to approve directly, such as BearingPoint's, an entry is approved the moment it is saved, and the release flag makes no visible difference. Statuses you will see are listed in [Jobcodes and codes](../../reference/jobcodes/#statuses-you-will-see).

## Fill, set, fill-open, balance

The writing operations differ in what they do to existing entries, which is worth keeping straight:

| Operation | Existing entries on the day | Hours |
| --- | --- | --- |
| `fill` | kept; the new entry is added | as given (or the favorite's, else 8) |
| `set` | deleted first | as given |
| `fill-open` | kept | exactly the day's missing hours, optionally capped |
| staffing `--apply` | kept; only days that still miss the planned hours get an entry | the plan's |
| `mp allocate` / `plan` | other projects kept; this project's cell replaced | as given |
| `mp balance` | **other projects cleared** on the range's days | computed from the shares and the target |

Every operation that touches several days has a dry run, and the dry run is the same code path with the write left out.

## The staffing plan

Some organisations plan staffing in a separate system (MDS). The Standard timesheet app's **Retrieve staffing** button loads that plan as *Planned* entries which you then submit. The tool reads the plan (`std staffing`) and books it (`--apply`) as two explicit steps, skipping days that are closed, already filled, or missing fewer hours than planned.
