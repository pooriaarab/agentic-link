import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { CodecError } from "./codec.js";
import {
  decodeSealed,
  DEFAULT_ITERATIONS,
  encodeSealed,
  isSealed,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  openBytes,
  SealError,
  sealBytes,
} from "./seal.js";

// Failure modes first. A sealed link must open with the right password and
// with nothing else. Every change to the link must make it refuse, and a wrong
// password must look the same as a changed link.

const note = z.object({ title: z.string(), body: z.string() });
const snapshot = { app: "notes", version: 1, payload: { title: "Plan", body: "secret body ✓" } };
const PASSWORD = "correct horse battery staple";
const aad = new TextEncoder().encode("v1/notes");

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as SealError | CodecError).code;
  }
  throw new Error("expected a refusal");
}

function fromB64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}
function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("round trip", () => {
  test("opens with the right password and writes a sealed route", async () => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    expect(fragment).toMatch(/^#\/v1\/notes\/~[A-Za-z0-9_-]+$/);
    expect(isSealed(fragment)).toBe(true);
    expect(isSealed(fragment.slice(1))).toBe(true);
    const out = await decodeSealed(fragment, PASSWORD, note);
    expect(out).toEqual(snapshot);
  });

  test("does not put the content or the password in the link", async () => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    expect(fragment).not.toContain("secret");
    expect(fragment).not.toContain("horse");
  });

  test("two seals of the same input differ: random salt and IV", async () => {
    const a = await encodeSealed(snapshot, PASSWORD);
    const b = await encodeSealed(snapshot, PASSWORD);
    expect(a).not.toBe(b);
    const sa = fromB64(a.split("/~")[1]!);
    const sb = fromB64(b.split("/~")[1]!);
    expect(Buffer.from(sa.slice(5, 21)).equals(Buffer.from(sb.slice(5, 21)))).toBe(false); // salt
    expect(Buffer.from(sa.slice(21, 33)).equals(Buffer.from(sb.slice(21, 33)))).toBe(false); // iv
  });

  test("treats equivalent Unicode spellings of a password as one password", async () => {
    const fragment = await encodeSealed(snapshot, "ｐａｓｓｗｏｒｄ１２３４"); // full-width
    expect((await decodeSealed(fragment, "password1234", note)).payload.title).toBe("Plan");
  });

  test("header names version 1 and the default iteration count", async () => {
    const bytes = fromB64((await encodeSealed(snapshot, PASSWORD)).split("/~")[1]!);
    expect(bytes[0]).toBe(1);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(1)).toBe(DEFAULT_ITERATIONS);
    expect(DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });
});

describe("wrong password and tampering fail closed with one error", () => {
  test("a wrong password", async () => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    expect(await codeOf(() => decodeSealed(fragment, "not the password", note))).toBe("open_failed");
  });

  test("a password that differs only by case or a trailing space", async () => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    expect(await codeOf(() => decodeSealed(fragment, PASSWORD.toUpperCase(), note))).toBe("open_failed");
    expect(await codeOf(() => decodeSealed(fragment, PASSWORD + " ", note))).toBe("open_failed");
  });

  test.each([
    ["the iteration count", 2],
    ["the salt", 10],
    ["the IV", 25],
    ["the ciphertext", 40],
    ["the tag", -1],
  ])("a flipped bit in %s", async (_name, index) => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    const [head, body] = fragment.split("/~") as [string, string];
    const bytes = fromB64(body);
    const at = index < 0 ? bytes.length + index : index;
    bytes[at] = bytes[at]! ^ 1;
    const code = await codeOf(() => decodeSealed(`${head}/~${toB64(bytes)}`, PASSWORD, note));
    // The iteration count may leave the allowed range; otherwise the tag must refuse.
    expect(["open_failed", "bad_iterations"]).toContain(code);
  });

  test("a changed version byte", async () => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    const [head, body] = fragment.split("/~") as [string, string];
    const bytes = fromB64(body);
    bytes[0] = 2;
    expect(await codeOf(() => decodeSealed(`${head}/~${toB64(bytes)}`, PASSWORD, note))).toBe("unsupported_version");
  });

  test("bytes added at the end, and bytes cut from the end", async () => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    const [head, body] = fragment.split("/~") as [string, string];
    const bytes = fromB64(body);
    const longer = new Uint8Array([...bytes, 0]);
    expect(await codeOf(() => decodeSealed(`${head}/~${toB64(longer)}`, PASSWORD, note))).toBe("open_failed");
    const shorter = bytes.slice(0, bytes.length - 1);
    expect(await codeOf(() => decodeSealed(`${head}/~${toB64(shorter)}`, PASSWORD, note))).toBe("open_failed");
  });

  test.each([[0], [1], [20], [32], [48]])("a payload cut to %i bytes is malformed or refused", async (keep) => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    const [head, body] = fragment.split("/~") as [string, string];
    const cut = fromB64(body).slice(0, keep);
    const code = await codeOf(() => decodeSealed(`${head}/~${toB64(cut)}`, PASSWORD, note));
    expect(["malformed", "open_failed"]).toContain(code);
  });

  test("the route is authenticated: another app or version name does not open it", async () => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    const moved = fragment.replace("/v1/notes/", "/v1/sheets/");
    expect(await codeOf(() => decodeSealed(moved, PASSWORD, note))).toBe("open_failed");
  });

  test("the app option still refuses a link for another app before any key work", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    const fragment = await encodeSealed(snapshot, PASSWORD);
    derive.mockClear();
    expect(await codeOf(() => decodeSealed(fragment, PASSWORD, note, { app: "sheets" }))).toBe("wrong_app");
    expect(derive).not.toHaveBeenCalled();
  });
});

