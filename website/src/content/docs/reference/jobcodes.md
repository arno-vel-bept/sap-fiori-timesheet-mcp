---
title: Jobcodes and codes
description: The CATS fields behind an entry, how an item is written on the CLI and in MCP calls, and how dates and ranges are spelled.
sidebar:
  order: 4
---

<span class="doc-kind">Reference</span>

## The fields behind an entry

Every time entry carries these CATS fields. "Jobcode" in these pages means any combination of them that identifies what the time is booked on.

| Field | Meaning | App label | Example |
| --- | --- | --- | --- |
| `AWART` | attendance / absence type | Att./Abs. type | `0010` Holiday (full day), `0800` Chargeable hours, `0081` NCH-Order BAP, `0077` Administration, `F035` RTT |
| `RAUFNR` | receiver (internal) order: a **non-chargeable order** | NonCh. order | `900140` (stored as `000000900140`) |
| `RKDAUF` | receiving sales order: a **chargeable order** | Ch. order | `3141993` (stored as `0003141993`) |
| `RKDPOS` | sales order item | Rec. item | `000401`; required with `RKDAUF` |
| `LTXA1` | short text, 40 characters | Short Text | free text |

Rules of thumb:

- An **absence or overhead** (holiday, administration) is an attendance type alone.
- **Non-chargeable work** is an order, usually with attendance type `0081`.
- **Chargeable work** is a sales order plus an item, usually with attendance type `0800`. When the sales order has exactly one item, the item is filled in automatically; with several, you must name one.

The codes above are the BearingPoint tenant's. Other systems have their own; list them with the value-help commands below.

## Writing an item

| Where | Syntax |
| --- | --- |
| CLI flags | `-a, --attendance-type <code>`, `-o, --order <code>`, `-s, --sales-order <code>`, `-i, --sales-order-item <code>`, `-t, --short-text <text>`; or `-f, --favorite <name-or-id>` |
| MCP `item` / `project` | `{"attendanceType": "0081", "order": "900140"}`, `{"salesOrder": "3141993", "salesOrderItem": "000401", "attendanceType": "0800"}`, `{"attendanceType": "0010"}`; or `"favorite": "Holiday"` |
| CLI `mp plan` / `mp balance` slot | `key=value[,key=value]:amount` with keys `attendance` (or `att`), `order`, `salesOrder[/item]`; amount is hours (`:2`) for `plan` and a percentage (`:60%`) for `balance` |

## Finding codes

| Need | CLI | MCP tool |
| --- | --- | --- |
| Attendance / absence types | `std attendance-types [query]` | `std_attendance_types` |
| Chargeable sales orders, with client, partner and manager | `std chargeable-orders [query]` | `std_chargeable_orders` |
| Items of a sales order | `std sales-order-items <order>` | `std_sales_order_items` |
| Non-chargeable orders | `std non-chargeable-orders [query]` | `std_non_chargeable_orders` |
| Your assigned orders | `std worklist` | `std_worklist` |
| Favorites | `std favorites` | `std_favorites` |

The query matches the description text and is **case-sensitive** (`Globex`, not `globex`). A query that looks like a code (contains a digit, no spaces) is resolved by code instead, leading zeros ignored, even when it is beyond the first page of results. `--top <n>` limits the results; without it the tool pages through everything.

## Dates, ranges and months

| Form | Meaning |
| --- | --- |
| `2026-09-15` | One day. |
| `2026-09-08..2026-09-12` | The working days of the range (Saturdays and Sundays skipped; add `--include-weekends` on `std fill` / `std set` to keep them). |
| `2026-09-03,2026-09-04` or `2026-09-03 2026-09-04` | Several days. |
| `--from 2026-09-01 --to 2026-09-30` | A range for reading commands; both default to the current month. |
| `2026-09` | A month, for the `mp` commands. MCP tools take `year: 2026, month: 9`. |

## Statuses you will see

| Status | Meaning |
| --- | --- |
| `MSAVE` | saved, not released |
| `DONE` / Approved | released and approved (CATS status 30). On auto-approving profiles this is the state right after saving. |
| `REJECTED` | rejected by the approver |
| `PER_CLOSED` | the period is closed; read-only |
| `Planned` | a staffing-plan entry that is not booked yet |
| `YACTION` | (months) open for editing |
