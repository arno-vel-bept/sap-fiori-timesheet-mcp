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

  it("treats an unexpanded ${user_config.X} placeholder the same as unset", () => {
    // The host has been observed doing both things with an optional user_config field that
    // has no default and was left blank: expanding it to "" (the case above) and — per issue
    // #8 — passing the literal, unexpanded placeholder through. A literal ${...} is never a
    // valid value for any of these fields, and it must not reach a URL: an unresolved
    // ${user_config.sap_client} became a bogus sap-client on the session probe and turned a
    // healthy 200 into a 401 (and ${user_config.email} would be typed into the SSO form).
    const c = resolveConfig({
      XFLOW_LAUNCHPAD_URL: "${user_config.launchpad_url}",
      XFLOW_EMAIL: "${user_config.email}",
      XFLOW_PASSWORD: "${user_config.password}",
      XFLOW_SAP_CLIENT: "${user_config.sap_client}",
      XFLOW_LANGUAGE: "${user_config.language}",
    });
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
