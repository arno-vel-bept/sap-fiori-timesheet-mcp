import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("package.json is npx-ready", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    bin: Record<string, string>;
  };

  it("is named after the published npm package so `npx <name>` resolves it", () => {
    expect(pkg.name).toBe("sap-fiori-timesheet-mcp");
  });

  it("has a bin entry matching the package name, so npx runs it with no subcommand (like @playwright/mcp)", () => {
    expect(pkg.bin["sap-fiori-timesheet-mcp"]).toBe("bin/xflow-timesheet-mcp.js");
  });

  it("still exposes the CLI and the plain mcp bin for direct/global installs", () => {
    expect(pkg.bin["xflow-timesheet"]).toBe("bin/xflow-timesheet.js");
    expect(pkg.bin["xflow-timesheet-mcp"]).toBe("bin/xflow-timesheet-mcp.js");
  });
});
