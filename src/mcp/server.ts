import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VERSION } from "../version.js";
import { resolveConfig, type Env } from "../config.js";
import { SessionStore } from "../auth/session-store.js";
import { LoginFlow } from "../auth/login-flow.js";
import { LoginError } from "../auth/sso-login.js";
import { SessionManager, type SessionManagerOptions } from "../auth/session-manager.js";
import { SapClient, SessionExpiredError } from "../sap/client.js";
import { StandardTimesheet } from "../timesheet/standard.js";
import { BALANCE_MODES, MultiprojectTimesheet } from "../timesheet/multiproject.js";
import { TimesheetError, type EntryItem } from "../timesheet/types.js";

export interface McpServerOptions {
  env?: Env;
  /** Overrides for the SessionManager (tests inject a browser launcher that never opens a window). */
  sessionOptions?: Partial<SessionManagerOptions>;
}

const itemSchema = z
  .object({
    attendanceType: z.string().optional().describe("Attendance/absence type code (AWART): 0010 holiday full day, 0015 half day, 0800 chargeable hours, 0081 NCH order, 0077 administration, F035 RTT…"),
    order: z.string().optional().describe("Non-chargeable receiver order (RAUFNR), e.g. 900140. Use std_non_chargeable_orders to search."),
    salesOrder: z.string().optional().describe("Chargeable sales order (RKDAUF), e.g. 3136787. Use std_chargeable_orders to search."),
    salesOrderItem: z.string().optional().describe("Sales order item (RKDPOS), e.g. 000401. Needed with salesOrder — but if the order has exactly one item it is filled in automatically; use std_sales_order_items to see them, or pass it when the order has several."),
    shortText: z.string().max(40).optional().describe("Short text (LTXA1)"),
  })
  .describe("What to book the time on: an attendance type and/or an order.");

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const dryRunSchema = z.boolean().optional().describe("true = only return what would be booked, write nothing");
const rangeSchema = {
  from: dateSchema.optional().describe("Start date YYYY-MM-DD (default: first day of the current month)"),
  to: dateSchema.optional().describe("End date YYYY-MM-DD (default: last day of the current month)"),
};

