import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createClient, LinkApiError, type LinkClient } from "./client.js";
import { start, stop, type Running } from "./e2e-harness.js";

// The client against the real Worker under `wrangler dev`, with a real D1 file.
let main: Running;
let limited: Running;
let links: LinkClient;
const BRAKE_KEY = "test-brake-key-0123456789abcdef-0123456789";
const b64 = (n: number) => "A".repeat(n);

async function refusal(promise: Promise<unknown>): Promise<LinkApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LinkApiError);
  return error as LinkApiError;
}

beforeAll(async () => {
  main = await start({ BRAKE_KEY });
  limited = await start({ BRAKE_KEY, DAILY_LIMIT: "1" });
  links = createClient({ baseUrl: `http://127.0.0.1:${main.port}/` });
}, 240_000);

afterAll(() => {
  if (main) stop(main);
  if (limited) stop(limited);
});

describe("createClient against the Worker", () => {
  test("health, create, and get walk every route", async () => {
    expect(await links.health()).toEqual({ ok: true });
    const before = Date.now();
    const made = await links.createLink({ c: b64(64), iv: b64(16), ttl: 3600 });
    expect(made.id).toMatch(/^[a-km-np-z2-9]{10}$/);
    expect(made.exp).toBeGreaterThan(before + 3_500_000);
    expect(await links.getLink(made.id)).toEqual({ c: b64(64), iv: b64(16), exp: made.exp });
  });

  test("a missing link is not_found with status 404", async () => {
    const error = await refusal(links.getLink("abcdefghjk"));
    expect([error.code, error.status]).toEqual(["not_found", 404]);
  });

  test("a bad body is bad_request, and a body over the cap is too_large", async () => {
    const bad = await refusal(links.createLink({ c: b64(64), iv: b64(15), ttl: 3600 }));
    expect([bad.code, bad.status]).toEqual(["bad_request", 400]);
    const wrongTtl = await refusal(links.createLink({ c: b64(64), iv: b64(16), ttl: 5 as never }));
    expect(wrongTtl.code).toBe("bad_request");
    const big = await refusal(links.createLink({ c: b64(16_385), iv: b64(16), ttl: 3600 }));
    expect([big.code, big.status]).toEqual(["too_large", 413]);
  });

  test("the daily limit is rate_limited with retryAfter", async () => {
    const one = createClient({ baseUrl: `http://127.0.0.1:${limited.port}` });
    await one.createLink({ c: b64(64), iv: b64(16), ttl: 3600 });
    const error = await refusal(one.createLink({ c: b64(64), iv: b64(16), ttl: 3600 }));
    expect([error.code, error.status]).toEqual(["rate_limited", 429]);
    expect(error.retryAfter).toBeGreaterThan(0);
  });

  test("an unconfigured Worker is not_configured", async () => {
    const bare = await start({});
    try {
      const error = await refusal(createClient({ baseUrl: `http://127.0.0.1:${bare.port}` }).getLink("abcdefghjk"));
      expect([error.code, error.status]).toEqual(["not_configured", 503]);
    } finally {
      stop(bare);
    }
  }, 180_000);

  test("a link id with another shape is refused before any request", async () => {
    for (const id of ["", ".", "..", "a/b", "short", "ABCDEFGHJK"]) await expect(links.getLink(id)).rejects.toThrow(TypeError);
  });

  test("a reply of the wrong shape fails as unknown", async () => {
    const proxy = (body: string, status = 200, headers: Record<string, string> = {}) =>
      createClient({ baseUrl: "https://c.test/base/", fetch: (async () => new Response(body, { status, headers })) as typeof fetch });
    const wrong = await refusal(proxy("<html>").health());
    expect([wrong.code, wrong.status]).toEqual(["unknown", 200]);
    expect((await refusal(proxy('{"id":"x","exp":1}').createLink({ c: b64(64), iv: b64(16), ttl: 3600 }))).code).toBe("unknown");
    const gateway = await refusal(proxy("bad gateway", 502).health());
    expect([gateway.code, gateway.status]).toEqual(["unknown", 502]);
    expect((await refusal(proxy('{"error":"weird"}', 400).health())).code).toBe("unknown");
  });

  test("a stored link with a bad shape or a huge reply fails as unknown", async () => {
    const proxy = (body: string) => createClient({ baseUrl: "https://c.test", fetch: (async () => new Response(body)) as typeof fetch });
    const bad = await refusal(proxy(JSON.stringify({ c: "", iv: "x", exp: 1.5 })).getLink("abcdefghjk"));
    expect(bad.code).toBe("unknown");
    expect((await refusal(proxy("x".repeat(40_000)).health())).message).toBe("the reply is too large");
  });

  test("a custom fetch is called with no this", async () => {
    let self: unknown = "unset";
    const client = createClient({
      baseUrl: "https://c.test",
      fetch: function (this: unknown) {
        self = this;
        return Promise.resolve(new Response('{"ok":true}'));
      } as never,
    });
    await client.health();
    expect(self).toBeUndefined();
  });

  test("the base URL keeps its path, and a bad option is refused", async () => {
    const urls: string[] = [];
    const client = createClient({ baseUrl: "https://c.test/base/", fetch: (async (u: string) => (urls.push(u), new Response("{}", { status: 500 }))) as never });
    await refusal(client.health());
    expect(urls).toEqual(["https://c.test/base/api/v1/health"]);
    for (const baseUrl of ["", "nope", "ftp://x.test", "https://x.test/?a=1", "https://x.test/#h", "https://u:p@x.test"]) {
      expect(() => createClient({ baseUrl })).toThrow(TypeError);
    }
  });

  test("an aborted call rejects with the signal reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(links.health({ signal: controller.signal })).rejects.toThrow("stop");
  });
});
