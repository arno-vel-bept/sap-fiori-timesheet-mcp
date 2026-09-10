import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { VERSION } from "../src/version.js";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const manifest = read("../manifest.json") as Record<string, any>;
const pkg = read("../package.json") as { name: string; version: string };

/** Every `${user_config.KEY}` / `${__dirname}` / `${HOME}` … token in a string. */
function templateKeys(v: unknown, acc = new Set<string>()): Set<string> {
  if (typeof v === "string") {
    for (const m of v.matchAll(/\$\{([^}]+)\}/g)) acc.add(m[1]);
  } else if (Array.isArray(v)) {
    for (const x of v) templateKeys(x, acc);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) templateKeys(x, acc);
  }
  return acc;
}

describe("MCPB manifest.json", () => {
  it("declares the required top-level fields for manifest spec 0.3", () => {
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.description).toBeTruthy();
    expect(manifest.author?.name).toBeTruthy();
    expect(manifest.server).toBeTruthy();
  });

  it("keeps the version in lockstep with package.json and src/version.ts", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });

  it("runs a bundled Node server over stdio from the extension directory", () => {
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("server/index.js");
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args).toContain("${__dirname}/server/index.js");
  });

  it("only references user_config keys that are actually defined", () => {
    const defined = new Set(Object.keys(manifest.user_config ?? {}));
    const allowed = new Set(["__dirname", "HOME", "DESKTOP", "DOCUMENTS", "DOWNLOADS", "pathSeparator", "/"]);
    for (const key of templateKeys(manifest.server.mcp_config)) {
      const bare = key.replace(/^user_config\./, "");
      if (key.startsWith("user_config.")) expect(defined, `undefined user_config.${bare}`).toContain(bare);
      else expect(allowed, `unknown template \${${key}}`).toContain(key);
    }
  });

  it("gives every user_config field a type and a title; marks the password sensitive", () => {
    for (const [name, cfg] of Object.entries<any>(manifest.user_config ?? {})) {
      expect(["string", "number", "boolean", "directory", "file"], name).toContain(cfg.type);
      expect(cfg.title, name).toBeTruthy();
      if (cfg.sensitive) expect(cfg.type, `${name} sensitive must be a string`).toBe("string");
    }
    expect(manifest.user_config.password.sensitive).toBe(true);
    expect(manifest.user_config.email.sensitive ?? false).toBe(false);
  });

  it("lists exactly the tools the server registers — no more, no less", async () => {
    const server = createMcpServer({ env: { XFLOW_SESSION_FILE: "/nonexistent/session.json" } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "manifest-parity", version: "0" });
    await client.connect(ct);
    try {
      const registered = new Set((await client.listTools()).tools.map((t) => t.name));
      const declared = new Set<string>((manifest.tools ?? []).map((t: any) => t.name));
      expect([...declared].sort()).toEqual([...registered].sort());
      for (const t of manifest.tools ?? []) expect(t.description, `${t.name} needs a description`).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it("targets the platforms Claude Desktop runs on and Node >= 20", () => {
    expect(manifest.compatibility.runtimes.node).toMatch(/>=\s*(1[6-9]|2\d)/);
    for (const p of manifest.compatibility.platforms) expect(["darwin", "win32", "linux"]).toContain(p);
  });
});
