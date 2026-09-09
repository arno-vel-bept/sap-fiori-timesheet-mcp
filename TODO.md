# TODO

## Chargeable-order lookup doesn't find orders the real UI can select (2026-09-1x)

**Symptom.** Asked the agent to fill days with jobcode `2150634`. It refused, correctly
declining to guess, for two reasons:

1. `2150634` is a 7-digit code — the format of a chargeable sales order (RKDAUF), not a
   non-chargeable order (RAUFNR). It didn't show up in `std_chargeable_orders` for
   September — the nearest neighbours returned were `2150628` (Pega-Migration, BImA) and
   `2150621` (BB FZU Scrum Master, KfW).
2. Booking a chargeable order also needs a sales-order item (RKDPOS, e.g. `000401`), which
   wasn't given, so nothing could be safely invented.

But in the real Fiori UI, selecting this exact jobcode works: it shows the compatible
"Rec. sales order" (RKDPOS) values, and since there's only one, the UI auto-fills it. So the
tool is missing some request/behavior the UI relies on — this isn't a "the order doesn't
exist" situation.

**Root causes found so far** (from reading `src/timesheet/standard.ts`):

- `valueHelp()` (around `standard.ts:300-319`) builds its search filter as
  `substringof(query, FieldValue)` only. `FieldValue` is the **description text**
  (e.g. "AI Incubator - GenXplore"), not the code (`FieldId`). So passing an order
  **number** as the `query` to `chargeableOrders()` / `std_chargeable_orders` can never
  match it — there's no filter on `FieldId` at all. The real UI's search box very likely
  matches on the code too (or switches to an exact/code lookup when the input is numeric).
- No default `$top`/`$skip` is sent unless the caller passes one (`standard.ts:308-309`),
  and a real probe of `RKDAUF` earlier in this project returned ~150 rows — i.e. the
  service (or SAP Gateway) may cap/paginate server-side regardless. An order that's valid
  but outside whatever ordering SAP applies could simply never appear in an unfiltered
  listing, even though it's perfectly bookable by exact code.
- `validateItem()` (`types.ts`) requires an explicit `salesOrderItem` whenever a
  `salesOrder` is given, and throws otherwise. The real UI's "auto-fill when there's only
  one match" behavior (RKDPOS via `FieldRelated = RKDAUF = <value>`) is not mirrored:
  `salesOrderItems(order)` already exists and does the right OData call, but nothing in
  `fill` / `set` / `allocate` calls it automatically to resolve a missing item.

**Next steps to investigate / implement:**

1. Add an **exact-code lookup** path: try `FieldId eq '<code>'` (in addition to / instead
   of the substring-on-text search) so a known order number always resolves regardless of
   pagination, the same way the UI's field seems to behave when you paste/type a code.
   Check the `ValueHelpList` `$metadata` for whether `FieldId` is filterable (should be, per
   `docs/api-notes.md`) and confirm against the real system with a probe.
2. Auto-fill the sales-order item when it's omitted: if `salesOrder` is given without
   `salesOrderItem`, call `salesOrderItems(salesOrder)` — if it returns exactly one row, use
   it (matching the UI); if more than one, surface a clear error listing the options instead
   of silently picking one; if zero, that's a genuine "not found" and the current refusal is
   correct.
3. Re-check whether `std_chargeable_orders` needs pagination support surfaced to the agent
   (e.g. loop `$skip` until exhausted, or raise the default `$top`) so a full, valid listing
   for the month is actually achievable, not just the first page.
4. Add a fake-server test case (in `test/fixtures/fake-xflow.ts`) for an order that only
   shows up via exact-code lookup and has exactly one RKDPOS item, to lock in both fixes
   with TDD before touching the real system.
5. Verify against the real xflow system once the above lands (`XFLOW_E2E=1` read-only
   first, matching the pattern already used in `test/e2e/real-xflow.test.ts`).
