#!/usr/bin/env node
import { startMcp } from "./mcp.js";

startMcp().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
