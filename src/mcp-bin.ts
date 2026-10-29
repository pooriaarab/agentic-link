#!/usr/bin/env node
import { infoFlag } from "./flags.js";
import { VERSION } from "./version.js";

const HELP = `agentic-link-mcp ${VERSION}
Usage: agentic-link-mcp [--help | --version]

Runs the MCP server on stdio. An MCP client starts it.
`;

const ask = infoFlag(process.argv.slice(2));
if (ask === "version") {
  process.stdout.write(`${VERSION}\n`);
} else if (ask === "help") {
  process.stdout.write(HELP);
} else {
  // Loaded only when serving, so --help and --version never pay for the server's imports.
  import("./mcp.js")
    .then(({ startMcp }) => startMcp())
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
