import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ROOT, start, stop, type Running } from "./e2e-harness.js";
import { listShort, newOwnerKey, resolveShort, revokeShort, shorten, shortId, ShortError } from "./short.js";

// Revoke and list on the SDK, the CLI, and the MCP server, against the real Worker.
let run: Running;
let endpoint: string;
const BRAKE_KEY = "test-brake-key-0123456789abcdef-0123456789";
const ADMIN_KEY = "test-admin-key-0123456789abcdef-0123456789";
const LINK = "https://app.example/page#/v1/notes/SECRET-DOC-BODY";
const CLI = join(ROOT, "dist", "cli.js");
const SERVER = join(ROOT, "dist", "mcp-bin.js");

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ShortError);
  return (error as ShortError).code;
}

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", AGENTIC_LINK_ENDPOINT: endpoint, ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function mcp(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: [SERVER], env: { PATH: process.env.PATH ?? "", AGENTIC_LINK_ENDPOINT: endpoint, ...env } }),
  );
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = r.content.map((c) => c.text).join("");
  return { isError: r.isError === true, text, json: JSON.parse(text) as Record<string, unknown> };
}

beforeAll(async () => {
  run = await start({ BRAKE_KEY, ADMIN_KEY, DAILY_LIMIT: "1000" });
  endpoint = `http://127.0.0.1:${run.port}`;
}, 240_000);

afterAll(() => {
  if (run) stop(run);
});

