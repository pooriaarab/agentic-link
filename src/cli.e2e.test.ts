import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ROOT, start, stop, type Running } from "./e2e-harness.js";

// End to end: the real built CLI as a child process. Failure modes first.
// Exit 0 is success, 1 is a refusal of the link or the service, 2 is bad usage.

const CLI = join(ROOT, "dist", "cli.js");
const SECRET = "SECRET-NOTE-BODY";
const PASSWORD = "a long shared password for the test";
const payloadJson = JSON.stringify({ title: "Plan", body: SECRET });

interface Out {
  code: number | null;
  out: string;
  err: string;
}

function cli(args: string[], options: { input?: string; env?: Record<string, string> } = {}): Out {
  const result = spawnSync("node", [CLI, ...args], {
    input: options.input,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...options.env },
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function encodeOk(args: string[] = [], options: { env?: Record<string, string> } = {}): string {
  const res = cli(["encode", "--app", "notes", "--json", payloadJson, ...args], options);
  expect(res.code, res.err).toBe(0);
  return res.out.trim();
}

describe("usage errors exit 2 and print nothing on stdout", () => {
  test.each([
    ["no command", []],
    ["an unknown command", ["frobnicate"]],
    ["encode with no app", ["encode", "--json", "{}"]],
    ["encode with no payload and no stdin", ["encode", "--app", "notes", "--json"]],
    ["a flag with no value", ["encode", "--app"]],
    ["an unknown flag", ["encode", "--app", "notes", "--json", "{}", "--bogus", "1"]],
    ["decode with no link", ["decode"]],
    ["shorten with no link", ["shorten"]],
  ])("%s", (_name, args) => {
    const res = cli(args);
    expect(res.code).toBe(2);
    expect(res.out).toBe("");
    expect(res.err.length).toBeGreaterThan(0);
  });

  test("--password on the command line is refused, because argv shows in process lists", () => {
    const res = cli(["encode", "--app", "notes", "--json", "{}", "--password", PASSWORD]);
    expect(res.code).toBe(2);
    expect(res.err).toContain("--password-env");
    expect(res.err).not.toContain(PASSWORD);
  });

  test("a password variable that is unset or empty is refused", () => {
    expect(cli(["encode", "--app", "notes", "--json", "{}", "--password-env", "NOPE"]).code).toBe(2);
    expect(cli(["encode", "--app", "notes", "--json", "{}", "--password-env", "P"], { env: { P: "" } }).code).toBe(2);
  });

  test("a password file that does not exist is refused", () => {
    expect(cli(["encode", "--app", "notes", "--json", "{}", "--password-file", "/no/such/file"]).code).toBe(2);
  });

  test("a payload from stdin over the cap is refused without being read to the end", () => {
    const res = cli(["encode", "--app", "notes"], { input: "x".repeat(3 * 1024 * 1024) });
    expect(res.code).toBe(2);
    expect(res.out).toBe("");
  });

  test("a payload that is not JSON is refused", () => {
    const res = cli(["encode", "--app", "notes", "--json", "not json"]);
    expect(res.code).toBe(2);
  });

  test("--base with its own fragment is refused", () => {
    expect(cli(["encode", "--app", "notes", "--json", "{}", "--base", "https://x.example/#a"]).code).toBe(2);
  });
});

describe("encode and decode", () => {
  test("round trip through the fragment", () => {
    const link = encodeOk();
    expect(link).toMatch(/^#\/v1\/notes\/[A-Za-z0-9_-]+$/);
    const res = cli(["decode", link]);
    expect(res.code, res.err).toBe(0);
    expect(JSON.parse(res.out)).toEqual({ app: "notes", version: 1, payload: { title: "Plan", body: SECRET } });
    expect(res.err).toBe("");
  });

  test("--base writes one URL a person can open, and decode takes the whole URL", () => {
    const url = encodeOk(["--base", "https://app.example/notes"]);
    expect(url).toMatch(/^https:\/\/app\.example\/notes#\/v1\/notes\//);
    expect(JSON.parse(cli(["decode", url]).out).payload.title).toBe("Plan");
  });

  test("reads the payload from stdin and the link from stdin", () => {
    const encoded = cli(["encode", "--app", "notes"], { input: payloadJson });
    expect(encoded.code, encoded.err).toBe(0);
    const decoded = cli(["decode"], { input: encoded.out });
    expect(JSON.parse(decoded.out).payload.body).toBe(SECRET);
  });

  test("reads the payload from a file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "link-cli-")), "p.json");
    writeFileSync(file, payloadJson);
    const res = cli(["encode", "--app", "notes", "--file", file]);
    expect(res.code, res.err).toBe(0);
  });

  test("--app refuses a link for another app", () => {
    const res = cli(["decode", encodeOk(), "--app", "sheets"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("wrong_app");
    expect(res.out).toBe("");
  });

  test("an invalid app name is a refusal", () => {
    const res = cli(["encode", "--app", "Bad App", "--json", "{}"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("malformed");
  });
});

describe("hostile links exit 1, print no content, and name the reason", () => {
  test.each([
    ["a truncated link", (l: string) => l.slice(0, Math.floor(l.length / 2))],
    ["an unknown version", (l: string) => l.replace("/v1/", "/v9/")],
    ["not a link at all", () => "hello world"],
    ["an empty fragment", () => "#"],
  ])("%s", (_name, mangle) => {
    const res = cli(["decode", mangle(encodeOk())]);
    expect(res.code).toBe(1);
    expect(res.out).toBe("");
    expect(res.err).not.toContain(SECRET);
  });

  test("a prototype key", () => {
    // deflate-raw of {"__proto__":{"admin":true}} written by the codec's own writer, not by encode.
    const bytes = deflateRawSync(Buffer.from('{"__proto__":{"admin":true}}'));
    const res = cli(["decode", `#/v1/notes/${bytes.toString("base64url")}`]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("forbidden_key");
    expect(res.out).toBe("");
  });
});

describe("passwords", () => {
  test("seal with --password-env, then open with the same variable", () => {
    const link = encodeOk(["--password-env", "LINK_PW"], { env: { LINK_PW: PASSWORD } });
    expect(link).toContain("/~");
    expect(link).not.toContain(SECRET);
    const res = cli(["decode", link, "--password-env", "LINK_PW"], { env: { LINK_PW: PASSWORD } });
    expect(res.code, res.err).toBe(0);
    expect(JSON.parse(res.out).payload.body).toBe(SECRET);
    expect(res.err).not.toContain(PASSWORD);
  });

  test("a password file with a trailing newline works", () => {
    const file = join(mkdtempSync(join(tmpdir(), "link-cli-")), "pw");
    writeFileSync(file, PASSWORD + "\n");
    const link = encodeOk(["--password-file", file]);
    const res = cli(["decode", link, "--password-file", file]);
    expect(res.code, res.err).toBe(0);
  });

  test("a sealed link with no password says it is sealed", () => {
    const link = encodeOk(["--password-env", "LINK_PW"], { env: { LINK_PW: PASSWORD } });
    const res = cli(["decode", link]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("sealed");
    expect(res.out).toBe("");
  });

  test("a wrong password gives open_failed and prints nothing", () => {
    const link = encodeOk(["--password-env", "LINK_PW"], { env: { LINK_PW: PASSWORD } });
    const res = cli(["decode", link, "--password-env", "LINK_PW"], { env: { LINK_PW: "WRONG-PW-VALUE-123" } });
    expect(res.code).toBe(1);
    expect(res.err).toContain("open_failed");
    expect(res.out).toBe("");
    expect(res.err).not.toContain("WRONG-PW-VALUE-123");
  });
});

describe("short links through a real Worker", () => {
  let worker: Running;
  let endpoint: string;
  beforeAll(async () => {
    worker = await start({ BRAKE_KEY: "cli-test-brake-key-0123456789abcdef-0123456789", DAILY_LIMIT: "1000" });
    endpoint = `http://127.0.0.1:${worker.port}`;
  }, 180_000);
  afterAll(() => stop(worker));

  test("an agent can hand a document over as one URL: encode, shorten, open", () => {
    const link = encodeOk(["--base", "https://app.example/notes"]);
    const short = cli(["shorten", link, "--endpoint", endpoint, "--ttl", "3600"]);
    expect(short.code, short.err).toBe(0);
    const url = short.out.trim();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[a-km-np-z2-9]{10}#[A-Za-z0-9_-]{43}$/);
    const opened = cli(["open", url]);
    expect(opened.code, opened.err).toBe(0);
    expect(JSON.parse(opened.out).payload).toEqual({ title: "Plan", body: SECRET });
  });

  test("the endpoint can come from the environment", () => {
    const res = cli(["shorten", encodeOk()], { env: { AGENTIC_LINK_ENDPOINT: endpoint } });
    expect(res.code, res.err).toBe(0);
  });

  test("open on a plain link decodes it, with no network", () => {
    const res = cli(["open", encodeOk()]);
    expect(res.code, res.err).toBe(0);
    expect(JSON.parse(res.out).payload.title).toBe("Plan");
  });

  test("open refuses a short link whose host is not on the allow list, before any request", () => {
    const short = cli(["shorten", encodeOk(), "--endpoint", endpoint]).out.trim();
    const res = cli(["open", short, "--allow-host", "links.example"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("bad_url");
    expect(res.out).toBe("");
    expect(cli(["open", short, "--allow-host", "127.0.0.1"]).code).toBe(0);
  });

  test("open on a sealed document behind a short link needs the password", () => {
    const sealed = encodeOk(["--password-env", "LINK_PW"], { env: { LINK_PW: PASSWORD } });
    const short = cli(["shorten", sealed, "--endpoint", endpoint]).out.trim();
    const without = cli(["open", short]);
    expect(without.code).toBe(1);
    expect(without.err).toContain("sealed");
    const withPw = cli(["open", short, "--password-env", "LINK_PW"], { env: { LINK_PW: PASSWORD } });
    expect(withPw.code, withPw.err).toBe(0);
  });

  test("shorten with no endpoint is a usage error, and a public http endpoint is refused", () => {
    expect(cli(["shorten", encodeOk()]).code).toBe(2);
    const res = cli(["shorten", encodeOk(), "--endpoint", "http://example.test"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("bad_url");
  });

  test("shorten refuses a bad lifetime", () => {
    const res = cli(["shorten", encodeOk(), "--endpoint", endpoint, "--ttl", "5"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("bad_ttl");
    expect(cli(["shorten", encodeOk(), "--endpoint", endpoint, "--ttl", "abc"]).code).toBe(2);
  });

  test("the short URL, which holds the key, never appears on stderr", () => {
    const res = cli(["shorten", encodeOk(), "--endpoint", endpoint]);
    const key = res.out.trim().split("#")[1]!;
    expect(res.err).not.toContain(key);
  });
});