describe("iteration count in the header is hostile input", () => {
  function withIterations(bytes: Uint8Array, count: number): Uint8Array {
    const out = new Uint8Array(bytes);
    new DataView(out.buffer).setUint32(1, count);
    return out;
  }

  test.each([[0], [1], [MIN_ITERATIONS - 1], [MAX_ITERATIONS + 1], [0xffffffff]])(
    "refuses %i before it derives any key",
    async (count) => {
      const fragment = await encodeSealed(snapshot, PASSWORD);
      const [head, body] = fragment.split("/~") as [string, string];
      const derive = vi.spyOn(crypto.subtle, "deriveKey");
      const forged = withIterations(fromB64(body), count);
      expect(await codeOf(() => decodeSealed(`${head}/~${toB64(forged)}`, PASSWORD, note))).toBe("bad_iterations");
      expect(derive).not.toHaveBeenCalled();
    },
  );

  test("seal refuses an iteration count outside the range", async () => {
    await expect(encodeSealed(snapshot, PASSWORD, { iterations: MIN_ITERATIONS - 1 })).rejects.toMatchObject({
      code: "bad_iterations",
    });
    await expect(encodeSealed(snapshot, PASSWORD, { iterations: MAX_ITERATIONS + 1 })).rejects.toMatchObject({
      code: "bad_iterations",
    });
  });
});

describe("passwords", () => {
  test("an empty password is refused on seal and on open", async () => {
    await expect(encodeSealed(snapshot, "")).rejects.toMatchObject({ code: "bad_password" });
    const fragment = await encodeSealed(snapshot, PASSWORD);
    expect(await codeOf(() => decodeSealed(fragment, "", note))).toBe("bad_password");
  });

  test("a password that is not a string is refused", async () => {
    await expect(encodeSealed(snapshot, undefined as never)).rejects.toMatchObject({ code: "bad_password" });
    await expect(encodeSealed(snapshot, 1234 as never)).rejects.toMatchObject({ code: "bad_password" });
  });
});

describe("routes", () => {
  test("plain decode names a sealed link instead of reading it", async () => {
    const { decode } = await import("./codec.js");
    const fragment = await encodeSealed(snapshot, PASSWORD);
    expect(await codeOf(() => decode(fragment, note))).toBe("sealed");
  });

  test("decodeSealed refuses a link that is not sealed", async () => {
    const { encode } = await import("./codec.js");
    const plain = await encode(snapshot);
    expect(isSealed(plain)).toBe(false);
    expect(await codeOf(() => decodeSealed(plain, PASSWORD, note))).toBe("not_sealed");
  });

  test("a sealed link over the size cap is refused before key work", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    const huge = `#/v1/notes/~${"A".repeat(200_000)}`;
    expect(await codeOf(() => decodeSealed(huge, PASSWORD, note))).toBe("too_large");
    expect(derive).not.toHaveBeenCalled();
  });
});

describe("after the right password, the content is still hostile", () => {
  test("a schema failure is refused without echoing content", async () => {
    const fragment = await encodeSealed(snapshot, PASSWORD);
    try {
      await decodeSealed(fragment, PASSWORD, z.object({ title: z.number() }));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as CodecError).code).toBe("schema");
      expect((error as Error).message).not.toContain("secret");
    }
  });

  test("a zip bomb sealed under a known password is still capped", async () => {
    const stream = new Blob([new Uint8Array(64 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const bomb = new Uint8Array(await new Response(stream).arrayBuffer());
    const sealed = await sealBytes(bomb, PASSWORD, aad);
    const fragment = `#/v1/notes/~${toB64(sealed)}`;
    const limits = { maxCompressedBytes: 128 * 1024, maxRatio: 100_000 };
    expect(await codeOf(() => decodeSealed(fragment, PASSWORD, note, { limits }))).toBe("too_large");
  });
});

describe("agrees with an independent implementation", () => {
  test("a fixed salt and IV give the bytes Node's own crypto gives", async () => {
    const salt = new Uint8Array(16).map((_, i) => i + 1);
    const iv = new Uint8Array(12).map((_, i) => 100 + i);
    const plain = new TextEncoder().encode("known answer");
    const ours = await sealBytes(plain, "hunter2 ünï", aad, { salt, iv });

    const header = new Uint8Array(21);
    header[0] = 1;
    new DataView(header.buffer).setUint32(1, DEFAULT_ITERATIONS);
    header.set(salt, 5);
    const key = pbkdf2Sync("hunter2 ünï".normalize("NFKC"), salt, DEFAULT_ITERATIONS, 32, "sha256");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from([...header, ...aad]));
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const theirs = new Uint8Array([...header, ...iv, ...body]);

    expect(Buffer.from(ours).equals(Buffer.from(theirs))).toBe(true);
    expect(new TextDecoder().decode(await openBytes(theirs, "hunter2 ünï", aad))).toBe("known answer");
  });
});

describe("WebCrypto only", () => {
  test("the sealing code imports no crypto library and no Node module", () => {
    const source = readFileSync(new URL("./seal.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'](node:|crypto|buffer)/);
    expect(source).not.toMatch(/require\(/);
  });
});