describe("SDK", () => {
  test("a revoked short link is gone to resolveShort, and the owner lists it as revoked", async () => {
    const ownerKey = newOwnerKey();
    expect(ownerKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const made = await shorten(LINK, { endpoint, ttl: 3600, ownerKey });
    expect(await resolveShort(made.url)).toBe(LINK);
    expect(await revokeShort(made.url, { endpoint, ownerKey })).toEqual({ id: made.id });
    expect(await code(resolveShort(made.url))).toBe("gone");
    expect((await listShort({ endpoint, ownerKey })).map((l) => [l.id, l.revoked])).toEqual([[made.id, true]]);
  });

  test("another owner is forbidden, no key is unauthorized, an admin may revoke", async () => {
    const made = await shorten(LINK, { endpoint, ttl: 3600, ownerKey: newOwnerKey() });
    expect(await code(revokeShort(made.id, { endpoint, ownerKey: newOwnerKey() }))).toBe("forbidden");
    expect(await code(revokeShort(made.id, { endpoint }))).toBe("unauthorized");
    expect(await code(revokeShort(made.id, { endpoint, ownerKey: "short" }))).toBe("unauthorized");
    expect(await resolveShort(made.url)).toBe(LINK);
    await revokeShort(made.id, { endpoint, adminKey: ADMIN_KEY });
    expect(await code(resolveShort(made.url))).toBe("gone");
    expect(await code(revokeShort("abcdefghjk", { endpoint, ownerKey: newOwnerKey() }))).toBe("not_found");
  });

  test("the key goes only to the endpoint, and a bad id or endpoint is refused before any request", async () => {
    const seen: string[] = [];
    const spy = (async (u: string) => (seen.push(u), new Response('{"id":"abcdefghjk","revoked":true}'))) as unknown as typeof fetch;
    const evil = "https://evil.example/s/abcdefghjk#" + "A".repeat(43);
    await revokeShort(evil, { endpoint: "https://good.example", ownerKey: newOwnerKey(), fetch: spy });
    expect(seen).toEqual(["https://good.example/api/v1/links/abcdefghjk"]);
    expect(await code(revokeShort("not an id", { endpoint, ownerKey: newOwnerKey() }))).toBe("bad_url");
    expect(await code(revokeShort("abcdefghjk", { endpoint: "http://insecure.example", ownerKey: newOwnerKey() }))).toBe("bad_url");
    expect(shortId(evil)).toBe("abcdefghjk");
    expect(seen).toHaveLength(1);
  });
});

describe("CLI", () => {
  test("shorten, list, revoke, then open is refused as gone; the key never reaches stdout or stderr", () => {
    const ownerKey = newOwnerKey();
    const made = cli(["shorten", LINK, "--ttl", "3600"], { AGENTIC_LINK_OWNER_KEY: ownerKey });
    expect(made.code, made.err).toBe(0);
    const url = made.out.trim();
    const id = shortId(url);
    const listed = cli(["list"], { AGENTIC_LINK_OWNER_KEY: ownerKey });
    expect(JSON.parse(listed.out)).toEqual({ links: [{ id, exp: expect.any(Number), revoked: false }] });
    const revoked = cli(["revoke", id], { AGENTIC_LINK_OWNER_KEY: ownerKey });
    expect(revoked.code, revoked.err).toBe(0);
    expect(JSON.parse(revoked.out)).toEqual({ id, revoked: true });
    const opened = cli(["open", url, "--allow-host", "127.0.0.1"]);
    expect(opened.code).toBe(1);
    expect(opened.err).toContain("gone");
    expect(JSON.parse(cli(["list"], { AGENTIC_LINK_OWNER_KEY: ownerKey }).out).links[0].revoked).toBe(true);
    for (const r of [made, listed, revoked, opened]) expect(r.out + r.err).not.toContain(ownerKey);
  });

  test("failures: forbidden, no key, and a bad id exit 1, no endpoint exits 2, and keys are not flags", () => {
    const id = shortId(cli(["shorten", LINK], { AGENTIC_LINK_OWNER_KEY: newOwnerKey() }).out.trim());
    const other = cli(["revoke", id], { AGENTIC_LINK_OWNER_KEY: newOwnerKey() });
    expect([other.code, other.err]).toEqual([1, expect.stringContaining("forbidden")]);
    expect(cli(["revoke", id]).code).toBe(1);
    expect(cli(["list"]).code).toBe(1);
    expect(cli(["revoke", "nope"], { AGENTIC_LINK_OWNER_KEY: newOwnerKey() }).code).toBe(1);
    expect(cli(["revoke", id, "--owner-key", "x"]).code).toBe(2);
    expect(cli(["revoke", id], { AGENTIC_LINK_ENDPOINT: "", AGENTIC_LINK_OWNER_KEY: newOwnerKey() }).code).toBe(2);
    expect(cli(["revoke", id], { AGENTIC_LINK_ADMIN_KEY: ADMIN_KEY }).code).toBe(0);
  });
});

describe("MCP", () => {
  test("list_links and revoke_link use the operator's keys, and never return a key or a document", async () => {
    const ownerKey = newOwnerKey();
    const client = await mcp({ AGENTIC_LINK_OWNER_KEY: ownerKey });
    try {
      const made = await tool(client, "shorten_link", { link: LINK, ttl: 3600 });
      const url = String(made.json.url);
      const id = shortId(url);
      const listed = await tool(client, "list_links");
      expect(listed.json).toEqual({ links: [{ id, exp: expect.any(Number), revoked: false }] });
      const revoked = await tool(client, "revoke_link", { link: id });
      expect(revoked.json).toEqual({ id, revoked: true });
      expect((await tool(client, "list_links")).json).toEqual({ links: [{ id, exp: expect.any(Number), revoked: true }] });
      for (const r of [listed, revoked]) expect(r.text).not.toContain(ownerKey);
      expect(listed.text + revoked.text).not.toContain("SECRET-DOC-BODY");
      const again = await tool(client, "revoke_link", { link: "abcdefghjk" });
      expect([again.isError, again.json.error]).toEqual([true, "not_found"]);
    } finally {
      await client.close();
    }
  });

  test("an empty key variable counts as unset, so shorten still works", async () => {
    const client = await mcp({ AGENTIC_LINK_OWNER_KEY: "", AGENTIC_LINK_ADMIN_KEY: "" });
    try {
      expect((await tool(client, "shorten_link", { link: LINK, ttl: 3600 })).isError).toBe(false);
      expect((await tool(client, "list_links")).json.error).toBe("unauthorized");
    } finally {
      await client.close();
    }
  });

  test("with no key or no endpoint the tools refuse, and a key cannot come from an argument", async () => {
    const client = await mcp({});
    try {
      expect((await tool(client, "revoke_link", { link: "abcdefghjk" })).json.error).toBe("unauthorized");
      expect((await tool(client, "list_links")).json.error).toBe("unauthorized");
      const extra = await tool(client, "revoke_link", { link: "abcdefghjk", ownerKey: newOwnerKey() });
      expect(extra.json.error).toBe("unauthorized");
    } finally {
      await client.close();
    }
    const bare = new Client({ name: "test", version: "0.0.0" });
    await bare.connect(new StdioClientTransport({ command: "node", args: [SERVER], env: { PATH: process.env.PATH ?? "", AGENTIC_LINK_OWNER_KEY: newOwnerKey() } }));
    try {
      expect((await tool(bare, "list_links")).json.error).toBe("not_configured");
    } finally {
      await bare.close();
    }
  });
});
