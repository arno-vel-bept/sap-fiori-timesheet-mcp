import { describe, expect, it, vi } from "vitest";
import { withBrowserInstalled, isMissingBrowserError } from "../src/auth/browser.js";

describe("automatic Playwright browser installation", () => {
  it("recognizes Playwright's missing-executable error", () => {
    expect(isMissingBrowserError(new Error("browserType.launch: Executable doesn't exist at /x/chrome\n╔══ Looks like Playwright Test or Playwright was just installed"))).toBe(true);
    expect(isMissingBrowserError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(false);
  });

  it("installs the browser once and retries when the launch fails for that reason", async () => {
    const install = vi.fn(async () => {});
    let calls = 0;
    const result = await withBrowserInstalled(
      async () => {
        calls++;
        if (calls === 1) throw new Error("browserType.launch: Executable doesn't exist at /nowhere");
        return "ok";
      },
      { install, onStatus: vi.fn() },
    );
    expect(result).toBe("ok");
    expect(install).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it("does not install for unrelated errors", async () => {
    const install = vi.fn(async () => {});
    await expect(withBrowserInstalled(async () => Promise.reject(new Error("boom")), { install })).rejects.toThrow("boom");
    expect(install).not.toHaveBeenCalled();
  });
});