/** Builds the MCP server (stdio transport is attached by the caller). */
export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const env = opts.env ?? process.env;
  const cfg = () => resolveConfig(env);
  const store = () => new SessionStore(cfg().sessionFile);
  const loginFlow = { current: null as LoginFlow | null };
  let sessionManager: SessionManager | null = null;
  /** One SessionManager per server: it serialises access to the browser profile and caches the last probe. */
  const sessions = (): SessionManager => {
    if (!sessionManager) {
      const c = cfg();
      sessionManager = new SessionManager({
        launchpadUrl: c.launchpadUrl,
        store: store(),
        profileDir: c.profileDir,
        channel: c.browserChannel,
        language: c.language,
        sapClient: c.sapClient,
        ...(opts.sessionOptions ?? {}),
      });
    }
    return sessionManager;
  };

  /**
   * Every tool gets its client through here: the stored SAP session is probed and, when it has
   * expired, renewed silently through the persistent browser profile. Only sso_login may open a window.
   */
  const client = async (): Promise<SapClient> => {
    const c = cfg();
    const { session } = await sessions().ensureSession({ interactive: false });
    return new SapClient(session, { language: c.language, sapClient: c.sapClient });
  };
  const std = async () => new StandardTimesheet(await client());
  const mp = async () => new MultiprojectTimesheet(await client());

  const server = new McpServer({ name: "xflow-timesheet", version: VERSION }, { instructions: INSTRUCTIONS });

  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: undefined });
  const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
  const toFailure = (e: unknown) => {
    if (e instanceof TimesheetError) return fail(e.message);
    if (e instanceof SessionExpiredError) return fail(e.message);
    return fail(`SAP error: ${(e as Error)?.message ?? String(e)}`);
  };
  /** A stale SAP session that a silent refresh has NOT already tried and failed to renew. */
  const isRenewable = (e: unknown) => e instanceof SessionExpiredError && !/fresh sign-in/i.test(e.message);
  /**
   * `retry: true` re-runs `fn` once after a renewable SessionExpiredError, forcing a fresh
   * probe/refresh in between (invalidate() drops the cached probe). Only safe for read-only tools —
   * re-running a mutating tool could double-apply the part that already succeeded before the
   * session lapsed. The "needs a fresh sign-in" error is skipped: the silent refresh already ran.
   */
  const run = async (fn: () => Promise<unknown>, { retry = false }: { retry?: boolean } = {}) => {
    try {
      return ok(await fn());
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        sessionManager?.invalidate();
        if (retry && isRenewable(e)) {
          try {
            return ok(await fn());
          } catch (e2) {
            if (e2 instanceof SessionExpiredError) sessionManager?.invalidate();
            return toFailure(e2);
          }
        }
        return fail(e.message);
      }
      return toFailure(e);
    }
  };
  /** Read-only tools: retry once on an expired session (see `run`). */
  const runRead = (fn: () => Promise<unknown>) => run(fn, { retry: true });
  const defaultRange = (from?: string, to?: string) => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const mm = String(m).padStart(2, "0");
    return { from: from ?? `${y}-${mm}-01`, to: to ?? `${y}-${mm}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}` };
  };

  // ---------------- session / login ----------------
  const SSO_HINT = "Call sso_login: it renews the session silently when the identity provider still remembers this browser profile, and otherwise opens a browser window for the user to sign in (no password passes through the tool).";
  server.registerTool(
    "session_status",
    {
      description:
        "Whether an SAP session is available (calls SAP to check; an expired session is renewed silently through the persistent browser profile when possible). Returns the SAP user when logged in, and whether the identity provider's sign-in is remembered.",
      inputSchema: {},
    },
    async () => {
      const c = cfg();
      const identityRemembered = sessions().hasProfile();
      try {
        // ensureSession() now validates against the OData tier the data tools use, so "logged in"
        // here means the data calls should work too (it no longer trusts /sap/bc/ui2/start_up,
        // which the start_up read below only uses to fetch the user's name).
        const { session, method } = await sessions().ensureSession({ interactive: false });
        const me = await new SapClient(session, { language: c.language, sapClient: c.sapClient }).getJson<Record<string, unknown>>("/sap/bc/ui2/start_up");
        return ok({ loggedIn: true, method, identityRemembered, createdAt: session.createdAt, user: { id: me.id, fullName: me.fullName, client: me.client, language: me.language } });
      } catch (e) {
        sessionManager?.invalidate();
        const reason = e instanceof SessionExpiredError || e instanceof LoginError ? e.message : `SAP error: ${(e as Error).message}`;
        return ok({ loggedIn: false, identityRemembered, sessionFile: c.sessionFile, profileDir: c.profileDir, reason, hint: SSO_HINT });
      }
    },
  );

  server.registerTool(
    "sso_login",
    {
      description:
        "Establish an SAP session through the persistent browser profile. Fast when the stored session is still valid ('cached') or the identity provider still remembers the browser ('silent', a headless round trip with no prompt). " +
        "Otherwise a browser window opens on the user's machine and they sign in there themselves, 2FA included — tell the user to look for the window; the call returns once they are through (up to 4 minutes). No password ever passes through this tool. " +
        "Prefer this over login_start.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const res = await sessions().ensureSession({ interactive: true }).catch((e: unknown) => {
          if (e instanceof LoginError) throw new TimesheetError(`Sign-in failed (${e.code}): ${e.message}`);
          throw e;
        });
        return { state: "done", method: res.method, cookies: res.session.cookies.length, sessionFile: cfg().sessionFile, profileDir: cfg().profileDir };
      }),
  );

  server.registerTool(
    "login_start",
    {
      description:
        "Compatibility login with credentials (prefer sso_login, which needs none). Drives the Microsoft SSO form in a headless browser inside the persistent profile, so later sessions are renewed silently. email/password are optional: when omitted, they are read from the XFLOW_EMAIL / XFLOW_PASSWORD environment variables configured in the MCP server's env block. Returns {state:'done'} when no 2FA is needed, {state:'otp_required', prompt} when a one-time code must be supplied via login_submit_otp, or {state:'number_match', number} when the user must approve the number in their Authenticator app (then call login_wait).",
      inputSchema: {
        email: z.string().optional().describe("Account email; defaults to the XFLOW_EMAIL environment variable"),
        password: z.string().optional().describe("Account password (never stored); defaults to the XFLOW_PASSWORD environment variable"),
      },
    },
    async ({ email, password }) =>
      run(async () => {
        if (loginFlow.current?.inProgress) throw new TimesheetError("A login is already in progress; use login_submit_otp or login_wait.");
        const c = cfg();
        const resolvedEmail = email ?? c.email;
        const resolvedPassword = password ?? c.password;
        const missing = [!resolvedEmail && "email (or XFLOW_EMAIL)", !resolvedPassword && "password (or XFLOW_PASSWORD)"].filter(Boolean);
        if (missing.length || !resolvedEmail || !resolvedPassword) {
          throw new TimesheetError(`Missing ${missing.join(" and ")}. Pass them as arguments, or set XFLOW_EMAIL / XFLOW_PASSWORD in the MCP server's env block.`);
        }
        loginFlow.current = new LoginFlow({ launchpadUrl: c.launchpadUrl, headless: true, profileDir: c.profileDir, channel: c.browserChannel });
        return finishStep(await loginFlow.current.start({ email: resolvedEmail, password: resolvedPassword }));
      }),
  );
  server.registerTool(
    "login_submit_otp",
    { description: "Provide the one-time verification code requested by login_start.", inputSchema: { code: z.string().describe("6-digit code from the authenticator app / SMS") } },
    async ({ code }) =>
      run(async () => {
        if (!loginFlow.current) throw new TimesheetError("No login in progress; call login_start first.");
        return finishStep(await loginFlow.current.submitOtp(code));
      }),
  );
  server.registerTool("login_wait", { description: "Wait for the login to progress (after a number_match step).", inputSchema: {} }, async () =>
    run(async () => {
      if (!loginFlow.current) throw new TimesheetError("No login in progress; call login_start first.");
      return finishStep(await loginFlow.current.wait());
    }),
  );
  async function finishStep(step: Awaited<ReturnType<LoginFlow["start"]>>) {
    if (step.state === "done") {
      await store().save(step.session);
      sessionManager?.invalidate();
      loginFlow.current = null;
      return { state: "done", cookies: step.session.cookies.length, sessionFile: cfg().sessionFile };
    }
    if (step.state === "error") {
      loginFlow.current = null;
      throw new TimesheetError(`Login failed (${step.code}): ${step.message}`);
    }
    return step;
  }
  server.registerTool(
    "logout",
    {
      description: "Delete the stored SAP session. With forgetIdentity: true the persistent browser profile is deleted too, so the identity provider will ask for a full sign-in next time.",
      inputSchema: { forgetIdentity: z.boolean().optional().describe("also delete the browser profile that remembers the identity provider sign-in (default false)") },
    },
    async ({ forgetIdentity }) =>
      run(async () => {
        if (forgetIdentity) await sessions().forgetIdentity();
        else {
          await store().clear();
          sessionManager?.invalidate();
        }
        return { loggedOut: true, identityForgotten: Boolean(forgetIdentity) };
      }),
  );

  // ---------------- standard timesheet ----------------
  server.registerTool(
    "std_info",
    { description: "Standard timesheet profile info: personnel number, data-entry profile, whether entries are released directly.", inputSchema: {} },
    async () => runRead(async () => (await std()).info()),
  );
  server.registerTool(
    "std_open_days",
    {
      description: "List working days in open (not closed) periods that still have missing hours, with target/booked/missing hours and the entries already booked on each day. Default range: current month.",
      inputSchema: rangeSchema,
    },
    async ({ from, to }) =>
      runRead(async () => {
        const r = defaultRange(from, to);
        return (await std()).openDays(r.from, r.to);
      }),
  );
  server.registerTool("std_calendar", { description: "Calendar days with target hours, working-day flag and period status.", inputSchema: rangeSchema }, async ({ from, to }) =>
    runRead(async () => {
      const r = defaultRange(from, to);
      return (await std()).calendar(r.from, r.to);
    }),
  );
  server.registerTool(
    "std_entries",
    { description: "List time entries (counter, date, hours, status, item) in a date range. Default range: current month.", inputSchema: rangeSchema },
    async ({ from, to }) =>
      runRead(async () => {
        const r = defaultRange(from, to);
        return (await std()).entries(r.from, r.to);
      }),
  );
  server.registerTool("std_favorites", { description: "List favorite entries (name, default hours, item).", inputSchema: {} }, async () => runRead(async () => (await std()).favorites()));
  server.registerTool(
    "std_favorite_add",
    { description: "Create a favorite.", inputSchema: { name: z.string(), item: itemSchema, hours: z.number().positive().optional() } },
    async ({ name, item, hours }) => run(async () => (await std()).addFavorite(name, item as EntryItem, hours)),
  );
  server.registerTool("std_favorite_remove", { description: "Delete a favorite by id.", inputSchema: { id: z.string() } }, async ({ id }) =>
    run(async () => ((await std()).deleteFavorite(id), { deleted: id })),
  );
  const vhInput = { query: z.string().optional().describe("Case-sensitive substring of the text"), top: z.number().int().positive().optional(), ...rangeSchema };
  server.registerTool("std_attendance_types", { description: "Attendance / absence types (AWART codes).", inputSchema: vhInput }, async ({ query, top, from, to }) =>
    runRead(async () => (await std()).attendanceTypes(query, { top, from, to })),
  );
  server.registerTool("std_chargeable_orders", { description: "Chargeable sales orders (RKDAUF) with client, partner and manager. `query` matches the description text (case-sensitive); a numeric `query` is treated as an order number and resolved by code even if it is not on the first page.", inputSchema: vhInput }, async ({ query, top, from, to }) =>
    runRead(async () => (await std()).chargeableOrders(query, { top, from, to })),
  );
  server.registerTool("std_non_chargeable_orders", { description: "Non-chargeable receiver orders (RAUFNR).", inputSchema: vhInput }, async ({ query, top, from, to }) =>
    runRead(async () => (await std()).nonChargeableOrders(query, { top, from, to })),
  );
  server.registerTool(
    "std_sales_order_items",
    { description: "Items (RKDPOS) of a chargeable sales order.", inputSchema: { salesOrder: z.string(), ...rangeSchema } },
    async ({ salesOrder, from, to }) => runRead(async () => (await std()).salesOrderItems(salesOrder, { from, to })),
  );
  server.registerTool("std_worklist", { description: "Worklist (assigned orders) for a date range.", inputSchema: rangeSchema }, async ({ from, to }) =>
    runRead(async () => {
      const r = defaultRange(from, to);
      return (await std()).worklist(r.from, r.to);
    }),
  );
  server.registerTool(
    "std_fill",
    {
      description:
        "Book the same item on several days (one entry per day). Give either `item` (attendance type and/or order) or `favorite` (name or id). Hours default to the favorite's hours, else 8. Entries are released (and, on auto-approving profiles, approved) on save. Returns one result per day with the counter; isError when any day was rejected.",
      inputSchema: {
        dates: z.array(dateSchema).min(1).describe("Days to book, YYYY-MM-DD"),
        item: itemSchema.optional(),
        favorite: z.string().optional().describe("Favorite name or id to take the item (and default hours) from"),
        hours: z.number().positive().optional(),
        shortText: z.string().max(40).optional(),
        notes: z.string().optional(),
        release: z.boolean().optional().describe("default true; false omits the release flag, which auto-approving profiles ignore"),
      },
    },
    async ({ dates, item, favorite, hours, shortText, notes, release }) =>
      run(async () => {
        const ts = await std();
        const { it, h } = await resolveItem(ts, item, favorite, hours);
        const results = await ts.fill(dates, it, h ?? 8, { release: release ?? true, shortText, notes });
        if (results.some((r) => !r.ok)) throw new TimesheetError(JSON.stringify(results, null, 2));
        return results;
      }),
  );
  server.registerTool(
    "std_remove",
    {
      description: "Delete entries by counter (from std_entries / std_open_days). The entries must lie within from/to (default: current month).",
      inputSchema: { counters: z.array(z.string()).min(1), ...rangeSchema },
    },
    async ({ counters, from, to }) =>
      run(async () => {
        const r = defaultRange(from, to);
        const results = await (await std()).remove(counters, r);
        if (results.some((x) => !x.ok)) throw new TimesheetError(JSON.stringify(results, null, 2));
        return results;
      }),
  );
  server.registerTool(
    "std_update",
    {
      description: "Change hours / item of an existing entry.",
      inputSchema: { counter: z.string(), date: dateSchema, item: itemSchema, hours: z.number().positive(), shortText: z.string().optional(), release: z.boolean().optional() },
    },
    async ({ counter, date, item, hours, shortText, release }) =>
      run(async () => {
        const results = await (await std()).update([{ counter, date, item: item as EntryItem, hours, shortText, release: release ?? true }]);
        if (results.some((x) => !x.ok)) throw new TimesheetError(JSON.stringify(results, null, 2));
        return results;
      }),
  );

  server.registerTool(
    "std_days",
    { description: "Every working day of the range with filled/missing state, target/booked/missing hours and entries. Use it to tell which days are done and which are missing. Default range: current month.", inputSchema: rangeSchema },
    async ({ from, to }) =>
      runRead(async () => {
        const r = defaultRange(from, to);
        return (await std()).days(r.from, r.to);
      }),
  );
  server.registerTool(
    "std_set",
    {
      description: "Make the given days contain exactly one item (jobcode / absence type): existing entries on those days are deleted, then the item is booked. Give `item` or `favorite`.",
      inputSchema: { dates: z.array(dateSchema).min(1), item: itemSchema.optional(), favorite: z.string().optional(), hours: z.number().positive().optional(), shortText: z.string().max(40).optional(), release: z.boolean().optional(), dryRun: dryRunSchema },
    },
    async ({ dates, item, favorite, hours, shortText, release, dryRun }) =>
      run(async () => {
        const ts = await std();
        const { it, h } = await resolveItem(ts, item, favorite, hours);
        if (dryRun) return { dryRun: true, ...(await ts.planSet(dates, it, h ?? 8)) };
        const res = await ts.set(dates, it, h ?? 8, { shortText, release: release ?? true });
        if ([...res.removed, ...res.created].some((r) => !r.ok)) throw new TimesheetError(JSON.stringify(res, null, 2));
        return res;
      }),
  );
  server.registerTool(
    "std_jobcodes",
    {
      description: "Which jobcodes (orders, sales orders, attendance types) the range contains, with number of days, hours, dates and share. Pass `codes` to check for specific ones (empty result = not present).",
      inputSchema: { ...rangeSchema, codes: z.array(z.string()).optional().describe("Order / sales order / attendance type codes to look for") },
    },
    async ({ from, to, codes }) =>
      runRead(async () => {
        const r = defaultRange(from, to);
        return (await std()).jobcodes(r.from, r.to, { codes });
      }),
  );
  server.registerTool(
    "std_staffing",
    { description: "The MDS staffing plan for the range (planned entries, status Planned) — what the app's 'Retrieve staffing' button loads. Use std_staffing_apply to book it.", inputSchema: rangeSchema },
    async ({ from, to }) =>
      runRead(async () => {
        const r = defaultRange(from, to);
        return (await std()).staffing(r.from, r.to);
      }),
  );
  server.registerTool(
    "std_staffing_apply",
    {
      description: "Book the staffing plan: creates the planned entries on open days that still miss the planned hours; returns created + skipped (with reasons). Optional `dates` restricts the days.",
      inputSchema: { ...rangeSchema, dates: z.array(dateSchema).optional(), release: z.boolean().optional(), dryRun: dryRunSchema },
    },
    async ({ from, to, dates, release, dryRun }) =>
      run(async () => {
        const r = defaultRange(from, to);
        if (dryRun) return { dryRun: true, ...(await (await std()).planStaffing(r.from, r.to, { dates })) };
        const res = await (await std()).applyStaffing(r.from, r.to, { dates, release: release ?? true });
        if (res.created.some((x) => !x.ok)) throw new TimesheetError(JSON.stringify(res, null, 2));
        return res;
      }),
  );
  server.registerTool(
    "std_fill_open",
    {
      description: "Quick action: book one item on every open day of the range, each with that day's missing hours (optionally capped). E.g. fill the whole open period with admin code 0077, or with a jobcode.",
      inputSchema: { ...rangeSchema, item: itemSchema.optional(), favorite: z.string().optional(), maxHours: z.number().positive().optional(), shortText: z.string().max(40).optional(), release: z.boolean().optional(), dryRun: dryRunSchema },
    },
    async ({ from, to, item, favorite, maxHours, shortText, release, dryRun }) =>
      run(async () => {
        const ts = await std();
        const r = defaultRange(from, to);
        const { it: picked } = await resolveItem(ts, item, favorite, undefined);
        const it = await ts.resolveSalesOrderItem(picked, { from: r.from, to: r.to }); // auto-fill RKDPOS when the sales order has exactly one item
        if (dryRun) return { dryRun: true, item: it, days: await ts.planFillOpen(r.from, r.to, it, { maxHours }) };
        const res = await ts.fillOpen(r.from, r.to, it, { maxHours, shortText, release: release ?? true });
        if (res.some((x) => !x.ok)) throw new TimesheetError(JSON.stringify(res, null, 2));
        return res;
      }),
  );

  // ---------------- multiproject ----------------
  const ym = { year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) };
  server.registerTool("mp_months", { description: "Multiproject timesheet: months with status (YACTION open / PER_CLOSED) and totals.", inputSchema: {} }, async () =>
    runRead(async () => (await mp()).months()),
  );
  server.registerTool(
    "mp_month",
    { description: "Multiproject timesheet grid of a month: projects (columns) and days with hours per project.", inputSchema: ym },
    async ({ year, month }) => runRead(async () => (await mp()).month(year, month)),
  );
  server.registerTool("mp_favorites", { description: "Favorites as listed by the multiproject app.", inputSchema: {} }, async () => runRead(async () => (await mp()).favorites()));
  server.registerTool(
    "mp_allocate",
    {
      description:
        "Allocate hours per day to a project in the multiproject timesheet (creates the project column if needed; existing cells are updated; hours 0 clears a day). Locks the timesheet during the save like the app. Returns the refreshed month.",
      inputSchema: {
        ...ym,
        project: itemSchema,
        days: z.array(z.object({ date: dateSchema, hours: z.number().min(0), text: z.string().max(40).optional() })).min(1),
      },
    },
    async ({ year, month, project, days }) => run(async () => (await mp()).allocate(year, month, project as EntryItem, days)),
  );
  const rangeObj = z.object({ from: dateSchema, to: dateSchema });
  server.registerTool(
    "mp_allocate_many",
    {
      description: "Several projects in one save: each slot is a project with explicit `days` and/or a `range` (working days) at `hours` per day. E.g. every working day of a range: 2h on X and 6h on Y.",
      inputSchema: {
        ...ym,
        slots: z
          .array(z.object({ project: itemSchema, days: z.array(z.object({ date: dateSchema, hours: z.number().min(0), text: z.string().max(40).optional() })).optional(), range: rangeObj.optional(), hours: z.number().min(0).optional(), text: z.string().max(40).optional() }))
          .min(1),
        dryRun: dryRunSchema,
      },
    },
    async ({ year, month, slots, dryRun }) =>
      run(async () => {
        const m = await mp();
        const resolved = slots.map((s) => ({ ...s, project: s.project as EntryItem }));
        if (dryRun) return { dryRun: true, ...(await m.previewAllocateMany(year, month, resolved)) };
        return m.allocateMany(year, month, resolved);
      }),
  );
  server.registerTool(
    "mp_stats",
    { description: "Which projects a day / date range / whole month contains in the multiproject timesheet, with hours, days and proportion (%).", inputSchema: { ...ym, ...rangeSchema } },
    async ({ year, month, from, to }) => runRead(async () => (await mp()).stats(year, month, { from, to })),
  );
  server.registerTool(
    "mp_balance",
    {
      description:
        "Rewrite the working days of a range so the given projects hold the requested proportions of the target hours (shares must add up to 100), e.g. 60% X / 40% Y over two weeks. " +
        "mode 'whole-days' (default): consecutive whole days per project, one day split where a quota ends; mode 'every-day': every day split by the shares. " +
        "Other projects' hours on those days are cleared. Use dryRun to preview the per-day plan first. Returns the plan (dryRun) or the resulting stats.",
      inputSchema: {
        ...ym,
        range: rangeObj,
        slots: z.array(z.object({ project: itemSchema, share: z.number().min(0).max(100) })).min(1),
        mode: z.enum(BALANCE_MODES as [string, ...string[]]).optional().describe("whole-days (default) | every-day"),
        dryRun: dryRunSchema,
      },
    },
    async ({ year, month, range, slots, mode, dryRun }) =>
      run(async () => {
        const m = await mp();
        const shareSlots = slots.map((s) => ({ project: s.project as EntryItem, share: s.share }));
        const opts = { mode: (mode ?? "whole-days") as "whole-days" | "every-day" };
        if (dryRun) return { dryRun: true, ...(await m.previewBalance(year, month, range, shareSlots, opts)) };
        await m.balance(year, month, range, shareSlots, opts);
        return { mode: opts.mode, ...(await m.stats(year, month, range)) };
      }),
  );
  server.registerTool(
    "mp_clear",
    { description: "Remove a project's hours on the given days (all days of the month if omitted).", inputSchema: { ...ym, project: itemSchema, dates: z.array(dateSchema).optional() } },
    async ({ year, month, project, dates }) => run(async () => (await mp()).clear(year, month, project as EntryItem, dates)),
  );

  return server;
}

