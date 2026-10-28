import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { CodecError, decode, encode, fragmentOf, type CodecErrorCode } from "./codec.js";

// Failure modes first. Each test below names one way a hostile or broken link
// can hurt a reader. The codec exists to refuse them all.

const note = z.object({ title: z.string(), body: z.string() });

async function rawDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function fragmentFor(text: string, route = "/v1/notes/"): Promise<string> {
  return `#${route}${b64url(await rawDeflate(new TextEncoder().encode(text)))}`;
}

async function codeOf(run: () => Promise<unknown>): Promise<CodecErrorCode> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CodecError);
    return (error as CodecError).code;
  }
  throw new Error("expected the codec to refuse this input");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("round trip", () => {
  test("keeps unicode and nesting, and writes the documented route", async () => {
    const payload = { title: "Plan ✓", body: "line one\nline two — ünïcode 🦊", extra: { n: [1, 2, { ok: true }] } };
    const fragment = await encode({ app: "notes", version: 1, payload });
    expect(fragment).toMatch(/^#\/v1\/notes\/[A-Za-z0-9_-]+$/);
    const out = await decode(fragment, z.object({ title: z.string(), body: z.string(), extra: z.unknown() }));
    expect(out).toEqual({ app: "notes", version: 1, payload });
  });

  test("accepts the fragment without its leading hash, and a full URL through fragmentOf", async () => {
    const fragment = await encode({ app: "notes", version: 1, payload: { title: "a", body: "b" } });
    expect((await decode(fragment.slice(1), note)).payload.title).toBe("a");
    expect(fragmentOf(`https://example.test/open?x=1${fragment}`)).toBe(fragment);
    expect(fragmentOf("https://example.test/no-fragment")).toBe("");
  });
});

describe("shape of the route", () => {
  test.each([
    ["no payload", "#/v1/notes/"],
    ["no app", "#/v1//abc"],
    ["no version", "#/notes/abc"],
    ["extra segment", "#/v1/notes/abc/def"],
    ["upper-case app", "#/v1/Notes/abc"],
    ["app with a dot", "#/v1/no.tes/abc"],
    ["empty fragment", ""],
    ["hash only", "#"],
    ["not a route", "#hello"],
  ])("refuses %s", async (_name, fragment) => {
    expect(await codeOf(() => decode(fragment, note))).toBe("malformed");
  });

  test.each([["#/v2/notes/abc"], ["#/v0/notes/abc"], ["#/v01/notes/abc"], ["#/v1000000000000/notes/abc"]])(
    "refuses unknown version %s",
    async (fragment) => {
      expect(await codeOf(() => decode(fragment, note))).toBe("unsupported_version");
    },
  );

  test("refuses a vx version as malformed", async () => {
    expect(await codeOf(() => decode("#/vx/notes/abc", note))).toBe("malformed");
  });

  test("refuses a link for another app when the caller names one", async () => {
    const fragment = await encode({ app: "sheets", version: 1, payload: { title: "a", body: "b" } });
    expect(await codeOf(() => decode(fragment, note, { app: "notes" }))).toBe("wrong_app");
  });
});

describe("base64url", () => {
  test.each([
    ["padding", "="],
    ["standard alphabet plus", "+"],
    ["standard alphabet slash", "/"],
    ["whitespace", " "],
    ["percent escape", "%41"],
  ])("refuses %s", async (_name, junk) => {
    const fragment = await encode({ app: "notes", version: 1, payload: { title: "a", body: "b" } });
    expect(await codeOf(() => decode(fragment + junk, note))).toBe("malformed");
  });

  test("refuses a length that no byte string produces", async () => {
    expect(await codeOf(() => decode("#/v1/notes/abcde", note))).toBe("malformed");
  });

  test("refuses non-zero trailing bits, so one payload has one spelling", async () => {
    // "QQ" decodes to "A"; "QR" carries the same byte with stray bits set.
    expect(await codeOf(() => decode("#/v1/notes/QR", note))).toBe("malformed");
  });
});

describe("damaged compressed data", () => {
  test("refuses a link cut in half", async () => {
    const fragment = await encode({
      app: "notes",
      version: 1,
      payload: { title: "t", body: "x".repeat(500) + Math.random().toString(36).repeat(40) },
    });
    const cut = fragment.slice(0, Math.floor(fragment.length / 2) - (fragment.length % 4 === 1 ? 1 : 0));
    expect(await codeOf(() => decode(cut, note))).toMatch(/^(corrupt|malformed)$/);
  });

  test("refuses bytes that are not deflate data", async () => {
    expect(await codeOf(() => decode("#/v1/notes/_____________________", note))).toMatch(/^(corrupt|malformed)$/);
  });
});

describe("size caps", () => {
  test("refuses an oversize fragment before it inflates anything", async () => {
    const inflate = vi.fn(() => {
      throw new Error("the codec must not start inflating an oversize link");
    });
    vi.stubGlobal("DecompressionStream", inflate);
    const huge = `#/v1/notes/${"A".repeat(200_000)}`;
    expect(await codeOf(() => decode(huge, note))).toBe("too_large");
    expect(inflate).not.toHaveBeenCalled();
  });

  test("honours a lower compressed cap the caller sets", async () => {
    const fragment = await encode({ app: "notes", version: 1, payload: { title: "t", body: "z".repeat(2000) } });
    expect(await codeOf(() => decode(fragment, note, { limits: { maxCompressedBytes: 8 } }))).toBe("too_large");
  });

  test("stops a zip bomb at the inflated cap without reading it all", async () => {
    // 64 MiB of zeros deflates to about 64 KiB: under the compressed cap, far over the inflated cap.
    const bomb = await rawDeflate(new Uint8Array(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(80 * 1024);
    const started = Date.now();
    const fragment = `#/v1/notes/${b64url(bomb)}`;
    expect(await codeOf(() => decode(fragment, note, { limits: { maxCompressedBytes: 128 * 1024, maxRatio: 100_000 } }))).toBe(
      "too_large",
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("refuses a high expansion ratio even when the inflated size is under the cap", async () => {
    const text = JSON.stringify({ title: "t", body: "a".repeat(900_000) });
    const fragment = await fragmentFor(text);
    expect(await codeOf(() => decode(fragment, note))).toBe("bomb");
  });

  test("lets a small, very repetitive document through", async () => {
    const payload = { title: "t", body: "a".repeat(5000) };
    const fragment = await encode({ app: "notes", version: 1, payload });
    expect((await decode(fragment, note)).payload).toEqual(payload);
  });

  test("encode refuses a document that would not fit the caps", async () => {
    const noise = Array.from({ length: 200_000 }, () => Math.random().toString(36)).join("");
    await expect(encode({ app: "notes", version: 1, payload: { title: "t", body: noise } })).rejects.toMatchObject({
      code: "too_large",
    });
  });
});

describe("hostile JSON", () => {
  test.each([
    ["__proto__ at the top", '{"__proto__":{"admin":true},"title":"a","body":"b"}'],
    ["__proto__ nested", '{"title":"a","body":"b","meta":{"list":[{"__proto__":{"admin":true}}]}}'],
    ["constructor key", '{"title":"a","body":"b","constructor":{"prototype":{"admin":true}}}'],
    ["prototype key", '{"title":"a","body":"b","prototype":{}}'],
  ])("refuses %s", async (_name, json) => {
    expect(await codeOf(async () => decode(await fragmentFor(json), z.unknown()))).toBe("forbidden_key");
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  test("refuses text that is not JSON", async () => {
    expect(await codeOf(async () => decode(await fragmentFor("not json at all"), z.unknown()))).toBe("not_json");
    expect(await codeOf(async () => decode(await fragmentFor(""), z.unknown()))).toBe("not_json");
    expect(await codeOf(async () => decode(await fragmentFor('{"title":'), z.unknown()))).toBe("not_json");
  });

  test("refuses bytes that are not UTF-8", async () => {
    const bad = await rawDeflate(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    expect(await codeOf(() => decode(`#/v1/notes/${b64url(bad)}`, z.unknown()))).toBe("not_json");
  });

  test("refuses nesting deep enough to threaten the stack", async () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    const fragment = await fragmentFor(deep);
    expect(await codeOf(() => decode(fragment, z.unknown(), { limits: { maxRatio: 100_000 } }))).toBe("too_deep");
  });
});

describe("schema", () => {
  test("refuses a payload that fails the caller's schema, without echoing it", async () => {
    const fragment = await fragmentFor('{"title":"SECRET-TITLE","body":42}');
    try {
      await decode(fragment, note);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as CodecError).code).toBe("schema");
      expect((error as Error).message).not.toContain("SECRET-TITLE");
    }
  });

  test("returns what the schema returns, so a schema can narrow or transform", async () => {
    const fragment = await encode({ app: "notes", version: 1, payload: { title: "a", body: "b" } });
    const upper = z.object({ title: z.string().transform((s) => s.toUpperCase()), body: z.string() });
    expect((await decode(fragment, upper)).payload.title).toBe("A");
  });
});

describe("encode input", () => {
  test.each([
    ["empty app", { app: "", version: 1, payload: {} }],
    ["upper-case app", { app: "Notes", version: 1, payload: {} }],
    ["app with a slash", { app: "a/b", version: 1, payload: {} }],
    ["unknown version", { app: "notes", version: 2, payload: {} }],
    ["fractional version", { app: "notes", version: 1.5, payload: {} }],
    ["undefined payload", { app: "notes", version: 1, payload: undefined }],
    ["function payload", { app: "notes", version: 1, payload: () => 1 }],
    ["bigint payload", { app: "notes", version: 1, payload: { n: 1n } }],
    ["prototype key", { app: "notes", version: 1, payload: JSON.parse('{"__proto__":{"x":1}}') }],
  ])("refuses %s", async (_name, input) => {
    await expect(encode(input as never)).rejects.toBeInstanceOf(CodecError);
  });

  test("refuses a cyclic payload", async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(encode({ app: "notes", version: 1, payload: cycle })).rejects.toBeInstanceOf(CodecError);
  });
});
