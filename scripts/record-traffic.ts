/**
 * Dev tool: opens a Fiori intent in headless Chromium using the stored session
 * cookies and records every OData request/response the app makes.
 *
 *   pnpm exec tsx scripts/record-traffic.ts '#MultiprojectTimesheet-manage' out.json [waitSeconds]
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { resolveConfig } from "../src/config.js";
import { SessionStore } from "../src/auth/session-store.js";

const [intent = "#Shell-home", outFile = "traffic.json", waitS = "25"] = process.argv.slice(2);
const cfg = resolveConfig();
const session = await new SessionStore(cfg.sessionFile).load();
if (!session) throw new Error("No session; run login first");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await ctx.addCookies(session.cookies.map((c) => ({ ...c, expires: c.expires ?? -1, sameSite: c.sameSite ?? "Lax" })));
const page = await ctx.newPage();
const records: unknown[] = [];
page.on("response", async (res) => {
  const req = res.request();
  const url = req.url();
  if (!/\/sap\/opu\/odata\//.test(url)) return;
  let body: string | null = null;
  try {
    body = await res.text();
  } catch {
    body = null;
  }
  records.push({
    method: req.method(),
    url,
    status: res.status(),
    requestHeaders: pick(req.headers(), ["content-type", "accept", "x-csrf-token", "x-requested-with", "sap-contextid-accept", "maxdataserviceversion"]),
    requestBody: req.postData(),
    responseHeaders: pick(res.headers(), ["content-type", "x-csrf-token", "dataserviceversion", "sap-contextid"]),
    body: body && body.length > 200_000 ? body.slice(0, 200_000) + "…[truncated]" : body,
  });
});
const base = cfg.launchpadUrl.split("#")[0];
await page.goto(`${base}${intent}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(Number(waitS) * 1000);
await page.screenshot({ path: outFile.replace(/\.json$/, ".png"), fullPage: true });
writeFileSync(outFile, JSON.stringify({ intent, url: page.url(), title: await page.title(), records }, null, 2));
console.log(`${records.length} OData responses recorded to ${outFile} (page: ${page.url()})`);
await browser.close();

function pick(h: Record<string, string>, keys: string[]) {
  return Object.fromEntries(Object.entries(h).filter(([k]) => keys.includes(k.toLowerCase())));
}
