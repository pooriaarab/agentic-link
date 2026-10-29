import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared by the end-to-end tests: the real Worker under `wrangler dev` with a
// local D1 file in a temp directory.

export const ROOT = new URL("..", import.meta.url).pathname;
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };

export interface Running {
  child: ChildProcess;
  port: number;
  persist: string;
}

export function wrangler(args: string[], persist: string): string {
  return execFileSync("npx", ["wrangler", ...args, "--persist-to", persist], { cwd: ROOT, env, encoding: "utf8" });
}

// Ask the OS for a port that is free now. A random pick can land on a port that
// another process on the same machine already holds.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

export async function start(vars: Record<string, string>): Promise<Running> {
  const persist = mkdtempSync(join(tmpdir(), "link-d1-"));
  wrangler(["d1", "migrations", "apply", "DB", "--local"], persist);
  const port = await freePort();
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--local", "--port", String(port), "--persist-to", persist, "--test-scheduled", ...varArgs],
    { cwd: ROOT, env, detached: true },
  );
  let log = "";
  child.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (res.status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`wrangler dev did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return { child, port, persist };
}

export function stop(run: Running): void {
  // Kill the whole group: npx, wrangler, and the workerd it started.
  try {
    process.kill(-run.child.pid!, "SIGKILL");
  } catch {
    run.child.kill("SIGKILL");
  }
  rmSync(run.persist, { recursive: true, force: true });
}

export function sql(run: Running, command: string): Record<string, unknown>[] {
  const out = wrangler(["d1", "execute", "DB", "--local", "--json", "--command", command], run.persist);
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results: Record<string, unknown>[] }[];
  return parsed[0]!.results;
}

/**
 * fetch with one retry when a reused keep-alive socket turns out to be closed.
 * That failure happens before the server reads the request, so a retry does not repeat one.
 */
export async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const code = ((error as { cause?: { code?: string } }).cause ?? {}).code;
    if (code !== "UND_ERR_SOCKET" && code !== "ECONNRESET") throw error;
    return fetch(url, init);
  }
}
