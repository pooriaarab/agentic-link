import { readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fetchRetry, ROOT, sql, start, stop, type Running } from "./e2e-harness.js";
import { resolveShort, shorten, ShortError } from "./short.js";

// End to end: the real Worker under `wrangler dev`, a real D1 file, and a
// recording proxy between the client and the Worker. Failure modes first:
// each test names a way the service can hurt a person, or leak, or be abused.

const BRAKE_KEY = "test-brake-key-0123456789abcdef-0123456789";
const DAILY_LIMIT = 4;

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let main: Running;
let proxy: Server;
let proxyPort: number;
const seen: Recorded[] = [];
let forwarded = 0;

function api(path: string, init?: RequestInit & { ip?: string }): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.ip) headers.set("cf-connecting-ip", init.ip);
  return fetchRetry(`http://127.0.0.1:${main.port}${path}`, { ...init, headers });
}

const b64 = (n: number) => "A".repeat(n);
const goodBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ c: b64(64), iv: b64(16), ttl: 86400, ...extra });
const post = (body: string, ip: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  api("/api/v1/links", { method: "POST", body, headers, ip });

beforeAll(async () => {
  main = await start({ BRAKE_KEY, DAILY_LIMIT: String(DAILY_LIMIT) });
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: body.toString("utf8") });
      void fetchRetry(`http://127.0.0.1:${main.port}${req.url}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] ?? "application/json", "cf-connecting-ip": `10.1.${forwarded >> 8}.${forwarded++ & 255}` },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      })
        .then(async (up) => {
          res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
          res.end(Buffer.from(await up.arrayBuffer()));
        })
        .catch((error: unknown) => {
          res.writeHead(502);
          res.end(String(error));
        });
    });
  });
  // The client keeps sockets alive. The default server timeout (5 s) can close an idle
  // socket just as the client reuses it, which fails the request with a socket error.
  proxy.keepAliveTimeout = 60_000;
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;
}, 180_000);

afterAll(() => {
  proxy?.close();
  if (main) stop(main);
});

describe("a service that is not configured refuses everything", () => {
  test.each([
    ["no brake key", {}],
    ["a short brake key", { BRAKE_KEY: "short" }],
  ])("%s", async (_name, vars) => {
    const bare = await start(vars);
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}/api/v1/links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: goodBody(),
      });
      expect(res.status).toBe(503);
      const get = await fetch(`http://127.0.0.1:${bare.port}/api/v1/links/abcdefghjk`);
      expect(get.status).toBe(503);
    } finally {
      stop(bare);
    }
  }, 180_000);
});

