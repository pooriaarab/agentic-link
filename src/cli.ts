#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { decodeLink, describeError, encodeLink, listLinks, openLink, revokeLink, shortenLink, UsageError } from "./commands.js";
import { VERSION } from "./version.js";

const HELP = `agentic-link ${VERSION}

Share a document as a link.

  agentic-link encode --app <name> [--json <text> | --file <path> | stdin] [--base <url>]
                      [--password-env <VAR> | --password-file <path>]
  agentic-link decode [<link>] [--app <name>] [--password-env <VAR> | --password-file <path>]
  agentic-link shorten [<link>] [--endpoint <url>] [--ttl <seconds>]
  agentic-link open [<link>] [--app <name>] [--allow-host <host>]... [--password-env <VAR> | --password-file <path>]
  agentic-link revoke [<short id or url>] [--endpoint <url>]
  agentic-link list [--endpoint <url>]
  agentic-link mcp

A link is read from the argument, or from stdin when there is none.
Passwords are never taken from the command line, where process lists show them.
Environment: AGENTIC_LINK_ENDPOINT, AGENTIC_LINK_ALLOWED_HOSTS (comma-separated).
Keys are read from the environment only: AGENTIC_LINK_OWNER_KEY makes shorten links revocable and lets
revoke and list reach them; AGENTIC_LINK_ADMIN_KEY lets revoke and list reach any link.
Exit codes: 0 done, 1 the link or the service refused, 2 bad usage.
`;

const MAX_INPUT_BYTES = 1024 * 1024;
const VALUE_FLAGS = new Set([
  "--app",
  "--json",
  "--file",
  "--base",
  "--endpoint",
  "--ttl",
  "--password-env",
  "--password-file",
  "--allow-host",
]);

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string[]>;
}

function parse(argv: string[]): Parsed {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--password") {
      throw new UsageError(
        "--password is not accepted: argv shows in process lists. Use --password-env <VAR> or --password-file <path>.",
      );
    }
    if (arg.startsWith("--")) {
      if (!VALUE_FLAGS.has(arg)) throw new UsageError(`unknown flag ${arg}`);
      const value = rest[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      flags.set(arg, [...(flags.get(arg) ?? []), value]);
    } else positional.push(arg);
  }
  return { command, positional, flags };
}

const one = (parsed: Parsed, flag: string): string | undefined => parsed.flags.get(flag)?.at(-1);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) {
      process.stdin.destroy();
      throw new UsageError("input is over 1 MiB");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readFileCapped(path: string): string {
  try {
    if (statSync(path).size > MAX_INPUT_BYTES) throw new UsageError("file is over 1 MiB");
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`cannot read ${path}`);
  }
}

function passwordFrom(parsed: Parsed): string | undefined {
  const name = one(parsed, "--password-env");
  const file = one(parsed, "--password-file");
  if (name !== undefined && file !== undefined) throw new UsageError("give one of --password-env and --password-file");
  if (name !== undefined) {
    const value = process.env[name];
    if (!value) throw new UsageError(`environment variable ${name} is not set or is empty`);
    return value;
  }
  if (file !== undefined) {
    const value = readFileCapped(file).replace(/\r?\n$/, "");
    if (!value) throw new UsageError("password file is empty");
    return value;
  }
  return undefined;
}

async function linkFrom(parsed: Parsed): Promise<string> {
  const given = parsed.positional[0];
  const link = (given ?? (await readStdin())).trim();
  if (!link) throw new UsageError("no link given");
  return link;
}

function allowedHosts(parsed: Parsed): string[] | undefined {
  const fromFlags = parsed.flags.get("--allow-host") ?? [];
  const fromEnv = (process.env.AGENTIC_LINK_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const all = [...fromFlags, ...fromEnv];
  return all.length > 0 ? all : undefined;
}

function manage(parsed: Parsed) {
  return {
    endpoint: one(parsed, "--endpoint") ?? process.env.AGENTIC_LINK_ENDPOINT,
    ownerKey: process.env.AGENTIC_LINK_OWNER_KEY || undefined,
    adminKey: process.env.AGENTIC_LINK_ADMIN_KEY || undefined,
  };
}

async function run(argv: string[]): Promise<string> {
  const parsed = parse(argv);
  switch (parsed.command) {
    case "encode": {
      const app = one(parsed, "--app");
      if (app === undefined) throw new UsageError("encode needs --app");
      const file = one(parsed, "--file");
      const text = one(parsed, "--json") ?? (file !== undefined ? readFileCapped(file) : await readStdin());
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new UsageError("payload is not JSON");
      }
      return `${await encodeLink({ app, payload, password: passwordFrom(parsed), base: one(parsed, "--base") })}\n`;
    }
    case "decode": {
      const snapshot = await decodeLink({ link: await linkFrom(parsed), password: passwordFrom(parsed), app: one(parsed, "--app") });
      return `${JSON.stringify(snapshot)}\n`;
    }
    case "shorten": {
      const ttlText = one(parsed, "--ttl");
      const ttl = ttlText === undefined ? undefined : Number(ttlText);
      if (ttl !== undefined && !Number.isInteger(ttl)) throw new UsageError("--ttl must be a whole number of seconds");
      const { url } = await shortenLink({
        link: await linkFrom(parsed),
        endpoint: one(parsed, "--endpoint") ?? process.env.AGENTIC_LINK_ENDPOINT,
        ttl,
        ownerKey: process.env.AGENTIC_LINK_OWNER_KEY || undefined,
      });
      return `${url}\n`;
    }
    case "revoke": {
      const result = await revokeLink({ link: await linkFrom(parsed), ...manage(parsed) });
      return `${JSON.stringify(result)}\n`;
    }
    case "list":
      return `${JSON.stringify(await listLinks(manage(parsed)))}\n`;
    case "open": {
      const snapshot = await openLink({
        link: await linkFrom(parsed),
        password: passwordFrom(parsed),
        app: one(parsed, "--app"),
        allowedHosts: allowedHosts(parsed),
      });
      return `${JSON.stringify(snapshot)}\n`;
    }
    default:
      throw new UsageError(parsed.command ? `unknown command ${parsed.command}` : "no command");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "mcp") {
    // `mcp --help` and `mcp --version` answer and exit. They never start the server.
    if (argv.slice(1).some((a) => a === "--help" || a === "-h")) {
      process.stdout.write(HELP);
      return;
    }
    if (argv.slice(1).some((a) => a === "--version" || a === "-V" || a === "-v")) {
      process.stdout.write(`${VERSION}\n`);
      return;
    }
    const { startMcp } = await import("./mcp.js");
    await startMcp();
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  try {
    process.stdout.write(await run(argv));
  } catch (error) {
    const { error: code, message } = describeError(error);
    process.stderr.write(`error: ${code}: ${message}\n`);
    if (error instanceof UsageError) process.stderr.write(`\n${HELP}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

await main();
