import type { Command } from "commander";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Env } from "../config.js";
import { SessionStore } from "../auth/session-store.js";
import { afterInstallHint, CLIENTS, clientConfigPath, mcpServerEntry, npxServerEntry, mergeMcpConfig, writeMcpConfig, type McpClient } from "../install/mcp-config.js";

export interface InstallContext {
  env: Env;
  out(s: string): void;
  err(s: string): void;
  cfg(): Config;
  fail(): void;
}

const SERVER_NAME = "xflow-timesheet";
/** The name this package is published under on npm (see package.json "bin"). */
const NPM_PACKAGE_NAME = "sap-fiori-timesheet-mcp";

/** Absolute path of the MCP launcher next to this package (works for global installs and checkouts). */
export function mcpBinPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // …/dist/cli or …/src/cli
  return resolve(here, "..", "..", "bin", "xflow-timesheet-mcp.js");
}

export function registerInstallCommands(program: Command, ctx: InstallContext): void {
  program
    .command("install-mcp")
    .description(`Register the MCP server with a client (${CLIENTS.join(", ")}) by editing its config file`)
    .requiredOption("-c, --client <client>", `one of ${CLIENTS.join(", ")}`)
    .option("--config-path <file>", "write to this file instead of the client's default location")
    .option("--print", "only print the JSON snippet, do not write", false)
    .option("--session-file-env", "pin XFLOW_SESSION_FILE in the entry to the current session path", false)
    .option("--npx", `run via "npx -y ${NPM_PACKAGE_NAME}" instead of a local binary path (works from anywhere, always fetches the latest published version; needs no prior install)`, false)
    .action((o: { client: string; configPath?: string; print: boolean; sessionFileEnv: boolean; npx: boolean }) => {
      if (!CLIENTS.includes(o.client as McpClient)) {
        ctx.err(`Unknown client "${o.client}". Use one of: ${CLIENTS.join(", ")}`);
        return ctx.fail();
      }
      const client = o.client as McpClient;
      const env: Record<string, string> = {};
      if (o.sessionFileEnv) env.XFLOW_SESSION_FILE = ctx.cfg().sessionFile;
      const entry = o.npx ? npxServerEntry({ packageName: NPM_PACKAGE_NAME, env }) : mcpServerEntry({ binPath: mcpBinPath(), env });
      if (o.print) {
        ctx.out(JSON.stringify(mergeMcpConfig({}, SERVER_NAME, entry, client), null, 2));
        return;
      }
      const file = o.configPath ?? clientConfigPath(client, { home: ctx.env.HOME });
      const res = writeMcpConfig(file, SERVER_NAME, entry, client);
      ctx.out(`${res.created ? "Created" : "Updated"} ${file}${res.created ? "" : " (backup: .bak)"}`);
      ctx.out(`Added "${SERVER_NAME}" → ${entry.command} ${entry.args.join(" ")}`.trim());
      ctx.out(afterInstallHint(client));
      ctx.out(`Then run "xflow-timesheet login" once if you have not yet; check everything with "xflow-timesheet doctor".`);
    });

  program
    .command("doctor")
    .description("Check the local setup: Node, stored session, login browser, MCP registrations")
    .action(async () => {
      const c = ctx.cfg();
      const rows: [string, string, boolean][] = [];
      const [major] = process.versions.node.split(".").map(Number);
      rows.push(["Node", `${process.version}${major >= 20 ? "" : " (needs >= 20)"}`, major >= 20]);

      const session = await new SessionStore(c.sessionFile).load();
      rows.push(["Session", session ? `${c.sessionFile} (created ${session.createdAt})` : `no session at ${c.sessionFile} — run "xflow-timesheet login"`, Boolean(session)]);

      let browser = "not downloaded — downloads automatically on first login";
      let browserOk = true;
      try {
        const require = createRequire(import.meta.url);
        const { chromium } = require("playwright") as typeof import("playwright");
        const exe = chromium.executablePath();
        browserOk = existsSync(exe);
        browser = browserOk ? exe : browser;
      } catch (e) {
        browser = `playwright not resolvable: ${(e as Error).message}`;
        browserOk = false;
      }
      rows.push(["Browser", browser, true]);

      const bin = mcpBinPath();
      rows.push(["MCP launcher", `${bin}${existsSync(bin) ? "" : " (missing — run pnpm build?)"}`, existsSync(bin)]);
      for (const client of CLIENTS) {
        const file = clientConfigPath(client, { home: ctx.env.HOME });
        let state = "not configured";
        let ok = true;
        if (existsSync(file)) {
          try {
            const j = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")) as Record<string, Record<string, unknown>>;
            const servers = (client === "vscode" ? j.servers : j.mcpServers) ?? {};
            state = servers[SERVER_NAME] ? `registered in ${file}` : `not registered (${file})`;
          } catch {
            state = `${file} is not valid JSON`;
            ok = false;
          }
        }
        rows.push([`MCP ${client}`, state, ok]);
      }

      for (const [k, v, ok] of rows) ctx.out(`${ok ? "✓" : "✗"} ${k.padEnd(18)} ${v}`);
      if (rows.some(([, , ok]) => !ok)) ctx.fail();
      void browserOk;
    });
}
