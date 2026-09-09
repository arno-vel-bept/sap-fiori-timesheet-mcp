import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CLIENTS, clientConfigPath, mcpServerEntry, mergeMcpConfig, writeMcpConfig } from "../src/install/mcp-config.js";
import { runCli } from "../src/cli/main.js";

describe("MCP install helpers", () => {
  it("knows the config file of each supported client", () => {
    const home = "/Users/me";
    expect(clientConfigPath("claude-desktop", { home, platform: "darwin" })).toBe(join(home, "Library/Application Support/Claude/claude_desktop_config.json"));
    expect(clientConfigPath("claude-desktop", { home: "C:\\Users\\me", platform: "win32", appData: "C:\\Users\\me\\AppData\\Roaming" })).toMatch(/AppData[\\/]Roaming[\\/]Claude[\\/]claude_desktop_config\.json$/);
    expect(clientConfigPath("claude-code", { home, platform: "darwin" })).toBe(join(home, ".claude.json"));
    expect(clientConfigPath("cursor", { home, platform: "darwin" })).toBe(join(home, ".cursor/mcp.json"));
    expect(clientConfigPath("vscode", { home, platform: "darwin" })).toBe(join(home, "Library/Application Support/Code/User/mcp.json"));
    expect(CLIENTS).toEqual(["claude-code", "claude-desktop", "cursor", "vscode"]);
  });

  it("builds a server entry that runs the installed binary (or node + dist for a checkout)", () => {
    expect(mcpServerEntry({ binPath: "/usr/local/bin/xflow-timesheet-mcp" })).toEqual({ command: "/usr/local/bin/xflow-timesheet-mcp", args: [] });
    expect(mcpServerEntry({ binPath: "/repo/bin/xflow-timesheet-mcp.js", nodePath: "/usr/bin/node" })).toEqual({ command: "/usr/bin/node", args: ["/repo/bin/xflow-timesheet-mcp.js"] });
    expect(mcpServerEntry({ binPath: "/x", env: { XFLOW_SESSION_FILE: "/s.json" } })).toMatchObject({ env: { XFLOW_SESSION_FILE: "/s.json" } });
  });

  it("merges into mcpServers (Claude / Cursor) or servers (VS Code) without touching other keys, idempotently", () => {
    const entry = { command: "xflow-timesheet-mcp", args: [] };
    const merged = mergeMcpConfig({ other: 1, mcpServers: { foo: { command: "foo" } } }, "xflow-timesheet", entry, "cursor");
    expect(merged).toEqual({ other: 1, mcpServers: { foo: { command: "foo" }, "xflow-timesheet": entry } });
    expect(mergeMcpConfig(merged, "xflow-timesheet", entry, "cursor")).toEqual(merged);
    expect(mergeMcpConfig({}, "xflow-timesheet", entry, "vscode")).toEqual({ servers: { "xflow-timesheet": { type: "stdio", ...entry } } });
    expect(mergeMcpConfig(undefined, "xflow-timesheet", entry, "claude-code")).toEqual({ mcpServers: { "xflow-timesheet": entry } });
  });

  it("writes the config file, creating it or preserving existing content", () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-install-"));
    const file = join(dir, "nested", "mcp.json");
    const res = writeMcpConfig(file, "xflow-timesheet", { command: "x", args: [] }, "cursor");
    expect(res.created).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["xflow-timesheet"].command).toBe("x");
    writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: "k" } }, theme: "dark" }));
    const res2 = writeMcpConfig(file, "xflow-timesheet", { command: "y", args: [] }, "cursor");
    expect(res2.created).toBe(false);
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j.theme).toBe("dark");
    expect(j.mcpServers.keep.command).toBe("k");
    expect(j.mcpServers["xflow-timesheet"].command).toBe("y");
    expect(existsSync(file + ".bak")).toBe(true);
  });

  it("refuses to overwrite a config file that is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-install-"));
    const file = join(dir, "mcp.json");
    writeFileSync(file, "{ not json");
    expect(() => writeMcpConfig(file, "xflow-timesheet", { command: "x", args: [] }, "cursor")).toThrow(/not valid JSON/);
  });
});

async function cli(args: string[], env: Record<string, string> = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c.toString()));
  stderr.on("data", (c) => (err += c.toString()));
  const code = await runCli(args, { env, stdin: new PassThrough(), stdout, stderr });
  return { code, out, err };
}

describe("xflow-timesheet install-mcp", () => {
  it("--print shows the JSON snippet for a client without writing anything", async () => {
    const r = await cli(["install-mcp", "--client", "claude-desktop", "--print"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('"mcpServers"');
    expect(r.out).toContain('"xflow-timesheet"');
    expect(r.out).toMatch(/xflow-timesheet-mcp/);
  });

  it("--config-path writes the entry into the given file and reports it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-install-"));
    const file = join(dir, "mcp.json");
    const r = await cli(["install-mcp", "--client", "cursor", "--config-path", file]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Added "xflow-timesheet"/);
    expect(r.out).toContain(file);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["xflow-timesheet"]).toBeDefined();
    expect(r.out).toMatch(/restart/i);
  });

  it("rejects an unknown client", async () => {
    const r = await cli(["install-mcp", "--client", "emacs", "--print"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/claude-code|claude-desktop|cursor|vscode/);
  });
});

describe("xflow-timesheet doctor", () => {
  it("reports node, session, browser and MCP config status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xflow-doctor-"));
    const r = await cli(["doctor"], { XFLOW_SESSION_FILE: join(dir, "none.json"), HOME: dir });
    expect([0, 1]).toContain(r.code);
    expect(r.out).toMatch(/Node/);
    expect(r.out).toMatch(/Session.*(no session|missing)/i);
    expect(r.out).toMatch(/Browser/);
    expect(r.out).toMatch(/MCP/);
  });
});
