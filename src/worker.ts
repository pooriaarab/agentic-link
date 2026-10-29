/**
 * The short-link service. It stores ciphertext under a random id and nothing
 * else: the key stays in the short URL's fragment, which a browser never sends.
 * Routes live under /api/v1. Storage is D1; rate-limit counts are keyed hashes.
 * The Worker makes no console calls and keeps no logs.
 */
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import {
  BASE64URL_PATTERN,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_GLOBAL_DAILY_LIMIT,
  ID_ALPHABET,
  ID_LENGTH,
  ID_PATTERN,
  IV_CHARS,
  MAX_BODY_BYTES,
  MAX_CIPHERTEXT_CHARS,
  MIN_CIPHERTEXT_CHARS,
  TTLS,
} from "./short-protocol.js";
import { toBase64Url } from "./codec.js";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
}
export interface WorkerEnv {
  DB: D1Like;
  /** Secret, 32 characters or more. Keys the address hash. The Worker refuses to serve without it. */
  BRAKE_KEY?: string;
  /** Optional secret, 32 characters or more. A bearer of it may revoke or list any link. Shorter or missing turns admin off. */
  ADMIN_KEY?: string;
  /** Links per client per UTC day. An IPv6 client is one /64; an IPv4 client is one address. */
  DAILY_LIMIT?: string;
  /** Links stored per UTC day across all clients. */
  GLOBAL_DAILY_LIMIT?: string;
}

const DAY_MS = 86_400_000;
const MIN_KEY_CHARS = 32;
const LIST_LIMIT = 100;
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,128})$/;

const createBody = z
  .object({
    c: z.string().min(MIN_CIPHERTEXT_CHARS).max(MAX_CIPHERTEXT_CHARS).regex(BASE64URL_PATTERN),
    iv: z.string().length(IV_CHARS).regex(BASE64URL_PATTERN),
    ttl: z.union([z.literal(TTLS[0]), z.literal(TTLS[1]), z.literal(TTLS[2]), z.literal(TTLS[3])]),
  })
  .strict();

type Row = { id: string; exp: number; revoked: unknown };

const app = new Hono<{ Bindings: WorkerEnv }>();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Access-Control-Allow-Origin", "*");
  c.header("X-Content-Type-Options", "nosniff");
});

const fail = (c: { json: (b: unknown, s: number) => Response }, error: string, status: number) =>
  c.json({ error }, status);

function configured(env: WorkerEnv): boolean {
  return typeof env.BRAKE_KEY === "string" && env.BRAKE_KEY.length >= MIN_KEY_CHARS && env.DB !== undefined;
}

