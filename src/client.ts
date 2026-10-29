// A typed client for the short-link Worker HTTP API. It uses only fetch, URL, and AbortSignal, so
// it runs in browsers, Workers, and Node 22. The service is anonymous: it has no bearer token, so
// the client sends none. It never retries: a retry of a create could store a second link.
import { BASE64URL_PATTERN, ID_PATTERN, IV_CHARS, MAX_CIPHERTEXT_CHARS, MIN_CIPHERTEXT_CHARS } from "./short-protocol.js";

const MAX_RESPONSE_BYTES = MAX_CIPHERTEXT_CHARS + 512;

/** Read a body, stopping as soon as it passes the cap. */
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
      throw new LinkApiError("unknown", response.status, "the reply is too large");
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

/** Codes the Worker returns. */
export type ApiErrorCode =
  | "bad_request"
  | "too_large"
  | "rate_limited"
  | "not_found"
  | "unauthorized"
  | "forbidden"
  // The link was revoked. It never comes back.
  | "gone"
  | "not_configured"
  | "unavailable"
  // The reply was not an API error body, for example from a proxy.
  | "unknown";

// Every ApiErrorCode must be a key here, so a new code fails the type check.
const CODES: Record<ApiErrorCode, true> = {
  bad_request: true,
  too_large: true,
  rate_limited: true,
  not_found: true,
  unauthorized: true,
  forbidden: true,
  gone: true,
  not_configured: true,
  unavailable: true,
  unknown: true,
};
const isKnownCode = (v: unknown): v is ApiErrorCode => typeof v === "string" && Object.hasOwn(CODES, v);

