// Failure cases: crossed subject kinds, shared recipients, agent ownership,
// damaged rows/mappings, more than one page, stopped erase, registry import.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createAccountRegistry, type AccountPackage } from "agentic-identity/account";
import { describe, expect, it } from "vitest";
import { linkAccount, type LinkAccountDeps, type LinkAccountSubject } from "agentic-link/account";
import type { D1Like } from "./worker.js";

const ana = { id: "ana", kind: "human" } as const;
const bot = { id: "ana", kind: "agent_of_human" } as const;
const hash = "a".repeat(43);
const otherHash = "b".repeat(43);
const id = (n: number) => `aaaaaaaa${String.fromCharCode(97 + Math.floor(n / 10))}${String.fromCharCode(97 + n % 10)}`;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_links.sql", "0002_revoke.sql"]) {
    // Use the shipped schema rather than a second account storage model.
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const db: D1Like = {
    prepare(sql) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { values = args; return statement; },
        async first<T>() { return (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...values as never[]) as T[] }; },
        async run() { return sqlite.prepare(sql).run(...values as never[]); },
      };
      return statement;
    },
  };
  const deps: LinkAccountDeps = { db, ownerHashes: async (s) => s.id === "ana" && s.kind === "human" ? [hash] : s.id === "ana" && s.kind === "agent_of_human" ? [otherHash] : [] };
  const add = (n: number, owner: string | null = hash) => sqlite.prepare("INSERT INTO links (id,c,iv,exp,owner) VALUES (?,?,?,?,?)").run(id(n), "c".repeat(22), "i".repeat(16), 1000, owner);
  const rows = () => sqlite.prepare("SELECT * FROM links ORDER BY id").all();
  return { sqlite, deps, add, rows };
}

describe("published account contributor", () => {
  it("fits the registry and exports all pages, expired rows and tombstones", async () => {
    const { sqlite, deps, add } = setup();
    for (let n = 0; n < 110; n++) add(n);
    sqlite.exec(`UPDATE links SET revoked=1,c='',iv='' WHERE id='${id(0)}'`);
    const pkg: AccountPackage<LinkAccountDeps> = linkAccount;
    const registry = createAccountRegistry().register(pkg, deps);
    const out = await linkAccount.exportAccount(ana, deps);
    expect(out.links).toHaveLength(110);
    expect(out.links[0]).toMatchObject({ id: id(0), c: "", iv: "", revoked: 1 });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    const archive = await registry.export(ana, { now: () => 1 });
    expect(archive.manifest.apps[0].files[0].path).toBe("links.json");
  });

  it("deletes sole-owned ciphertext even when recipients share its URL; keeps other owners", async () => {
    const { deps, add, rows } = setup();
    add(0); add(1, otherHash); add(2, null);
    expect((await linkAccount.exportAccount(ana, deps)).links.map((r) => r.id)).toEqual([id(0)]);
    // A recipient has no ownership record. Possession of a URL is not ownership.
    const recipient: LinkAccountSubject = { id: "recipient", kind: "human" };
    expect(await linkAccount.eraseAccount(recipient, deps)).toEqual({ links: 0 });
    expect(await linkAccount.eraseAccount(ana, deps)).toEqual({ links: 1 });
    expect(rows().map((r) => r.id)).toEqual([id(1), id(2)]);
    expect(await linkAccount.eraseAccount(ana, deps)).toEqual({ links: 0 });
  });

  it("keeps agent and human ownership separate; the host supplies explicit kinds", async () => {
    const { deps, add, rows } = setup();
    add(0); add(1, otherHash);
    expect((await linkAccount.exportAccount(bot, deps)).links.map((r) => r.id)).toEqual([id(1)]);
    expect(await linkAccount.eraseAccount(bot, deps)).toEqual({ links: 1 });
    expect(rows().map((r) => r.id)).toEqual([id(0)]);
  });

  it.each(["exp='bad'", "revoked=2", "c='bad'", "iv='bad'", "id=''", "id=NULL"])("refuses damaged records before any erase: %s", async (damage) => {
    const { sqlite, deps, add, rows } = setup();
    add(0); add(1);
    sqlite.exec(`UPDATE links SET ${damage} WHERE id='${id(1)}'`);
    await expect(linkAccount.exportAccount(ana, deps)).rejects.toMatchObject({ code: "damaged_record" });
    await expect(linkAccount.eraseAccount(ana, deps)).rejects.toMatchObject({ code: "damaged_record" });
    expect(rows()).toHaveLength(2);
  });

  it("refuses missing kinds, invalid hashes and absent host mapping", async () => {
    const { deps } = setup();
    for (const subject of [{ id: "ana" }, { id: "", kind: "human" }, { id: "ana", kind: "robot" }]) {
      await expect(linkAccount.exportAccount(subject as never, deps)).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const ownerHashes of [undefined, async () => ["bad"], async () => null, async () => new Array(1)]) {
      await expect(linkAccount.eraseAccount(ana, { ...deps, ownerHashes } as never)).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("finishes after an interrupted delete and deduplicates mapped hashes", async () => {
    const { deps, add, rows } = setup();
    add(0); add(1);
    let calls = 0;
    const stopping: D1Like = { prepare(sql) {
      const statement = deps.db.prepare(sql);
      if (sql.startsWith("DELETE")) {
        const first = statement.first.bind(statement);
        statement.first = async <T>() => { if (++calls === 2) throw new Error("stop"); return first<T>(); };
      }
      return statement;
    } };
    await expect(linkAccount.eraseAccount(ana, { ...deps, db: stopping })).rejects.toThrow("stop");
    expect(rows()).toHaveLength(1);
    expect(await linkAccount.eraseAccount(ana, { ...deps, ownerHashes: async () => [hash, hash] })).toEqual({ links: 1 });
    expect(await linkAccount.eraseAccount(ana, deps)).toEqual({ links: 0 });
  });
});
