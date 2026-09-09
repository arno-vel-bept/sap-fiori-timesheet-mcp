#!/usr/bin/env node
import { ensureBuilt } from "./_ensure-built.js";
ensureBuilt();
await import("../dist/mcp/run.js");