function dailyLimit(env: WorkerEnv): number {
  const n = Number(env.DAILY_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

function globalDailyLimit(env: WorkerEnv): number {
  const n = Number(env.GLOBAL_DAILY_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_GLOBAL_DAILY_LIMIT;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return null;
    out.push(Number(part));
  }
  return out;
}

function parseIpv6(text: string): number[] | null {
  let rest = text;
  const tail: number[] = [];
  const dot = rest.lastIndexOf(".");
  if (dot !== -1) {
    const colon = rest.lastIndexOf(":");
    const v4 = parseIpv4(rest.slice(colon + 1));
    if (v4 === null) return null;
    tail.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!);
    rest = rest.slice(0, colon + 1) + "0:0";
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const back = halves.length === 2 ? groups(halves[1]!) : [];
  if (head === null || back === null) return null;
  let all: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length;
    if (fill < 1) return null;
    all = [...head, ...new Array<number>(fill).fill(0), ...back];
  } else {
    all = head;
  }
  if (all.length !== 8) return null;
  if (tail.length === 2) {
    all[6] = tail[0]!;
    all[7] = tail[1]!;
  }
  return all;
}

/**
 * The identity a client is counted under. An IPv4 client is one address. An IPv6
 * client is its /64, because one subscriber usually holds a whole /64 and can
 * rotate through it. An IPv4-mapped IPv6 address counts as its IPv4 address. An
 * address that does not parse shares one bucket, so garbage cannot dodge the limit.
 */
export function clientIdentity(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const v4 = parseIpv4(text);
  if (v4 !== null) return `v4:${v4.join(".")}`;
  const g = text.includes(":") ? parseIpv6(text) : null;
  if (g === null) return "bad";
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `v4:${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  }
  return `v6:${g.slice(0, 4).map((x) => x.toString(16)).join(":")}`;
}

async function addressKey(secret: string, day: number, address: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${secret}\n${day}\n${address}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** A keyed hash, so the stored owner value cannot be used as a key and a key cannot be matched without BRAKE_KEY. */
async function ownerHash(secret: string, key: string): Promise<string> {
  return addressKey(secret, 0, `owner\n${key}`);
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all(
    [a, b].map(async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))),
  );
  let diff = 0;
  for (let i = 0; i < x!.length; i++) diff |= x![i]! ^ y![i]!;
  return diff === 0;
}

type Caller = { kind: "none" } | { kind: "admin" } | { kind: "owner"; hash: string };

/** Who is calling. A bearer that is not shaped like a key is none, so callers answer 401 and never compare it. */
async function caller(c: { req: { header: (n: string) => string | undefined }; env: WorkerEnv }): Promise<Caller> {
  const match = BEARER.exec(c.req.header("authorization") ?? "");
  if (match === null) return { kind: "none" };
  const key = match[1]!;
  const admin = c.env.ADMIN_KEY;
  if (typeof admin === "string" && admin.length >= MIN_KEY_CHARS && (await sameSecret(key, admin))) return { kind: "admin" };
  return { kind: "owner", hash: await ownerHash(c.env.BRAKE_KEY!, key) };
}

function randomId(): string {
  const out: string[] = [];
  const limit = 256 - (256 % ID_ALPHABET.length);
  while (out.length < ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(ID_LENGTH * 2))) {
      if (byte < limit && out.length < ID_LENGTH) out.push(ID_ALPHABET[byte % ID_ALPHABET.length]!);
    }
  }
  return out.join("");
}

/** Read a body, stopping as soon as it passes the cap. Null means too large. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(all);
}

const preflight = async (c: Context, next: Next) => {
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204, {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Max-Age": "86400",
    });
  }
  return next();
};
app.use("/api/v1/links", preflight);
app.use("/api/v1/links/*", preflight);

app.get("/api/v1/health", (c) => c.json({ ok: true }));

app.post("/api/v1/links", async (c) => {
  if (!configured(c.env)) return fail(c, "not_configured", 503);
  const text = await readCapped(c.req.raw, MAX_BODY_BYTES);
  if (text === null) return fail(c, "too_large", 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text, (key, value: unknown) => {
      if (key === "__proto__") throw new Error("reserved key");
      return value;
    });
  } catch {
    return fail(c, "bad_request", 400);
  }
  const parsed = createBody.safeParse(raw);
  if (!parsed.success) {
    const tooBig = typeof raw === "object" && raw !== null && typeof (raw as { c?: unknown }).c === "string" &&
      (raw as { c: string }).c.length > MAX_CIPHERTEXT_CHARS;
    return tooBig ? fail(c, "too_large", 413) : fail(c, "bad_request", 400);
  }
  const who = await caller(c);
  // A key on create names the owner. An admin key is not an owner key, so it never owns a link.
  if (c.req.header("authorization") !== undefined && who.kind !== "owner") return fail(c, "bad_request", 400);
  const now = Date.now();
  const day = Math.floor(now / DAY_MS);
  const retryAfter = () => String(Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000)));
  const count = async (identity: string): Promise<number | null> => {
    const h = await addressKey(c.env.BRAKE_KEY!, day, identity);
    const row = await c.env.DB.prepare(
      "INSERT INTO brakes (h, day, n) VALUES (?, ?, 1) ON CONFLICT (h, day) DO UPDATE SET n = n + 1 RETURNING n",
    )
      .bind(h, day)
      .first<{ n: number }>();
    return row !== null && typeof row.n === "number" ? row.n : null;
  };
  const mine = await count(clientIdentity(c.req.header("cf-connecting-ip") ?? ""));
  if (mine === null || mine > dailyLimit(c.env)) {
    c.header("Retry-After", retryAfter());
    return fail(c, "rate_limited", 429);
  }
  const total = await count("global");
  if (total === null || total > globalDailyLimit(c.env)) {
    c.header("Retry-After", retryAfter());
    return fail(c, "rate_limited", 429);
  }
  const exp = now + parsed.data.ttl * 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = randomId();
    const row = await c.env.DB.prepare(
      "INSERT INTO links (id, c, iv, exp, owner) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING id",
    )
      .bind(id, parsed.data.c, parsed.data.iv, exp, who.kind === "owner" ? who.hash : null)
      .first<{ id: string }>();
    if (row !== null) return c.json({ id, exp }, 201);
  }
  return fail(c, "unavailable", 503);
});

app.get("/api/v1/links/:id", async (c) => {
  if (!configured(c.env)) return fail(c, "not_configured", 503);
  const id = c.req.param("id");
  if (!ID_PATTERN.test(id)) return fail(c, "not_found", 404);
  const row = await c.env.DB.prepare("SELECT c, iv, exp, revoked FROM links WHERE id = ?").bind(id).first<{
    c: unknown;
    iv: unknown;
    exp: unknown;
    revoked: unknown;
  }>();
  if (row === null) return fail(c, "not_found", 404);
  // Fail closed: anything but a stored 0 counts as revoked. A revoked link is 410, never a redirect.
  if (row.revoked !== 0) return fail(c, "gone", 410);
  const live =
    typeof row.exp === "number" &&
    Number.isInteger(row.exp) &&
    row.exp > Date.now() &&
    typeof row.c === "string" &&
    typeof row.iv === "string";
  if (!live) {
    await c.env.DB.prepare("DELETE FROM links WHERE id = ? AND revoked = 0").bind(id).run();
    return fail(c, "not_found", 404);
  }
  return c.json({ c: row.c, iv: row.iv, exp: row.exp });
});

app.delete("/api/v1/links/:id", async (c) => {
  if (!configured(c.env)) return fail(c, "not_configured", 503);
  const who = await caller(c);
  if (who.kind === "none") return fail(c, "unauthorized", 401);
  const id = c.req.param("id");
  if (!ID_PATTERN.test(id)) return fail(c, "not_found", 404);
  const row = await c.env.DB.prepare("SELECT owner FROM links WHERE id = ?").bind(id).first<{ owner: unknown }>();
  if (row === null) return fail(c, "not_found", 404);
  const allowed =
    who.kind === "admin" || (typeof row.owner === "string" && (await sameSecret(row.owner, who.hash)));
  if (!allowed) return fail(c, "forbidden", 403);
  // Keep the row as a tombstone and drop the ciphertext. Revoking twice is the same as once.
  await c.env.DB.prepare("UPDATE links SET revoked = 1, c = '', iv = '' WHERE id = ?").bind(id).run();
  return c.json({ id, revoked: true });
});

app.get("/api/v1/links", async (c) => {
  if (!configured(c.env)) return fail(c, "not_configured", 503);
  const who = await caller(c);
  if (who.kind === "none") return fail(c, "unauthorized", 401);
  const { results } =
    who.kind === "admin"
      ? await c.env.DB.prepare("SELECT id, exp, revoked FROM links ORDER BY exp DESC LIMIT ?").bind(LIST_LIMIT).all<Row>()
      : await c.env.DB.prepare("SELECT id, exp, revoked FROM links WHERE owner = ? ORDER BY exp DESC LIMIT ?")
          .bind(who.hash, LIST_LIMIT)
          .all<Row>();
  return c.json({ links: results.map((r) => ({ id: r.id, exp: r.exp, revoked: r.revoked !== 0 })) });
});

app.all("*", (c) => fail(c, "not_found", 404));

export async function sweep(env: WorkerEnv, now = Date.now()): Promise<void> {
  // A row whose expiry is not an integer is corrupt; treat it as expired.
  await env.DB.prepare("DELETE FROM links WHERE revoked = 0 AND (typeof(exp) != 'integer' OR exp <= ?)").bind(now).run();
  await env.DB.prepare("DELETE FROM brakes WHERE day < ?").bind(Math.floor(now / DAY_MS) - 1).run();
}

export default {
  fetch: (request: Request, env: WorkerEnv): Response | Promise<Response> => app.fetch(request, env),
  scheduled: async (_event: unknown, env: WorkerEnv): Promise<void> => {
    if (configured(env)) await sweep(env);
  },
};
