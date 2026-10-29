/**
 * Password mode. A sealed link keeps the document encrypted in the fragment.
 *
 * Bytes, in order:
 *   version (1) | PBKDF2 iterations (4, big-endian) | salt (16) | IV (12) | AES-256-GCM ciphertext + tag (16)
 *
 * The key comes from PBKDF2-SHA256 over the NFKC-normalised password. The
 * additional data is the header plus the route (`v1/<app>`), so a changed
 * version, iteration count, salt, app name, IV, or byte of ciphertext fails the
 * tag. A wrong password fails the same tag, so the two cannot be told apart.
 *
 * WebCrypto only. No other crypto code is used.
 */
import {
  CodecError,
  fromBase64Url,
  limitsFrom,
  packSnapshot,
  parseRoute,
  SEALED_MARK,
  toBase64Url,
  unpackSnapshot,
  type DecodeOptions,
  type Limits,
  type Schema,
  type Snapshot,
} from "./codec.js";

export type SealErrorCode = "bad_password" | "bad_iterations" | "unsupported_version" | "malformed" | "open_failed";

export class SealError extends Error {
  readonly code: SealErrorCode;
  constructor(code: SealErrorCode, message: string) {
    super(message);
    this.name = "SealError";
    this.code = code;
  }
}

export const SEAL_VERSION = 1;
/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Links below it are refused, so a forged header cannot downgrade the key. */
export const MIN_ITERATIONS = 600_000;
export const DEFAULT_ITERATIONS = 600_000;
/** A forged header cannot make a reader spend more than this. */
export const MAX_ITERATIONS = 2_000_000;

const HEADER_BYTES = 1 + 4 + 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bytes a sealed payload adds to the compressed document. */
export const SEAL_OVERHEAD = HEADER_BYTES + IV_BYTES + TAG_BYTES;

export interface SealOptions {
  iterations?: number;
  limits?: Partial<Limits>;
}

export interface SealParts {
  salt?: Uint8Array;
  iv?: Uint8Array;
  iterations?: number;
}

function checkIterations(count: number): void {
  if (!Number.isInteger(count) || count < MIN_ITERATIONS || count > MAX_ITERATIONS) {
    throw new SealError("bad_iterations", `iterations must be from ${MIN_ITERATIONS} to ${MAX_ITERATIONS}`);
  }
}

function passwordBytes(password: unknown): Uint8Array {
  if (typeof password !== "string" || password.length === 0) {
    throw new SealError("bad_password", "password must be a non-empty string");
  }
  return new TextEncoder().encode(password.normalize("NFKC"));
}

async function deriveKey(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", password as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Encrypt bytes. `aad` is extra data the tag covers. `parts` fixes salt, IV, and iterations for known-answer tests only. */
export async function sealBytes(
  plain: Uint8Array,
  password: string,
  aad: Uint8Array,
  parts: SealParts = {},
): Promise<Uint8Array> {
  const secret = passwordBytes(password);
  const iterations = parts.iterations ?? DEFAULT_ITERATIONS;
  checkIterations(iterations);
  const salt = parts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const iv = parts.iv ?? crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = SEAL_VERSION;
  new DataView(header.buffer).setUint32(1, iterations);
  header.set(salt, 5);
  const key = await deriveKey(secret, salt, iterations);
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: join(header, aad) as BufferSource },
      key,
      plain as BufferSource,
    ),
  );
  return join(header, iv, body);
}

/** Decrypt bytes made by sealBytes. Every header field is checked before any key work. */
export async function openBytes(sealed: Uint8Array, password: string, aad: Uint8Array): Promise<Uint8Array> {
  const secret = passwordBytes(password);
  if (sealed.length < SEAL_OVERHEAD) throw new SealError("malformed", "sealed data is too short");
  if (sealed[0] !== SEAL_VERSION) throw new SealError("unsupported_version", "sealed version is not supported");
  const header = sealed.slice(0, HEADER_BYTES);
  const iterations = new DataView(header.buffer).getUint32(1);
  checkIterations(iterations);
  const iv = sealed.slice(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
  const body = sealed.slice(HEADER_BYTES + IV_BYTES);
  const key = await deriveKey(secret, header.slice(5), iterations);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: join(header, aad) as BufferSource },
        key,
        body as BufferSource,
      ),
    );
  } catch {
    throw new SealError("open_failed", "wrong password, or the link was changed");
  }
}

/** Whether a fragment (or its route) holds a sealed payload. */
export function isSealed(fragment: string): boolean {
  return /^#?\/v\d+\/[^/]*\/~/.test(fragment);
}

const routeData = (version: number, app: string): Uint8Array => new TextEncoder().encode(`v${version}/${app}`);

export async function encodeSealed(snapshot: Snapshot, password: string, options: SealOptions = {}): Promise<string> {
  const limits = limitsFrom(options.limits);
  const packed = await packSnapshot(snapshot, limits);
  const sealed = await sealBytes(packed, password, routeData(snapshot.version, snapshot.app), {
    iterations: options.iterations,
  });
  return `#/v${snapshot.version}/${snapshot.app}/${SEALED_MARK}${toBase64Url(sealed)}`;
}

export async function decodeSealed<T>(
  fragment: string,
  password: string,
  schema: Schema<T>,
  options: DecodeOptions = {},
): Promise<Snapshot<T>> {
  const limits = limitsFrom(options.limits);
  const { app, version, encoded } = parseRoute(fragment, limits, options.app, SEAL_OVERHEAD);
  if (!encoded.startsWith(SEALED_MARK)) throw new CodecError("not_sealed", "link is not sealed");
  const text = encoded.slice(SEALED_MARK.length);
  if (text.length > Math.ceil(((limits.maxCompressedBytes + SEAL_OVERHEAD) * 4) / 3) + 4) {
    throw new CodecError("too_large", "link is over the size cap");
  }
  const sealed = fromBase64Url(text);
  if (sealed.length > limits.maxCompressedBytes + SEAL_OVERHEAD) {
    throw new CodecError("too_large", "link is over the size cap");
  }
  const packed = await openBytes(sealed, password, routeData(version, app));
  return { app, version, payload: await unpackSnapshot(packed, schema, limits) };
}
