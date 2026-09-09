import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("MCP stdio entry point", () => {
  it("starts over stdio (pnpm mcp) and lists tools", async () => {
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["exec", "tsx", "src/mcp/run.ts"],
      cwd: process.cwd(),
      env: { ...process.env, XFLOW_SESSION_FILE: "/nonexistent/session.json" } as Record<string, string>,
    });
    const client = new Client({ name: "smoke", version: "0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("std_fill");
      const status = (await client.callTool({ name: "session_status", arguments: {} })) as { content: { text?: string }[] };
      expect(JSON.parse(status.content[0].text!)).toMatchObject({ loggedIn: false });
    } finally {
      await client.close();
    }
  });
});
