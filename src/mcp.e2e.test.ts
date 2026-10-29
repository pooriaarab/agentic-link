import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ROOT, start, stop, type Running } from "./e2e-harness.js";

// End to end: the real MCP server over stdio. A tool failure is a result with
// isError set, never a crash, and never carries the document.

const SERVER = join(ROOT, "dist", "mcp-bin.js");
const SECRET = "SECRET-NOTE-BODY";
const PASSWORD = "a long shared password for the test";

async function connect(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = result.content.map((c) => c.text).join("");
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

describe("tools", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect();
  });
  afterAll(async () => {
    await client.close();
  });

  test("lists the four tools, each with a description and an input schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["decode_link", "encode_link", "open_link", "shorten_link"]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("encode_link then decode_link round trips", async () => {
    const enc = await call(client, "encode_link", { app: "notes", payload: { title: "Plan", body: SECRET } });
    expect(enc.isError).toBe(false);
    const { link } = enc.json() as { link: string };
    expect(link).toMatch(/^#\/v1\/notes\//);
    const dec = await call(client, "decode_link", { link });
    expect(dec.json()).toEqual({ app: "notes", version: 1, payload: { title: "Plan", body: SECRET } });
  });

  test("a password seals the link and is needed to open it", async () => {
    const { link } = (await call(client, "encode_link", { app: "notes", payload: { body: SECRET }, password: PASSWORD })).json() as {
      link: string;
    };
    expect(link).not.toContain(SECRET);
    const without = await call(client, "decode_link", { link });
    expect(without.isError).toBe(true);
    expect(without.json()).toMatchObject({ error: "sealed" });
    const wrong = await call(client, "decode_link", { link, password: "nope" });
    expect(wrong.isError).toBe(true);
    expect(wrong.json()).toMatchObject({ error: "open_failed" });
    expect(wrong.text).not.toContain("nope");
    const right = await call(client, "decode_link", { link, password: PASSWORD });
    expect(right.isError).toBe(false);
  });

  test.each([
    ["a link that is not a link", { link: "hello" }],
    ["a truncated link", { link: "#/v1/notes/abc" }],
    ["an unknown version", { link: "#/v7/notes/abc" }],
  ])("decode_link refuses %s as a tool error and the server keeps running", async (_name, args) => {
    const res = await call(client, "decode_link", args);
    expect(res.isError).toBe(true);
    expect(res.json()).toHaveProperty("error");
    expect((await call(client, "encode_link", { app: "notes", payload: {} })).isError).toBe(false);
  });

  test("encode_link refuses a bad app and a prototype key", async () => {
    expect((await call(client, "encode_link", { app: "Bad App", payload: {} })).isError).toBe(true);
    const hostile = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    expect((await call(client, "encode_link", { app: "notes", payload: hostile })).isError).toBe(true);
  });

  test("a call with the wrong argument types is an error, not a crash", async () => {
    const res = await client.callTool({ name: "decode_link", arguments: { link: 42 } }).catch((e: Error) => e);
    const bad = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(bad).toBe(true);
    expect((await call(client, "encode_link", { app: "notes", payload: {} })).isError).toBe(false);
  });

  test("shorten_link has no endpoint, so it refuses", async () => {
    const res = await call(client, "shorten_link", { link: "#/v1/notes/abc" });
    expect(res.isError).toBe(true);
    expect(res.json()).toMatchObject({ error: "not_configured" });
  });

  test("open_link refuses a short link when no host is allowed, before any request", async () => {
    const res = await call(client, "open_link", { link: `http://127.0.0.1:1/s/abcdefghjk#${"A".repeat(43)}` });
    expect(res.isError).toBe(true);
    expect(res.json()).toMatchObject({ error: "bad_url" });
  });
});

describe("short links through a real Worker", () => {
  let worker: Running;
  let client: Client;
  beforeAll(async () => {
    worker = await start({ BRAKE_KEY: "mcp-test-brake-key-0123456789abcdef-0123456789", DAILY_LIMIT: "1000" });
    client = await connect({
      AGENTIC_LINK_ENDPOINT: `http://127.0.0.1:${worker.port}`,
      AGENTIC_LINK_ALLOWED_HOSTS: "127.0.0.1",
    });
  }, 180_000);
  afterAll(async () => {
    await client.close();
    stop(worker);
  });

  test("an agent hands a document over as one URL, and another opens it", async () => {
    const { link } = (await call(client, "encode_link", { app: "notes", payload: { title: "Plan", body: SECRET } })).json() as {
      link: string;
    };
    const short = await call(client, "shorten_link", { link, ttl: 3600 });
    expect(short.isError, short.text).toBe(false);
    const { url } = short.json() as { url: string };
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[a-km-np-z2-9]{10}#/);
    const opened = await call(client, "open_link", { link: url });
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.json()).toMatchObject({ app: "notes", payload: { title: "Plan", body: SECRET } });
  });

  test("open_link refuses a short link on a host that is not allowed", async () => {
    const res = await call(client, "open_link", { link: `https://elsewhere.test/s/abcdefghjk#${"A".repeat(43)}` });
    expect(res.isError).toBe(true);
    expect(res.json()).toMatchObject({ error: "bad_url" });
  });
});
