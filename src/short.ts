/**
 * Short-link client. shorten() encrypts a link in this process with a fresh
 * AES-256-GCM key and stores only the ciphertext on the service. The key goes
 * into the short URL's fragment, which fetch never sends.
 */
import { fromBase64Url, toBase64Url } from "./codec.js";
import { createClient, LinkApiError, type ListedLink } from "./client.js";
import {
  BASE64URL_PATTERN,
  DEFAULT_TTL,
  ID_PATTERN,
  IV_CHARS,
  KEY_CHARS,
  MAX_CIPHERTEXT_CHARS,
  MAX_PLAINTEXT_BYTES,
  TTLS,
} from "./short-protocol.js";

export type ShortErrorCode =
  | "bad_url"
  | "bad_ttl"
  | "too_large"
  | "rate_limited"
  | "not_found"
  | "gone"
  | "unauthorized"
  | "forbidden"
  | "bad_response"
  | "open_failed"
  | "service";

export class ShortError extends Error {
  readonly code: ShortErrorCode;
  constructor(code: ShortErrorCode, message: string) {
    super(message);
    this.name = "ShortError";
    this.code = code;
  }
}

export interface ShortenOptions {
  /** Origin of the short-link Worker, for example https://links.example. */
  endpoint: string;
  ttl?: number;
  /** Makes the link revocable and listable by this owner. See newOwnerKey. The key goes only to `endpoint`. */
  ownerKey?: string;
  fetch?: typeof fetch;
}

/** Who may revoke or list: the creator's owner key, or the service's admin key. */
export interface ManageOptions {
  /** Origin of the short-link Worker. The key goes only here, never to a host named in a short URL. */
  endpoint: string;
  ownerKey?: string;
  adminKey?: string;
  fetch?: typeof fetch;
}

/** A fresh owner key: 43 base64url characters from 32 random bytes. Keep it secret, and use one per person. */
export function newOwnerKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export interface ResolveOptions {
  fetch?: typeof fetch;
  /** Hostnames the client may contact. When set, any other host is refused. */
  allowedHosts?: string[];
}

export interface ShortLink {
  url: string;
  id: string;
  expiresAt: number;
}

const MAX_RESPONSE_BYTES = MAX_CIPHERTEXT_CHARS + 512;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https only, except loopback. A link from a stranger must not steer a client at a private host over http. */
function checkOrigin(url: URL, allowedHosts?: string[]): void {
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!secure) throw new ShortError("bad_url", "service must use https");
  if (allowedHosts && !allowedHosts.includes(url.hostname)) throw new ShortError("bad_url", "host is not allowed");
}

async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new ShortError("bad_response", "response is too large");
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

export async function shorten(link: string, options: ShortenOptions): Promise<ShortLink> {
  const ttl = options.ttl ?? DEFAULT_TTL;
  if (!(TTLS as readonly number[]).includes(ttl)) throw new ShortError("bad_ttl", `ttl must be one of ${TTLS.join(", ")}`);
  const plain = new TextEncoder().encode(link);
  if (plain.length > MAX_PLAINTEXT_BYTES) throw new ShortError("too_large", "link is too long for a short link");
  let origin: URL;
  try {
    origin = new URL(options.endpoint);
  } catch {
    throw new ShortError("bad_url", "endpoint is not a URL");
  }
  checkOrigin(origin);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey as BufferSource, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource));
  const send = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await send(`${origin.origin}/api/v1/links`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.ownerKey === undefined ? {} : { authorization: `Bearer ${options.ownerKey}` }),
      },
      body: JSON.stringify({ c: toBase64Url(cipher), iv: toBase64Url(iv), ttl }),
    });
  } catch {
    throw new ShortError("service", "could not reach the service");
  }
  const text = await readCapped(response, MAX_RESPONSE_BYTES);
  if (response.status === 429) throw new ShortError("rate_limited", "daily limit reached for this address");
  if (response.status === 413) throw new ShortError("too_large", "service refused the size");
  if (response.status === 400 && options.ownerKey !== undefined) throw new ShortError("bad_url", "owner key is not accepted");
  if (response.status !== 201) throw new ShortError("service", `service answered ${response.status}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ShortError("bad_response", "service answered with something that is not JSON");
  }
  const { id, exp } = (body ?? {}) as { id?: unknown; exp?: unknown };
  if (typeof id !== "string" || !ID_PATTERN.test(id) || typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new ShortError("bad_response", "service answered with an unexpected shape");
  }
  return { url: `${origin.origin}/s/${id}#${toBase64Url(rawKey)}`, id, expiresAt: exp };
}

