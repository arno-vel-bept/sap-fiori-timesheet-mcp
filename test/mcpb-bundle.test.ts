import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Builds the MCPB bundle with esbuild only (`--no-install`: no network, ~1s) and drives the
 * bundled entry point over raw stdio. The load-bearing assertion is that stdout carries
 * *only* well-formed JSON-RPC — that is what breaks if anything (a stray console.log, the
 * Playwright browser installer, a dependency's banner) writes to fd 1 in the server.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "build", "mcpb", "server", "index.js");

describe("MCPB bundle", () => {
  beforeAll(() => {
    const r = spawnSync(process.execPath, [join(root, "scripts", "build-mcpb.mjs"), "--no-install"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(entry), "bundle entry point was not produced").toBe(true);
  }, 60_000);

  it("speaks the MCP handshake and emits nothing but JSON-RPC on stdout", async () => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...process.env, XFLOW_SESSION_FILE: "/nonexistent/session.json" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    // Wait until we have seen the response to id:2, or the child dies, or we time out.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; stdout=${JSON.stringify(stdout)} stderr=${stderr}`)), 20_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early (code ${code}); stderr=${stderr}`));
      });
      const poll = setInterval(() => {
        if (stdout.split("\n").some((l) => l.trim() && safeParse(l)?.id === 2)) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
    });

    child.stdin.end();
    child.kill();

    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const msg = safeParse(line);
      expect(msg, `non-JSON on stdout: ${JSON.stringify(line)}`).not.toBeNull();
      expect(msg.jsonrpc, `not a JSON-RPC frame: ${line}`).toBe("2.0");
    }

    const toolsMsg = lines.map(safeParse).find((m) => m?.id === 2);
    const names: string[] = toolsMsg.result.tools.map((t: any) => t.name);
    expect(names).toContain("std_fill");
    expect(names).toContain("mp_balance");
    expect(names.length).toBe(35); // 34 timesheet/session tools + sso_login
  });

  afterAll(() => {});
});

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
