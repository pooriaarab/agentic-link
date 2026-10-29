import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  test("matches package.json without a build", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  test("package-lock.json and server.json name the same version", () => {
    const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as Record<string, any>;
    const version = read("package.json").version;
    const lock = read("package-lock.json");
    const server = read("server.json");
    expect([lock.version, lock.packages[""].version]).toEqual([version, version]);
    expect([server.version, server.packages[0].version]).toEqual([version, version]);
  });
});
