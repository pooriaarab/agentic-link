import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createClient, LinkApiError, type LinkClient } from "./client.js";
import { fetchRetry, sql, start, stop, type Running } from "./e2e-harness.js";

// Revoke and list against the real Worker under `wrangler dev`, with a real D1 file.
let run: Running;
let bare: LinkClient;
let alice: LinkClient;
let bob: LinkClient;
let admin: LinkClient;
const BRAKE_KEY = "test-brake-key-0123456789abcdef-0123456789";
const ADMIN_KEY = "test-admin-key-0123456789abcdef-0123456789";
const ALICE = "alice-owner-key-0123456789abcdef-0123456789";
const BOB = "bobby-owner-key-0123456789abcdef-0123456789";
const body = { c: "A".repeat(64), iv: "A".repeat(16), ttl: 3600 as const };
const url = (path: string) => `http://127.0.0.1:${run.port}/api/v1${path}`;

async function refusal(promise: Promise<unknown>): Promise<LinkApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LinkApiError);
  return error as LinkApiError;
}

beforeAll(async () => {
  run = await start({ BRAKE_KEY, ADMIN_KEY, DAILY_LIMIT: "1000" });
  const baseUrl = `http://127.0.0.1:${run.port}`;
  bare = createClient({ baseUrl });
  alice = createClient({ baseUrl, ownerKey: ALICE });
  bob = createClient({ baseUrl, ownerKey: BOB });
  admin = createClient({ baseUrl, adminKey: ADMIN_KEY });
}, 240_000);

afterAll(() => {
  if (run) stop(run);
});

