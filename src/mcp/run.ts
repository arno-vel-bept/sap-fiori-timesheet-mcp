#!/usr/bin/env node
// stdio entry point: `pnpm mcp` (tsx) and bin/xflow-timesheet-mcp.js (dist).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

const server = createMcpServer();
await server.connect(new StdioServerTransport());
