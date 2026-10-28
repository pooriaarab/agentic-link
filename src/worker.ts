/**
 * The short-link service. It stores ciphertext under a random id and nothing
 * else: the key stays in the short URL's fragment, which a browser never sends.
 * Routes live under /api/v1. Storage is D1; rate-limit counts are keyed hashes.
 * The Worker makes no console calls and keeps no logs.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  BASE64URL_PATTERN,
  DEFAULT_DAILY_LIMIT,
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
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
}
export interface WorkerEnv {
  DB: D1Like;
  /** Secret, 32 characters or more. Keys the address hash. The Worker refuses to serve without it. */
  BRAKE_KEY?: string;
  DAILY_LIMIT?: string;
}

const DAY_MS = 86_400_000;
const MIN_KEY_CHARS = 32;

const createBody = z
  .object({
    c: z.string().min(MIN_CIPHERTEXT_CHARS).max(MAX_CIPHERTEXT_CHARS).regex(BASE64URL_PATTERN),
    iv: z.string().length(IV_CHARS).regex(BASE64URL_PATTERN),
    ttl: z.union([z.literal(TTLS[0]), z.literal(TTLS[1]), z.literal(TTLS[2]), z.literal(TTLS[3])]),
  })
  .strict();

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

async function addressKey(secret: string, day: number, address: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${secret}\n${day}\n${address}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
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

app.use("/api/v1/links", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400",
    });
  }
  return next();
});

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
  const now = Date.now();
  const day = Math.floor(now / DAY_MS);
  const address = c.req.header("cf-connecting-ip") ?? "unknown";
  const h = await addressKey(c.env.BRAKE_KEY!, day, address);
  const counted = await c.env.DB.prepare(
    "INSERT INTO brakes (h, day, n) VALUES (?, ?, 1) ON CONFLICT (h, day) DO UPDATE SET n = n + 1 RETURNING n",
  )
    .bind(h, day)
    .first<{ n: number }>();
  if (counted === null || typeof counted.n !== "number" || counted.n > dailyLimit(c.env)) {
    c.header("Retry-After", String(Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000))));
    return fail(c, "rate_limited", 429);
  }
  const exp = now + parsed.data.ttl * 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = randomId();
    const row = await c.env.DB.prepare(
      "INSERT INTO links (id, c, iv, exp) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING id",
    )
      .bind(id, parsed.data.c, parsed.data.iv, exp)
      .first<{ id: string }>();
    if (row !== null) return c.json({ id, exp }, 201);
  }
  return fail(c, "unavailable", 503);
});

app.get("/api/v1/links/:id", async (c) => {
  if (!configured(c.env)) return fail(c, "not_configured", 503);
  const id = c.req.param("id");
  if (!ID_PATTERN.test(id)) return fail(c, "not_found", 404);
  const row = await c.env.DB.prepare("SELECT c, iv, exp FROM links WHERE id = ?").bind(id).first<{
    c: unknown;
    iv: unknown;
    exp: unknown;
  }>();
  if (row === null) return fail(c, "not_found", 404);
  const live =
    typeof row.exp === "number" &&
    Number.isInteger(row.exp) &&
    row.exp > Date.now() &&
    typeof row.c === "string" &&
    typeof row.iv === "string";
  if (!live) {
    await c.env.DB.prepare("DELETE FROM links WHERE id = ?").bind(id).run();
    return fail(c, "not_found", 404);
  }
  return c.json({ c: row.c, iv: row.iv, exp: row.exp });
});

app.all("*", (c) => fail(c, "not_found", 404));

export async function sweep(env: WorkerEnv, now = Date.now()): Promise<void> {
  // A row whose expiry is not an integer is corrupt; treat it as expired.
  await env.DB.prepare("DELETE FROM links WHERE typeof(exp) != 'integer' OR exp <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM brakes WHERE day < ?").bind(Math.floor(now / DAY_MS) - 1).run();
}

export default {
  fetch: (request: Request, env: WorkerEnv): Response | Promise<Response> => app.fetch(request, env),
  scheduled: async (_event: unknown, env: WorkerEnv): Promise<void> => {
    if (configured(env)) await sweep(env);
  },
};
