/**
 * The four operations, once. The CLI and the MCP server both call these, so
 * every face returns the same shape and refuses the same things.
 */
import { z } from "zod";
import { CodecError, decode, encode, fragmentOf, type Snapshot } from "./codec.js";
import { decodeSealed, encodeSealed, isSealed, SealError } from "./seal.js";
import { resolveShort, shorten, ShortError } from "./short.js";
import { ID_PATTERN, KEY_CHARS } from "./short-protocol.js";

export class UsageError extends Error {
  constructor(message: string, readonly code: "usage" | "not_configured" = "usage") {
    super(message);
    this.name = "UsageError";
  }
}

/** A refusal or failure as plain data. The message never carries document content. */
export function describeError(error: unknown): { error: string; message: string } {
  if (error instanceof CodecError || error instanceof SealError || error instanceof ShortError) {
    return { error: error.code, message: error.message };
  }
  if (error instanceof UsageError) return { error: error.code, message: error.message };
  return { error: "internal", message: "unexpected failure" };
}

const anything = z.unknown();

export async function encodeLink(input: {
  app: string;
  payload: unknown;
  password?: string;
  base?: string;
}): Promise<string> {
  if (input.base !== undefined && input.base.includes("#")) throw new UsageError("base must not contain a fragment");
  const snapshot: Snapshot = { app: input.app, version: 1, payload: input.payload };
  const fragment =
    input.password === undefined ? await encode(snapshot) : await encodeSealed(snapshot, input.password);
  return `${input.base ?? ""}${fragment}`;
}

export async function decodeLink(input: { link: string; password?: string; app?: string }): Promise<Snapshot> {
  const fragment = fragmentOf(input.link) || input.link;
  const options = { app: input.app };
  if (isSealed(fragment)) {
    if (input.password === undefined) throw new CodecError("sealed", "link is sealed with a password");
    return decodeSealed(fragment, input.password, anything, options);
  }
  return decode(fragment, anything, options);
}

export async function shortenLink(input: { link: string; endpoint?: string; ttl?: number }): Promise<{
  url: string;
  expiresAt: number;
}> {
  if (!input.endpoint) throw new UsageError("no endpoint: pass --endpoint or set AGENTIC_LINK_ENDPOINT", "not_configured");
  const { url, expiresAt } = await shorten(input.link, { endpoint: input.endpoint, ttl: input.ttl });
  return { url, expiresAt };
}

/** Whether a string is a short URL: `<origin>/s/<id>#<key>`. */
export function isShortUrl(text: string): boolean {
  try {
    const url = new URL(text);
    const match = /^\/s\/([^/]+)$/.exec(url.pathname);
    return match !== null && ID_PATTERN.test(match[1]!) && url.hash.length === KEY_CHARS + 1;
  } catch {
    return false;
  }
}

export async function openLink(input: {
  link: string;
  password?: string;
  app?: string;
  allowedHosts?: string[];
}): Promise<Snapshot> {
  const link = isShortUrl(input.link) ? await resolveShort(input.link, { allowedHosts: input.allowedHosts }) : input.link;
  return decodeLink({ link, password: input.password, app: input.app });
}
