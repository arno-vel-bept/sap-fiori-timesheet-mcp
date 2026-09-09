import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFakeIdp, type FakeIdp } from "./fixtures/fake-idp.js";
import { LoginFlow } from "../src/auth/login-flow.js";

let browser: Browser;
let idp: FakeIdp;
beforeAll(async () => {
  browser = await chromium.launch();
  idp = await startFakeIdp({ email: "arno@example.com", password: "s3cret", otp: "123456" });
});
afterAll(async () => {
  await browser.close();
  await idp.close();
});

describe("LoginFlow (step-wise login for MCP clients)", () => {
  it("pauses at otp_required and completes after submitOtp", async () => {
    const flow = new LoginFlow({ launchpadUrl: idp.launchpadUrl, browser });
    const first = await flow.start({ email: "arno@example.com", password: "s3cret" });
    expect(first.state).toBe("otp_required");
    if (first.state !== "otp_required") throw new Error("unreachable");
    expect(first.prompt).toMatch(/code/i);

    const second = await flow.submitOtp("123456");
    expect(second.state).toBe("done");
    if (second.state !== "done") throw new Error("unreachable");
    expect(second.session.cookies.some((c) => c.name === "xflow_session")).toBe(true);
  });

  it("stays at otp_required with the error when the code is wrong", async () => {
    const flow = new LoginFlow({ launchpadUrl: idp.launchpadUrl, browser });
    await flow.start({ email: "arno@example.com", password: "s3cret" });
    const retry = await flow.submitOtp("000000");
    expect(retry.state).toBe("otp_required");
    if (retry.state !== "otp_required") throw new Error("unreachable");
    expect(retry.prompt).toMatch(/expected verification code/i);
    const done = await flow.submitOtp("123456");
    expect(done.state).toBe("done");
  });

  it("returns an error state for a bad password", async () => {
    const flow = new LoginFlow({ launchpadUrl: idp.launchpadUrl, browser });
    const res = await flow.start({ email: "arno@example.com", password: "nope" });
    expect(res).toMatchObject({ state: "error", code: "bad_password" });
  });

  it("rejects submitOtp when no login is pending", async () => {
    const flow = new LoginFlow({ launchpadUrl: idp.launchpadUrl, browser });
    await expect(flow.submitOtp("123456")).rejects.toThrow(/no login in progress/i);
  });
});