/** Thrown for every reply that is not a success. `code` is the API error code and `status` is the HTTP status. */
export class LinkApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Seconds to wait, from a Retry-After header on a 429. */
  readonly retryAfter?: number;

  constructor(code: ApiErrorCode, status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = "LinkApiError";
    this.code = code;
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export interface ClientOptions {
  /** The Worker origin, for example https://links.example.com. The client adds /api/v1. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** The creator's secret, 32 to 128 base64url characters. createLink stores it as the owner; listLinks and revokeLink use it. */
  ownerKey?: string;
  /** The service's admin secret. It lets revokeLink and listLinks reach any link. It never owns a link. */
  adminKey?: string;
}

/** An aborted call rejects with the signal reason, not a LinkApiError. A create that was aborted after it was sent may still have stored a link. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** What the service stores: ciphertext and its IV, both base64url. The key never reaches the service. */
export interface NewLink {
  c: string;
  iv: string;
  /** Seconds to live: 3600, 86400, 604800, or 2592000. */
  ttl: 3600 | 86_400 | 604_800 | 2_592_000;
}
export interface CreatedLink {
  id: string;
  /** Expiry, in milliseconds since the epoch. */
  exp: number;
}
export interface StoredLink {
  c: string;
  iv: string;
  exp: number;
}

export interface ListedLink {
  id: string;
  exp: number;
  revoked: boolean;
}

export interface LinkClient {
  health(options?: CallOptions): Promise<{ ok: true }>;
  createLink(input: NewLink, options?: CallOptions): Promise<CreatedLink>;
  getLink(id: string, options?: CallOptions): Promise<StoredLink>;
  /** Revoke a link. Needs ownerKey of its creator, or adminKey. Revoking twice is the same as once. */
  revokeLink(id: string, options?: CallOptions): Promise<{ id: string; revoked: true }>;
  /** The newest 100 links of ownerKey, revoked ones included. With adminKey: the newest 100 of all links. */
  listLinks(options?: CallOptions): Promise<ListedLink[]>;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

type Shape = "health" | "created" | "stored" | "revoked" | "listed";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SHAPES: Record<Shape, (v: unknown) => boolean> = {
  health: (v) => isObject(v) && v.ok === true,
  created: (v) => isObject(v) && typeof v.id === "string" && ID_PATTERN.test(v.id) && typeof v.exp === "number" && Number.isFinite(v.exp),
  revoked: (v) => isObject(v) && typeof v.id === "string" && ID_PATTERN.test(v.id) && v.revoked === true,
  listed: (v) =>
    isObject(v) &&
    Array.isArray(v.links) &&
    v.links.length <= 100 &&
    v.links.every((l) => isObject(l) && typeof l.id === "string" && ID_PATTERN.test(l.id) && Number.isInteger(l.exp) && typeof l.revoked === "boolean"),
  stored: (v) =>
    isObject(v) &&
    typeof v.c === "string" &&
    v.c.length >= MIN_CIPHERTEXT_CHARS &&
    v.c.length <= MAX_CIPHERTEXT_CHARS &&
    BASE64URL_PATTERN.test(v.c) &&
    typeof v.iv === "string" &&
    v.iv.length === IV_CHARS &&
    BASE64URL_PATTERN.test(v.iv) &&
    Number.isInteger(v.exp),
};

export function createClient(options: ClientOptions): LinkClient {
  if (typeof options.baseUrl !== "string" || options.baseUrl === "") throw new TypeError("createClient needs a baseUrl");
  let origin: URL;
  try {
    origin = new URL(options.baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") throw new TypeError("baseUrl must be an http or https URL");
  if (origin.search !== "" || origin.hash !== "" || origin.username !== "" || origin.password !== "") {
    throw new TypeError("baseUrl must have no query, hash, or credentials");
  }
  for (const [name, key] of [["ownerKey", options.ownerKey], ["adminKey", options.adminKey]] as const) {
    if (key !== undefined && (typeof key !== "string" || !KEY_PATTERN.test(key))) throw new TypeError(`${name} must be 32 to 128 base64url characters`);
  }
  const root = `${origin.origin}${origin.pathname.replace(/\/+$/, "")}/api/v1`;
  // Read at call time so a test can swap the global. Call it with no `this`: a browser or Worker fetch refuses another one.
  const send = (input: string, init: RequestInit) => {
    const run = options.fetch ?? globalThis.fetch;
    return run(input, init);
  };

  async function call<T>(method: string, path: string, body: unknown, callOptions: CallOptions | undefined, shape: Shape, key?: string): Promise<T> {
    const response = await send(`${root}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: callOptions?.signal,
      // Never follow a redirect: it would send a write to another host.
      redirect: "manual",
    });
    const text = await readCapped(response, MAX_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = isObject(parsed) ? parsed.error : undefined;
      const code = isKnownCode(error) ? error : "unknown";
      const wait = response.status === 429 ? Number(response.headers.get("retry-after")) : NaN;
      throw new LinkApiError(code, response.status, `HTTP ${response.status}: ${code}`, Number.isFinite(wait) && wait > 0 ? wait : undefined);
    }
    if (!SHAPES[shape](parsed)) throw new LinkApiError("unknown", response.status, `the reply is not a ${shape}`);
    return parsed as T;
  }

  const methods: LinkClient = {
    health: async (o) => call("GET", "/health", undefined, o, "health"),
    createLink: async (input, o) => call("POST", "/links", input, o, "created", options.ownerKey),
    getLink: async (id, o) => {
      // The id has a fixed shape. Refuse anything else before a request, so it cannot reach another route.
      if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new TypeError("a link id is 10 characters from the link alphabet");
      return call("GET", `/links/${id}`, undefined, o, "stored");
    },
    revokeLink: async (id, o) => {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new TypeError("a link id is 10 characters from the link alphabet");
      const key = options.adminKey ?? options.ownerKey;
      if (key === undefined) throw new TypeError("revokeLink needs an ownerKey or an adminKey");
      return call("DELETE", `/links/${id}`, undefined, o, "revoked", key);
    },
    listLinks: async (o) => {
      const key = options.adminKey ?? options.ownerKey;
      if (key === undefined) throw new TypeError("listLinks needs an ownerKey or an adminKey");
      return (await call<{ links: ListedLink[] }>("GET", "/links", undefined, o, "listed", key)).links;
    },
  };

  return methods;
}
