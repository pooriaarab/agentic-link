// A typed client for the short-link Worker HTTP API. It uses only fetch, URL, and AbortSignal, so
// it runs in browsers, Workers, and Node 22. The service is anonymous: it has no bearer token, so
// the client sends none. It never retries: a retry of a create could store a second link.
import { ID_PATTERN } from "./short-protocol.js";

/** Codes the Worker returns. */
export type ApiErrorCode =
  | "bad_request"
  | "too_large"
  | "rate_limited"
  | "not_found"
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

export interface LinkClient {
  health(options?: CallOptions): Promise<{ ok: true }>;
  createLink(input: NewLink, options?: CallOptions): Promise<CreatedLink>;
  getLink(id: string, options?: CallOptions): Promise<StoredLink>;
}

type Shape = "health" | "created" | "stored";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SHAPES: Record<Shape, (v: unknown) => boolean> = {
  health: (v) => isObject(v) && v.ok === true,
  created: (v) => isObject(v) && typeof v.id === "string" && ID_PATTERN.test(v.id) && typeof v.exp === "number" && Number.isFinite(v.exp),
  stored: (v) => isObject(v) && typeof v.c === "string" && typeof v.iv === "string" && typeof v.exp === "number" && Number.isFinite(v.exp),
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
  const root = `${origin.origin}${origin.pathname.replace(/\/+$/, "")}/api/v1`;
  // Read at call time so a test can swap the global.
  const send = (input: string, init: RequestInit) => (options.fetch === undefined ? globalThis.fetch(input, init) : options.fetch(input, init));

  async function call<T>(method: string, path: string, body: unknown, callOptions: CallOptions | undefined, shape: Shape): Promise<T> {
    const response = await send(`${root}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: callOptions?.signal,
      // Never follow a redirect: it would send a write to another host.
      redirect: "manual",
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = isObject(parsed) ? parsed.error : undefined;
      const code = isKnownCode(error) ? error : "unknown";
      const wait = Number(response.headers.get("retry-after"));
      throw new LinkApiError(code, response.status, `HTTP ${response.status}: ${code}`, Number.isFinite(wait) && wait > 0 ? wait : undefined);
    }
    if (!SHAPES[shape](parsed)) throw new LinkApiError("unknown", response.status, `the reply is not a ${shape}`);
    return parsed as T;
  }

  const methods: LinkClient = {
    health: (o) => call("GET", "/health", undefined, o, "health"),
    createLink: (input, o) => call("POST", "/links", input, o, "created"),
    getLink: (id, o) => {
      // The id has a fixed shape. Refuse anything else before a request, so it cannot reach another route.
      if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new TypeError("a link id is 10 characters from the link alphabet");
      return call("GET", `/links/${id}`, undefined, o, "stored");
    },
  };

  // A refused id throws inside a method, before any request. Every method returns a promise.
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [name, async (...args: unknown[]) => (method as (...a: unknown[]) => Promise<unknown>)(...args)]),
  ) as unknown as LinkClient;
}