async function resolveItem(ts: StandardTimesheet, item: Record<string, unknown> | undefined, favorite: string | undefined, hours: number | undefined): Promise<{ it: EntryItem; h: number | undefined }> {
  let it: EntryItem = { ...(item ?? {}) } as EntryItem;
  let h = hours;
  if (favorite) {
    const favs = await ts.favorites();
    const f = favs.find((x) => x.id === favorite || x.name.toLowerCase() === favorite.toLowerCase());
    if (!f) throw new TimesheetError(`No favorite "${favorite}". Known favorites: ${favs.map((x) => x.name).join(", ")}`);
    it = { ...f.item, ...it };
    h ??= f.hours;
  }
  if (!it.attendanceType && !it.order && !it.salesOrder) throw new TimesheetError("Give an item (attendance type or an order) or a favorite.");
  return { it, h };
}

const INSTRUCTIONS = `xflow-timesheet gives access to the BearingPoint xflow SAP timesheets.
Workflow: session_status → (sso_login if not logged in: silent when the browser profile still remembers the sign-in, otherwise the user signs in in a browser window) → std_days / std_open_days to see what is filled or missing →
std_favorites / std_chargeable_orders / std_non_chargeable_orders / std_attendance_types to find what to book →
std_fill / std_set / std_fill_open / std_staffing_apply to book days (or mp_allocate / mp_allocate_many / mp_balance for the multiproject grid; mp_stats and std_jobcodes report what is booked). Codes: attendance type 0010 = holiday, 0800 = chargeable hours,
0081 = NCH order; chargeable work needs salesOrder + salesOrderItem, non-chargeable work needs order (+ attendanceType 0081 typically).`;
