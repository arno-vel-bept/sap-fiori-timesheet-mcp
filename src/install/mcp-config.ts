import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const CLIENTS = ["claude-code", "claude-desktop", "cursor", "vscode"] as const;
export type McpClient = (typeof CLIENTS)[number];

export interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Where each client keeps its user-level MCP configuration. */
export function clientConfigPath(client: McpClient, ctx: { home?: string; platform?: NodeJS.Platform; appData?: string } = {}): string {
  const home = ctx.home ?? homedir();
  const platform = ctx.platform ?? process.platform;
  const appData = ctx.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const userDir = (app: string) => {
    if (platform === "darwin") return join(home, "Library", "Application Support", app);
    if (platform === "win32") return join(appData, app);
    return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), app);
  };
  switch (client) {
    case "claude-code":
      return join(home, ".claude.json");
    case "claude-desktop":
      return join(userDir("Claude"), "claude_desktop_config.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "vscode":
      return join(userDir("Code"), "User", "mcp.json");
  }
}

/**
 * The entry to register. A globally installed binary is used directly; a `.js`
 * path (repo checkout) is run through node so the shebang is not needed.
 */
export function mcpServerEntry(opts: { binPath: string; nodePath?: string; env?: Record<string, string> }): ServerEntry {
  const entry: ServerEntry = opts.binPath.endsWith(".js") ? { command: opts.nodePath ?? process.execPath, args: [opts.binPath] } : { command: opts.binPath, args: [] };
  if (opts.env && Object.keys(opts.env).length) entry.env = opts.env;
  return entry;
}

/**
 * The entry to register when the package is published to npm: runs it via
 * `npx -y <name>@<version>` with no local install, the way most MCP servers
 * (e.g. @playwright/mcp) are configured.
 */
export function npxServerEntry(opts: { packageName: string; version?: string; env?: Record<string, string> }): ServerEntry {
  const entry: ServerEntry = { command: "npx", args: ["-y", `${opts.packageName}@${opts.version ?? "latest"}`] };
  if (opts.env && Object.keys(opts.env).length) entry.env = opts.env;
  return entry;
}

/** Adds/replaces the server in the client's config object; VS Code uses `servers` + type, the others `mcpServers`. */
export function mergeMcpConfig(existing: unknown, name: string, entry: ServerEntry, client: McpClient): Record<string, unknown> {
  const base: Record<string, unknown> = existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  const key = client === "vscode" ? "servers" : "mcpServers";
  const servers = { ...((base[key] as Record<string, unknown> | undefined) ?? {}) };
  servers[name] = client === "vscode" ? { type: "stdio", ...entry } : entry;
  base[key] = servers;
  return base;
}

/** Writes the merged config (keeping a .bak of the previous file). Refuses to clobber unparsable files. */
export function writeMcpConfig(file: string, name: string, entry: ServerEntry, client: McpClient): { created: boolean; config: Record<string, unknown> } {
  let existing: unknown;
  const created = !existsSync(file);
  if (!created) {
    const raw = readFileSync(file, "utf8");
    try {
      existing = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`${file} is not valid JSON; fix it (or pass --print and add the entry by hand).`);
    }
    copyFileSync(file, `${file}.bak`);
  }
  const config = mergeMcpConfig(existing, name, entry, client);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return { created, config };
}

/** Human hints per client, shown after writing. */
export function afterInstallHint(client: McpClient): string {
  switch (client) {
    case "claude-code":
      return 'Restart Claude Code (or start a new session); check with "claude mcp list".';
    case "claude-desktop":
      return "Quit and reopen Claude Desktop; the tools appear under the tools icon.";
    case "cursor":
      return "Restart Cursor (or reload the window); enable the server under Settings → MCP.";
    case "vscode":
      return "Reload the VS Code window; the server shows up in the Copilot Chat tools list.";
  }
}
