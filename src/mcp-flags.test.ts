import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { VERSION } from "./version.js";

// Ways `mcp --help` can fail: it starts the server and waits on stdin, or it exits non-zero.
// Each case runs the built bin with stdin left open and a bare environment.

const dist = (file: string) => {
  const path = join(process.cwd(), "dist", file);
  if (!existsSync(path)) throw new Error("dist is missing: run npm run build first");
  return path;
};

function run(file: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [dist(file), ...args], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

describe("help and version never start the server", () => {
  const cases: [string, string[], "help" | "version"][] = [];
  for (const file of ["cli.js", "mcp-bin.js"]) {
    const lead = file === "cli.js" ? ["mcp"] : [];
    for (const flag of ["--help", "-h"]) cases.push([file, [...lead, flag], "help"]);
    for (const flag of ["--version", "-V", "-v"]) cases.push([file, [...lead, flag], "version"]);
    cases.push([file, [...lead, "--bogus", "--help"], "help"]);
  }
  for (const flag of ["--help", "-h"]) cases.push(["cli.js", [flag], "help"]);
  for (const flag of ["--version", "-V", "-v"]) cases.push(["cli.js", [flag], "version"]);
  for (const [file, args, kind] of cases) {
    test(`${file} ${args.join(" ")} exits 0 within 5 s`, async () => {
      const r = await run(file, args);
      expect([r.code, r.err]).toEqual([0, ""]);
      if (kind === "version") expect(r.out.trim()).toBe(VERSION);
      else expect(r.out).toMatch(/Share a document as a link|Runs the MCP server on stdio/);
    });
  }
});
