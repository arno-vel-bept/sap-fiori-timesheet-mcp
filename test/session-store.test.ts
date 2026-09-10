import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionData } from "../src/auth/session-store.js";

const sample: SessionData = {
  launchpadUrl: "https://xflow.example.com/fiori/shells/abap/FioriLaunchpad.html#Shell-home",
  createdAt: "2026-09-09T10:00:00.000Z",
  cookies: [
    { name: "SAP_SESSIONID_X", value: "abc", domain: "xflow.example.com", path: "/", secure: true, httpOnly: true, expires: -1 },
  ],
};

describe("SessionStore", () => {
  it("returns null when no session has been saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-"));
    const store = new SessionStore(join(dir, "session.json"));
    expect(await store.load()).toBeNull();
  });

  it("round-trips a session and writes the file with owner-only permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-"));
    const file = join(dir, "nested", "session.json");
    const store = new SessionStore(file);
    await store.save(sample);
    expect(await store.load()).toEqual(sample);
    // POSIX file modes only; Windows has no 0o600 equivalent.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).cookies[0].name).toBe("SAP_SESSIONID_X");
  });

  it("clears a saved session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-"));
    const store = new SessionStore(join(dir, "session.json"));
    await store.save(sample);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("builds a Cookie header for a given URL from the saved cookies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-"));
    const store = new SessionStore(join(dir, "session.json"));
    await store.save({
      ...sample,
      cookies: [
        ...sample.cookies,
        { name: "other", value: "x", domain: "elsewhere.example.com", path: "/", secure: true, httpOnly: false, expires: -1 },
        { name: "MYSAPSSO2", value: "tok", domain: ".example.com", path: "/", secure: true, httpOnly: true, expires: -1 },
      ],
    });
    const header = await store.cookieHeaderFor("https://xflow.example.com/sap/opu/odata/sap/X/");
    expect(header).toContain("SAP_SESSIONID_X=abc");
    expect(header).toContain("MYSAPSSO2=tok");
    expect(header).not.toContain("other=x");
  });
});