describe("what the service accepts", () => {
  test("health answers without touching storage", async () => {
    const res = await api("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test.each([
    ["not JSON", "this is not json"],
    ["a JSON array", "[]"],
    ["no ciphertext", JSON.stringify({ iv: b64(16), ttl: 86400 })],
    ["ciphertext that is not base64url", goodBody({ c: "has spaces and + and /" })],
    ["ciphertext with padding", goodBody({ c: b64(63) + "=" })],
    ["ciphertext too short to hold a tag", goodBody({ c: b64(10) })],
    ["an IV of the wrong length", goodBody({ iv: b64(15) })],
    ["an IV that is a number", goodBody({ iv: 1234567890123456 })],
    ["a ttl that is not on the list", goodBody({ ttl: 5 })],
    ["a ttl that is a string", goodBody({ ttl: "86400" })],
    ["a ttl of a year", goodBody({ ttl: 31_536_000 })],
    ["an extra field", goodBody({ plaintext: "hello" })],
    ["a prototype key", `{"__proto__":{"x":1},"c":"${b64(64)}","iv":"${b64(16)}","ttl":86400}`],
  ])("refuses %s with 400 and stores nothing", async (_name, body) => {
    const before = sql(main, "select count(*) as n from links")[0]!.n;
    const res = await post(body, "203.0.113.1");
    expect(res.status).toBe(400);
    expect(sql(main, "select count(*) as n from links")[0]!.n).toBe(before);
  });

  test("refuses a ciphertext one character over the cap, and takes one at the cap", async () => {
    const over = await post(goodBody({ c: b64(16385) }), "203.0.113.2");
    expect(over.status).toBe(413);
    const at = await post(goodBody({ c: b64(16384) }), "203.0.113.3");
    expect(at.status).toBe(201);
  });

  test("refuses a huge body by its declared length, before reading it", async () => {
    const res = await post("x".repeat(200_000), "203.0.113.4");
    expect(res.status).toBe(413);
  });

  test("refuses a huge body that declares nothing (chunked)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode("x".repeat(50_000));
        for (let i = 0; i < 6; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await fetch(`http://127.0.0.1:${main.port}/api/v1/links`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  test("answers 201 with an id and an expiry, and nothing else", async () => {
    const res = await post(goodBody(), "203.0.113.6");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["exp", "id"]);
    expect(body.id).toMatch(/^[a-km-np-z2-9]{10}$/);
    expect(body.exp as number).toBeGreaterThan(Date.now() + 80_000_000);
    expect(body.exp as number).toBeLessThanOrEqual(Date.now() + 86_400_000 + 5_000);
  });
});

describe("links are immutable and unknown things look empty", () => {
  test.each([
    ["PUT", "/api/v1/links/abcdefghjk"],
    ["DELETE", "/api/v1/links/abcdefghjk"],
    ["PATCH", "/api/v1/links/abcdefghjk"],
    ["GET", "/api/v1/links"],
    ["GET", "/api/v1/other"],
    ["GET", "/"],
  ])("%s %s answers the same 404 an unknown link gets", async (method, path) => {
    const res = await api(path, { method });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test.each([
    ["an id that is too short", "abc"],
    ["an id with a quote", "ab'cdefghj"],
    ["an id with SQL in it", "x%27%3Bdrop%20table%20links--"],
    ["an id with a dot dot", "..%2F..%2Fx"],
    ["an id that does not exist", "abcdefghjk"],
  ])("%s answers 404", async (_name, id) => {
    const res = await api(`/api/v1/links/${id}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(sql(main, "select count(*) as n from links")[0]!.n).toBeGreaterThan(0); // table survived
  });
});

describe("expiry fails closed", () => {
  async function make(ip: string): Promise<string> {
    const res = await post(goodBody(), ip);
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  test("a link past its time is gone, and its row is deleted when asked for", async () => {
    const id = await make("203.0.113.10");
    expect((await api(`/api/v1/links/${id}`)).status).toBe(200);
    sql(main, `update links set exp = ${Date.now() - 1000} where id = '${id}'`);
    expect((await api(`/api/v1/links/${id}`)).status).toBe(404);
    expect(sql(main, `select count(*) as n from links where id = '${id}'`)[0]!.n).toBe(0);
  });

  test.each([
    ["text", "'soon'"],
    ["an empty string", "''"],
    ["null-like text", "'null'"],
    ["a float that is not an integer", "1.5"],
    ["a negative number", "-5"],
  ])("a row whose expiry is %s is gone", async (_name, value) => {
    const id = await make(`203.0.113.${11 + Math.floor(Math.random() * 80)}`);
    sql(main, `update links set exp = ${value} where id = '${id}'`);
    expect((await api(`/api/v1/links/${id}`)).status).toBe(404);
  });

  test("the hourly sweep deletes expired and corrupt rows and keeps live ones", async () => {
    const live = await make("203.0.113.100");
    const dead = await make("203.0.113.101");
    const corrupt = await make("203.0.113.102");
    sql(main, `update links set exp = 1 where id = '${dead}'`);
    sql(main, `update links set exp = 'x' where id = '${corrupt}'`);
    const res = await fetch(`http://127.0.0.1:${main.port}/cdn-cgi/handler/scheduled`);
    expect(res.status).toBe(200);
    const rows = sql(main, `select id from links where id in ('${live}','${dead}','${corrupt}')`).map((r) => r.id);
    expect(rows).toEqual([live]);
  });
});

describe("the daily limit", () => {
  test("counts valid links per address, ignores malformed ones, and answers 429 with Retry-After", async () => {
    const ip = "198.51.100.200";
    for (let i = 0; i < 3; i++) expect((await post("not json", ip)).status).toBe(400);
    for (let i = 0; i < DAILY_LIMIT; i++) expect((await post(goodBody(), ip)).status).toBe(201);
    const refused = await post(goodBody(), ip);
    expect(refused.status).toBe(429);
    const wait = Number(refused.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(86_400);
    // Another address has its own count.
    expect((await post(goodBody(), "198.51.100.201")).status).toBe(201);
  });

  test("keys an IPv6 client by its /64, so rotating addresses in one /64 hit the limit", async () => {
    const rotating = [
      "2001:db8:1:2::1",
      "2001:db8:1:2:abcd::5",
      "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff",
      "[2001:db8:1:2:1:2:3:4]",
    ];
    for (let i = 0; i < DAILY_LIMIT; i++) expect((await post(goodBody(), rotating[i % rotating.length]!)).status).toBe(201);
    const refused = await post(goodBody(), "2001:db8:1:2:9::9");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("does not share a count between two different /64 prefixes", async () => {
    for (let i = 0; i < DAILY_LIMIT; i++) expect((await post(goodBody(), `2001:db8:2:a::${i + 1}`)).status).toBe(201);
    expect((await post(goodBody(), "2001:db8:2:a::99")).status).toBe(429);
    expect((await post(goodBody(), "2001:db8:2:b::1")).status).toBe(201);
    expect((await post(goodBody(), "2001:db8:3:a::1")).status).toBe(201);
  });

  test("treats an IPv4-mapped address as that IPv4 address", async () => {
    for (let i = 0; i < DAILY_LIMIT; i++) {
      const form = i % 2 === 0 ? "::ffff:198.51.100.230" : "::FFFF:c633:64e6";
      expect((await post(goodBody(), form)).status).toBe(201);
    }
    expect((await post(goodBody(), "198.51.100.230")).status).toBe(429);
    expect((await post(goodBody(), "198.51.100.231")).status).toBe(201);
  });

  test("counts every unparseable address in one shared bucket, so garbage cannot dodge the limit", async () => {
    const garbage = ["not-an-ip", "999.1.1.1", "2001:db8::1::2", "[::1"];
    for (let i = 0; i < DAILY_LIMIT; i++) expect((await post(goodBody(), garbage[i]!)).status).toBe(201);
    // Another garbage address is refused, because it shares the bucket that the first four filled.
    expect((await post(goodBody(), "::ffff:999.1.1.1")).status).toBe(429);
    expect((await post(goodBody(), "not-an-ip-either")).status).toBe(429);
    // The shared bucket does not block a parsed address.
    expect((await post(goodBody(), "198.51.100.240")).status).toBe(201);
  });

  test("stores no address in the clear", async () => {
    const rows = sql(main, "select h, n, day from brakes");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(String(row.h)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(String(row.h)).not.toContain("198.51.100");
    }
  });

  test("does not trust a count the caller supplies", async () => {
    const ip = "198.51.100.210";
    for (let i = 0; i < DAILY_LIMIT; i++) {
      expect((await post(goodBody(), ip, { "content-type": "application/json", "x-ratelimit-remaining": "999" })).status).toBe(
        201,
      );
    }
    expect((await post(goodBody(), ip, { "content-type": "application/json", "x-ratelimit-remaining": "999" })).status).toBe(429);
  });
});

describe("the global daily cap", () => {
  test("stops new links once the day's stored rows reach the cap, whoever asks", async () => {
    const capped = await start({ BRAKE_KEY, DAILY_LIMIT: "100", GLOBAL_DAILY_LIMIT: "3" });
    try {
      const send = (ip: string) =>
        fetch(`http://127.0.0.1:${capped.port}/api/v1/links`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: goodBody(),
        });
      for (let i = 0; i < 3; i++) expect((await send(`203.0.113.${i + 1}`)).status).toBe(201);
      const refused = await send("2001:db8:9:9::1");
      expect(refused.status).toBe(429);
      const wait = Number(refused.headers.get("retry-after"));
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(86_400);
      expect(sql(capped, "select count(*) as n from links")[0]!.n).toBe(3);
    } finally {
      stop(capped);
    }
  }, 180_000);
});

describe("browsers may call it, and nothing is cached or leaked on the way", () => {
  test("answers a preflight and sets no-store and no-referrer", async () => {
    const pre = await api("/api/v1/links", {
      method: "OPTIONS",
      headers: { origin: "https://app.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    const res = await api("/api/v1/health");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("the server never sees plaintext or key", () => {
  const SECRET_LINK = "https://app.example/notes#/v1/notes/SECRET-DOCUMENT-CONTENT-" + "x".repeat(300);

  test("shorten and resolve round-trip through the Worker", async () => {
    const made = await shorten(SECRET_LINK, { endpoint: `http://127.0.0.1:${proxyPort}`, ttl: 3600 });
    expect(made.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[a-km-np-z2-9]{10}#[A-Za-z0-9_-]{43}$/);
    expect(made.expiresAt).toBeGreaterThan(Date.now());
    const back = await resolveShort(made.url);
    expect(back).toBe(SECRET_LINK);
  });

  test("no request, header, stored row, or response carried the plaintext or the key", async () => {
    seen.length = 0;
    const made = await shorten(SECRET_LINK, { endpoint: `http://127.0.0.1:${proxyPort}`, ttl: 3600 });
    const key = made.url.split("#")[1]!;
    await resolveShort(made.url);
    expect(seen.length).toBe(2); // one POST, one GET, nothing else
    const wire = JSON.stringify(seen);
    // Positive control: the instruments can see the ciphertext, so their silence about the key means something.
    const stored0 = sql(main, `select c from links where id = '${made.url.split("/s/")[1]!.split("#")[0]!}'`)[0]!.c as string;
    expect(wire).toContain(stored0);
    expect(wire).not.toContain(key);
    expect(wire).not.toContain("SECRET-DOCUMENT-CONTENT");
    expect(wire).not.toContain("app.example");
    const id = made.url.split("/s/")[1]!.split("#")[0]!;
    const row = sql(main, `select * from links where id = '${id}'`)[0]!;
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(key);
    expect(stored).not.toContain("SECRET-DOCUMENT-CONTENT");
    // The whole database file set, byte for byte.
    let sawCiphertext = false;
    for (const file of readdirSync(main.persist, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const bytes = readFileSync(join(file.parentPath, file.name)).toString("latin1");
      if (bytes.includes(stored0)) sawCiphertext = true;
      expect(bytes).not.toContain(key);
      expect(bytes).not.toContain("SECRET-DOCUMENT-CONTENT");
    }
    expect(sawCiphertext).toBe(true);
  });

  test("a wrong key, a changed ciphertext, and a swapped IV all fail closed", async () => {
    const made = await shorten(SECRET_LINK, { endpoint: `http://127.0.0.1:${proxyPort}`, ttl: 3600 });
    const [base, key] = made.url.split("#") as [string, string];
    const wrongKey = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    await expect(resolveShort(`${base}#${wrongKey}`)).rejects.toMatchObject({ code: "open_failed" });
    await expect(resolveShort(base)).rejects.toMatchObject({ code: "bad_url" });
    const id = base.split("/s/")[1]!;
    // Change the first character to one it is not. Two updates could cancel out.
    sql(main, `update links set c = (case when substr(c,1,1) = 'A' then 'B' else 'A' end) || substr(c, 2) where id = '${id}'`);
    await expect(resolveShort(made.url)).rejects.toMatchObject({ code: "open_failed" });
  });

  test("a link that is gone is reported as gone", async () => {
    const made = await shorten(SECRET_LINK, { endpoint: `http://127.0.0.1:${proxyPort}`, ttl: 3600 });
    const id = made.url.split("/s/")[1]!.split("#")[0]!;
    sql(main, `delete from links where id = '${id}'`);
    await expect(resolveShort(made.url)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the client is careful about where it connects", () => {
  test.each([
    ["plain http to a public host", "http://example.test/s/abcdefghjk#" + "A".repeat(43)],
    ["a file URL", "file:///etc/passwd#" + "A".repeat(43)],
    ["an id with a slash", `http://127.0.0.1:1/s/ab/cd#${"A".repeat(43)}`],
    ["a key of the wrong length", "http://127.0.0.1:1/s/abcdefghjk#short"],
    ["no key at all", "http://127.0.0.1:1/s/abcdefghjk"],
    ["garbage", "not a url"],
  ])("resolve refuses %s without making a request", async (_name, url) => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    await expect(resolveShort(url, { fetch: fetcher })).rejects.toBeInstanceOf(ShortError);
    expect(called).toBe(false);
  });

  test("resolve refuses a host the caller did not allow", async () => {
    const url = `https://elsewhere.test/s/abcdefghjk#${"A".repeat(43)}`;
    await expect(resolveShort(url, { allowedHosts: ["links.example"] })).rejects.toMatchObject({ code: "bad_url" });
  });

  test("resolve refuses a response that is too large or the wrong shape", async () => {
    const url = `http://127.0.0.1:1/s/abcdefghjk#${"A".repeat(43)}`;
    const big = (async () => new Response("x".repeat(100_000))) as typeof fetch;
    await expect(resolveShort(url, { fetch: big })).rejects.toMatchObject({ code: "bad_response" });
    const odd = (async () => new Response(JSON.stringify({ c: 1, iv: 2, exp: "x" }))) as typeof fetch;
    await expect(resolveShort(url, { fetch: odd })).rejects.toMatchObject({ code: "bad_response" });
  });

  test("shorten refuses a link too long for the ciphertext cap, before any request", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    await expect(shorten("x".repeat(13_000), { endpoint: "http://127.0.0.1:1", fetch: fetcher })).rejects.toMatchObject({
      code: "too_large",
    });
    expect(called).toBe(false);
  });

  test("shorten refuses a ttl off the list", async () => {
    await expect(shorten("hello", { endpoint: "http://127.0.0.1:1", ttl: 5 })).rejects.toMatchObject({ code: "bad_ttl" });
  });
});

describe("the service keeps no logs", () => {
  test("wrangler config turns observability off and the Worker never calls console", () => {
    const config = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
    expect(config).toMatch(/"observability"\s*:\s*\{\s*"enabled"\s*:\s*false/);
    for (const file of ["worker.ts", "short-protocol.ts"]) {
      expect(readFileSync(join(ROOT, "src", file), "utf8")).not.toMatch(/console\./);
    }
  });
});
