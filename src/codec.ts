/**
 * The fragment codec. A snapshot becomes `#/v1/<app>/<base64url(deflate(json))>`.
 * A browser never sends the fragment to a server, so the link carries the
 * document and no server reads it.
 *
 * Every link is hostile input. decode() checks size before it inflates, caps
 * the inflated size and the expansion ratio while it inflates, refuses unknown
 * versions and prototype keys, and runs the caller's schema last.
 *
 * Only web-standard APIs are used (CompressionStream, TextDecoder), so the same
 * code runs in browsers, Workers, and Node 22.
 */

export type CodecErrorCode =
  | "malformed"
  | "unsupported_version"
  | "wrong_app"
  | "too_large"
  | "bomb"
  | "corrupt"
  | "not_json"
  | "too_deep"
  | "forbidden_key"
  | "schema"
  | "sealed"
  | "not_sealed"
  | "unencodable";

export class CodecError extends Error {
  readonly code: CodecErrorCode;
  constructor(code: CodecErrorCode, message: string) {
    super(message);
    this.name = "CodecError";
    this.code = code;
  }
}

export interface Limits {
  /** Most compressed bytes a link may carry. */
  maxCompressedBytes: number;
  /** Most bytes the payload JSON may inflate to. */
  maxInflatedBytes: number;
  /** Most inflated bytes per compressed byte. Applies once output passes ratioFloorBytes. */
  maxRatio: number;
  /** Small documents may repeat a lot; the ratio check ignores output below this size. */
  ratioFloorBytes: number;
  /** Most nesting depth in the payload JSON. */
  maxDepth: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxCompressedBytes: 64 * 1024,
  maxInflatedBytes: 1024 * 1024,
  maxRatio: 100,
  ratioFloorBytes: 64 * 1024,
  maxDepth: 64,
});

/** Link format versions this codec reads and writes. */
export const SUPPORTED_VERSIONS: readonly number[] = [1];

/** Anything with zod's `safeParse` shape works as a schema. */
export interface Schema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error?: unknown };
}

export interface Snapshot<T = unknown> {
  app: string;
  version: number;
  payload: T;
}

export interface DecodeOptions {
  /** Refuse links made for any other app. */
  app?: string;
  limits?: Partial<Limits>;
}

const APP_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** A sealed payload starts with this. It is not in the base64url alphabet, so plain links never do. */
export const SEALED_MARK = "~";
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function limitsFrom(partial?: Partial<Limits>): Limits {
  const limits = { ...DEFAULT_LIMITS, ...partial };
  for (const value of Object.values(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new CodecError("malformed", "limits must be positive numbers");
  }
  return limits;
}

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!;
  }
  return out;
}

/** Strict: no padding, no stray bits, so one byte string has one spelling. */
export function fromBase64Url(text: string): Uint8Array {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new CodecError("malformed", "payload is not base64url");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const ch of text) {
    buffer = (buffer << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new CodecError("malformed", "payload has stray bits");
  return out;
}

/** The part of a URL after the first `#`, with the `#`. Empty when there is none. */
export function fragmentOf(url: string): string {
  const at = url.indexOf("#");
  return at === -1 ? "" : url.slice(at);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate while counting. Stops reading the moment a cap is crossed. */
async function inflateCapped(bytes: Uint8Array, limits: Limits): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // A write failure shows up on the reader as the same error; keep it from going unhandled.
  void writer.write(bytes as BufferSource).then(() => writer.close()).catch(() => {});
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limits.maxInflatedBytes) {
        throw new CodecError("too_large", "payload inflates past the size cap");
      }
      if (total > limits.ratioFloorBytes && total > limits.maxRatio * bytes.length) {
        throw new CodecError("bomb", "payload expands too much for its size");
      }
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof CodecError) throw error;
    throw new CodecError("corrupt", "payload is not valid compressed data");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function parseJson(bytes: Uint8Array, maxDepth: number): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CodecError("not_json", "payload is not UTF-8 text");
  }
  // Scan nesting first, so a deep document never reaches the recursive parser.
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") {
      if (++depth > maxDepth) throw new CodecError("too_deep", "payload nests too deeply");
    } else if (ch === "]" || ch === "}") depth--;
  }
  try {
    return JSON.parse(text, (key, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) throw new CodecError("forbidden_key", "payload uses a reserved key");
      return value;
    });
  } catch (error) {
    if (error instanceof CodecError) throw error;
    throw new CodecError("not_json", "payload is not JSON");
  }
}