export async function resolveShort(shortUrl: string, options: ResolveOptions = {}): Promise<string> {
  let url: URL;
  try {
    url = new URL(shortUrl);
  } catch {
    throw new ShortError("bad_url", "short link is not a URL");
  }
  checkOrigin(url, options.allowedHosts);
  const match = /^\/s\/([^/]+)$/.exec(url.pathname);
  const keyText = url.hash.slice(1);
  if (!match || !ID_PATTERN.test(match[1]!)) throw new ShortError("bad_url", "short link has no valid id");
  if (keyText.length !== KEY_CHARS || !BASE64URL_PATTERN.test(keyText)) {
    throw new ShortError("bad_url", "short link has no valid key");
  }
  const send = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await send(`${url.origin}/api/v1/links/${match[1]}`, { redirect: "error" });
  } catch {
    throw new ShortError("service", "could not reach the service");
  }
  const text = await readCapped(response, MAX_RESPONSE_BYTES);
  if (response.status === 404) throw new ShortError("not_found", "short link is gone");
  if (response.status === 410) throw new ShortError("gone", "short link was revoked");
  if (response.status !== 200) throw new ShortError("service", `service answered ${response.status}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ShortError("bad_response", "service answered with something that is not JSON");
  }
  const { c, iv, exp } = (body ?? {}) as { c?: unknown; iv?: unknown; exp?: unknown };
  if (
    typeof c !== "string" || c.length > MAX_CIPHERTEXT_CHARS || !BASE64URL_PATTERN.test(c) ||
    typeof iv !== "string" || iv.length !== IV_CHARS || !BASE64URL_PATTERN.test(iv) ||
    typeof exp !== "number"
  ) {
    throw new ShortError("bad_response", "service answered with an unexpected shape");
  }
  let plain: Uint8Array;
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64Url(keyText) as BufferSource, "AES-GCM", false, ["decrypt"]);
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) as BufferSource }, key, fromBase64Url(c) as BufferSource),
    );
  } catch {
    throw new ShortError("open_failed", "wrong key, or the stored data was changed");
  }
  return new TextDecoder().decode(plain);
}

const MANAGE_CODES: Record<string, ShortErrorCode> = {
  not_found: "not_found",
  gone: "gone",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  rate_limited: "rate_limited",
};

async function manage<T>(options: ManageOptions, run: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  let origin: URL;
  try {
    origin = new URL(options.endpoint);
  } catch {
    throw new ShortError("bad_url", "endpoint is not a URL");
  }
  checkOrigin(origin);
  if (options.ownerKey === undefined && options.adminKey === undefined) {
    throw new ShortError("unauthorized", "an owner key or an admin key is needed");
  }
  let client: ReturnType<typeof createClient>;
  try {
    client = createClient({ baseUrl: origin.origin, ownerKey: options.ownerKey, adminKey: options.adminKey, fetch: options.fetch });
  } catch {
    throw new ShortError("unauthorized", "the key is not 32 to 128 base64url characters");
  }
  try {
    return await run(client);
  } catch (error) {
    if (error instanceof LinkApiError) {
      throw new ShortError(MANAGE_CODES[error.code] ?? "service", `service answered ${error.status}`);
    }
    throw new ShortError("service", "could not reach the service");
  }
}

/** The id of a short link: a bare id, or the id inside a short URL. Only the id is used; the URL's host and key are ignored. */
export function shortId(idOrUrl: string): string {
  if (ID_PATTERN.test(idOrUrl)) return idOrUrl;
  try {
    const match = /^\/s\/([^/]+)$/.exec(new URL(idOrUrl).pathname);
    if (match && ID_PATTERN.test(match[1]!)) return match[1]!;
  } catch {
    /* fall through */
  }
  throw new ShortError("bad_url", "not a short link id or short URL");
}

/** Revoke a short link. The creator's owner key or an admin key is needed. The service answers 410 for it from then on. */
export async function revokeShort(idOrUrl: string, options: ManageOptions): Promise<{ id: string }> {
  const id = shortId(idOrUrl);
  await manage(options, (c) => c.revokeLink(id));
  return { id };
}

/** The 100 short links of the owner key that expire last (all links for an admin key), revoked ones marked. */
export async function listShort(options: ManageOptions): Promise<ListedLink[]> {
  return manage(options, (c) => c.listLinks());
}