describe("revoke", () => {
  test("the creator revokes: the link is 410 Gone, with no redirect, and stays gone", async () => {
    const { id } = await alice.createLink(body);
    expect((await alice.getLink(id)).c).toBe(body.c);
    expect(await alice.revokeLink(id)).toEqual({ id, revoked: true });
    const raw = await fetchRetry(url(`/links/${id}`), { redirect: "manual" });
    expect(raw.status).toBe(410);
    expect(raw.headers.get("location")).toBeNull();
    expect(await raw.json()).toEqual({ error: "gone" });
    const error = await refusal(bare.getLink(id));
    expect([error.code, error.status]).toEqual(["gone", 410]);
    // Revoking twice is the same as once.
    expect(await alice.revokeLink(id)).toEqual({ id, revoked: true });
  });

  test("the ciphertext is dropped, and the row survives the sweep even after expiry", async () => {
    const { id } = await alice.createLink(body);
    await alice.revokeLink(id);
    expect(sql(run, `select c, iv, revoked from links where id = '${id}'`)).toEqual([{ c: "", iv: "", revoked: 1 }]);
    sql(run, `update links set exp = 1 where id = '${id}'`);
    expect((await fetch(`http://127.0.0.1:${run.port}/cdn-cgi/handler/scheduled`)).status).toBe(200);
    expect(sql(run, `select id from links where id = '${id}'`)).toHaveLength(1);
    expect((await refusal(bare.getLink(id))).code).toBe("gone");
  });

  test("a revoked id cannot be created again", async () => {
    const { id } = await alice.createLink(body);
    await alice.revokeLink(id);
    // The service picks ids, and its insert never overwrites a row, so a taken id (revoked or not) is skipped.
    sql(run, `insert into links (id, c, iv, exp) values ('${id}', 'x', 'y', 1) on conflict (id) do nothing`);
    expect(sql(run, `select revoked, c from links where id = '${id}'`)).toEqual([{ revoked: 1, c: "" }]);
    expect((await refusal(bare.getLink(id))).code).toBe("gone");
  });

  test("another owner is forbidden, and no key is unauthorized", async () => {
    const { id } = await alice.createLink(body);
    const other = await refusal(bob.revokeLink(id));
    expect([other.code, other.status]).toEqual(["forbidden", 403]);
    const none = await fetchRetry(url(`/links/${id}`), { method: "DELETE" });
    expect(none.status).toBe(401);
    const junk = await fetchRetry(url(`/links/${id}`), { method: "DELETE", headers: { authorization: "Bearer short" } });
    expect(junk.status).toBe(401);
    expect((await bare.getLink(id)).c).toBe(body.c);
  });

  test("an admin revokes any link, and only an admin revokes an ownerless one", async () => {
    const mine = await alice.createLink(body);
    const ownerless = await bare.createLink(body);
    expect((await refusal(alice.revokeLink(ownerless.id))).code).toBe("forbidden");
    await admin.revokeLink(mine.id);
    await admin.revokeLink(ownerless.id);
    expect((await refusal(bare.getLink(mine.id))).code).toBe("gone");
    expect((await refusal(bare.getLink(ownerless.id))).code).toBe("gone");
  });

  test("a revoke of an unknown id is 404", async () => {
    expect((await refusal(alice.revokeLink("abcdefghjk"))).status).toBe(404);
  });

  test("a stored revoked value that is not 0 fails closed as gone", async () => {
    const { id } = await alice.createLink(body);
    sql(run, `update links set revoked = 'x' where id = '${id}'`);
    expect((await refusal(bare.getLink(id))).code).toBe("gone");
  });

  test("an admin key on create is refused, and a short or odd key is refused", async () => {
    const asAdmin = await fetchRetry(url("/links"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify(body),
    });
    expect(asAdmin.status).toBe(400);
    const odd = await fetchRetry(url("/links"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer short" },
      body: JSON.stringify(body),
    });
    expect(odd.status).toBe(400);
  });

  test("the client refuses a bad key or a call with no key before any request", async () => {
    expect(() => createClient({ baseUrl: "https://c.test", ownerKey: "short" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl: "https://c.test", adminKey: "has space has space has space has space" })).toThrow(TypeError);
    await expect(bare.revokeLink("abcdefghjk")).rejects.toThrow(TypeError);
    await expect(bare.listLinks()).rejects.toThrow(TypeError);
    await expect(alice.revokeLink("../x")).rejects.toThrow(TypeError);
  });

  test("a Worker with no admin key treats the admin key as a plain owner key", async () => {
    const noAdmin = await start({ BRAKE_KEY, ADMIN_KEY: "too-short" });
    try {
      const baseUrl = `http://127.0.0.1:${noAdmin.port}`;
      const { id } = await createClient({ baseUrl, ownerKey: ALICE }).createLink(body);
      const guess = createClient({ baseUrl, adminKey: "too-short".padEnd(32, "x") });
      expect((await refusal(guess.revokeLink(id))).code).toBe("forbidden");
      expect((await refusal(createClient({ baseUrl, adminKey: ADMIN_KEY }).revokeLink(id))).code).toBe("forbidden");
    } finally {
      stop(noAdmin);
    }
  }, 180_000);
});

describe("list", () => {
  test("an owner sees only their own links, revoked ones marked", async () => {
    const fresh = createClient({ baseUrl: `http://127.0.0.1:${run.port}`, ownerKey: "carol-owner-key-0123456789abcdef-0123456789" });
    expect(await fresh.listLinks()).toEqual([]);
    const a = await fresh.createLink(body);
    const b = await fresh.createLink(body);
    const theirs = await bob.createLink(body);
    await fresh.revokeLink(a.id);
    const list = await fresh.listLinks();
    expect(list.map((l) => [l.id, l.revoked]).sort()).toEqual([[a.id, true], [b.id, false]].sort());
    expect(list.some((l) => l.id === theirs.id)).toBe(false);
    expect(JSON.stringify(list)).not.toContain("carol");
  });

  test("an admin sees all links, and no key is unauthorized", async () => {
    const { id } = await alice.createLink(body);
    expect((await admin.listLinks()).some((l) => l.id === id)).toBe(true);
    expect((await fetchRetry(url("/links"))).status).toBe(401);
  });

  test("the stored owner is a hash, not the key", () => {
    const owners = sql(run, "select owner from links where owner is not null").map((r) => String(r.owner));
    expect(owners.length).toBeGreaterThan(0);
    for (const owner of owners) expect(owner).not.toContain("owner-key");
  });
});