function assertCleanKeys(value: unknown, depth: number, maxDepth: number): void {
  if (depth > maxDepth) throw new CodecError("too_deep", "payload nests too deeply");
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new CodecError("forbidden_key", "payload uses a reserved key");
    assertCleanKeys((value as Record<string, unknown>)[key], depth + 1, maxDepth);
  }
}

/** Validate a snapshot and return its deflated JSON. Shared by plain and sealed links. */
export async function packSnapshot(snapshot: Snapshot, limits: Limits): Promise<Uint8Array> {
  const { app, version, payload } = snapshot;
  if (typeof app !== "string" || !APP_PATTERN.test(app)) {
    throw new CodecError("malformed", "app must be lower-case letters, digits, and dashes");
  }
  if (!Number.isInteger(version) || !SUPPORTED_VERSIONS.includes(version)) {
    throw new CodecError("unsupported_version", `link version ${String(version)} is not supported`);
  }
  let json: string | undefined;
  try {
    assertCleanKeys(payload, 0, limits.maxDepth);
    json = JSON.stringify(payload);
  } catch (error) {
    if (error instanceof CodecError) throw error;
    throw new CodecError("unencodable", "payload cannot be written as JSON");
  }
  if (json === undefined) throw new CodecError("unencodable", "payload cannot be written as JSON");
  const raw = new TextEncoder().encode(json);
  if (raw.length > limits.maxInflatedBytes) throw new CodecError("too_large", "payload is over the size cap");
  const packed = await deflate(raw);
  if (packed.length > limits.maxCompressedBytes) throw new CodecError("too_large", "link is over the size cap");
  return packed;
}

/** Inflate under the caps, parse, and run the schema. Shared by plain and sealed links. */
export async function unpackSnapshot<T>(packed: Uint8Array, schema: Schema<T>, limits: Limits): Promise<T> {
  const inflated = await inflateCapped(packed, limits);
  const value = parseJson(inflated, limits.maxDepth);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CodecError("schema", "payload does not match the expected shape");
  return parsed.data;
}

export interface Route {
  app: string;
  version: number;
  /** The payload text after the app, not yet decoded. */
  encoded: string;
}

/** Split `#/v<n>/<app>/<payload>` and check everything that needs no payload work. */
export function parseRoute(fragment: string, limits: Limits, expectedApp?: string, extraChars = 0): Route {
  const route = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const maxChars = Math.ceil(((limits.maxCompressedBytes + extraChars) * 4) / 3) + 4;
  // Cheapest check first: nothing is split, decoded, or inflated while the link is oversize.
  if (route.length > maxChars + 70) throw new CodecError("too_large", "link is over the size cap");
  const match = /^\/v(\d+)\/([^/]*)\/([^/]*)$/.exec(route);
  if (!match) throw new CodecError("malformed", "link is not /v<n>/<app>/<payload>");
  const [, versionText, app, encoded] = match as unknown as [string, string, string, string];
  const version = Number(versionText);
  if (versionText !== String(version) || !SUPPORTED_VERSIONS.includes(version)) {
    throw new CodecError("unsupported_version", "link version is not supported");
  }
  if (!APP_PATTERN.test(app)) throw new CodecError("malformed", "link app name is not valid");
  if (expectedApp !== undefined && expectedApp !== app) throw new CodecError("wrong_app", "link is for another app");
  if (encoded.length === 0) throw new CodecError("malformed", "link has no payload");
  return { app, version, encoded };
}

export async function encode(snapshot: Snapshot, options: { limits?: Partial<Limits> } = {}): Promise<string> {
  const packed = await packSnapshot(snapshot, limitsFrom(options.limits));
  return `#/v${snapshot.version}/${snapshot.app}/${toBase64Url(packed)}`;
}

export async function decode<T>(
  fragment: string,
  schema: Schema<T>,
  options: DecodeOptions = {},
): Promise<Snapshot<T>> {
  const limits = limitsFrom(options.limits);
  const { app, version, encoded } = parseRoute(fragment, limits, options.app);
  if (encoded.startsWith(SEALED_MARK)) throw new CodecError("sealed", "link is sealed with a password");
  if (encoded.length > Math.ceil((limits.maxCompressedBytes * 4) / 3) + 4) {
    throw new CodecError("too_large", "link is over the size cap");
  }
  const packed = fromBase64Url(encoded);
  if (packed.length > limits.maxCompressedBytes) throw new CodecError("too_large", "link is over the size cap");
  return { app, version, payload: await unpackSnapshot(packed, schema, limits) };
}
