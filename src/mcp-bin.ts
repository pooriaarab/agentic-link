#!/usr/bin/env node
import { VERSION } from "./version.js";

const HELP = `agentic-link-mcp ${VERSION}
Usage: agentic-link-mcp [--help | --version]

Runs the MCP server on stdio. An MCP client starts it; it takes no other arguments.
`;

const flag = process.argv[2];
if (flag === "--version" || flag === "-V") {
  console.log(VERSION);
} else if (flag === "--help" || flag === "-h") {
  console.log(HELP);
} else {
  // Loaded only when serving, so --help and --version never pay for the server's imports.
  import("./mcp.js")
    .then(({ startMcp }) => startMcp())
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
