import { describe, expect, it } from "vitest";
import { DEFAULT_LAUNCHPAD_URL, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("falls back to defaults when the env is empty", () => {
    const c = resolveConfig({});
    expect(c.launchpadUrl).toBe(DEFAULT_LAUNCHPAD_URL);
    expect(c.baseUrl).toBe("https://xflow.bearingpoint.com");
    expect(c.language).toBe("EN");
    expect(c.email).toBeUndefined();
  });

  it("reads values from the env", () => {
    const c = resolveConfig({
      XFLOW_LAUNCHPAD_URL: "https://fiori.example.com/flp#Shell-home",
      XFLOW_EMAIL: "me@example.com",
      XFLOW_PASSWORD: "pw",
      XFLOW_SAP_CLIENT: "006",
      XFLOW_LANGUAGE: "DE",
    });
    expect(c.baseUrl).toBe("https://fiori.example.com");
    expect(c.email).toBe("me@example.com");
    expect(c.sapClient).toBe("006");
    expect(c.language).toBe("DE");
  });

  it("treats a blank/whitespace env var the same as unset (MCPB expands cleared user_config to \"\")", () => {
    const c = resolveConfig({
      XFLOW_LAUNCHPAD_URL: "",
      XFLOW_EMAIL: "   ",
      XFLOW_PASSWORD: "",
      XFLOW_SAP_CLIENT: "",
      XFLOW_LANGUAGE: "",
    });
    // The bug this guards: new URL("") threw before the empty string was coerced away.
    expect(c.launchpadUrl).toBe(DEFAULT_LAUNCHPAD_URL);
    expect(c.baseUrl).toBe("https://xflow.bearingpoint.com");
    expect(c.email).toBeUndefined();
    expect(c.password).toBeUndefined();
    expect(c.sapClient).toBeUndefined();
    expect(c.language).toBe("EN");
  });

  it("still lets explicit overrides win", () => {
    const c = resolveConfig({ XFLOW_LAUNCHPAD_URL: "" }, { launchpadUrl: "https://o.example/flp#x" });
    expect(c.baseUrl).toBe("https://o.example");
  });
});
