import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fetchRetry, start, stop, type Running } from "./e2e-harness.js";

// End to end: the real Worker under `wrangler dev`. The sibling Workers answer
// GET /health, so a probe can use one path everywhere. Failure modes first: a
// probe must not change the answer of the API path, and only GET is served.

const BRAKE_KEY = "test-brake-key-0123456789abcdef-0123456789";

let main: Running;

beforeAll(async () => {
  main = await start({ BRAKE_KEY });
}, 240_000);

afterAll(() => {
  if (main) stop(main);
});

const url = (path: string) => `http://127.0.0.1:${main.port}${path}`;

describe("health routes", () => {
  test("GET /health answers ok with the sibling body", async () => {
    const res = await fetchRetry(url("/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /api/v1/health still answers the same body", async () => {
    const res = await fetchRetry(url("/api/v1/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("only GET is served on /health; other methods and paths are not_found", async () => {
    const post = await fetchRetry(url("/health"), { method: "POST", body: "{}" });
    expect(post.status).toBe(404);
    expect(await post.json()).toEqual({ error: "not_found" });

    const near = await fetchRetry(url("/healthz"));
    expect(near.status).toBe(404);
    expect(await near.json()).toEqual({ error: "not_found" });
  });
});
