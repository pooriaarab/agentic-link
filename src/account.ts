import type { D1Like } from "./worker.js";
import { BASE64URL_PATTERN, ID_PATTERN, IV_CHARS, MAX_CIPHERTEXT_CHARS, MIN_CIPHERTEXT_CHARS } from "./short-protocol.js";

/** Structural match for AccountSubject from agentic-identity/account. */
export interface LinkAccountSubject {
  id: string;
  kind: "human" | "agent" | "agent_of_human" | "agent_of_agent" | "user_token";
}

export interface LinkAccountDeps {
  db: D1Like;
  /**
   * Trusted host lookup, keyed by BOTH subject id and kind. Return every stored
   * owner hash assigned exclusively to this principal, including old keys.
   * Never take hashes from a request. Do not return a shared key here: this
   * service has one owner per link and cannot remove one of several key holders.
   * Keep this mapping until erase succeeds, so a stopped erase can be retried.
   */
  ownerHashes(subject: LinkAccountSubject): Promise<string[]>;
}

export interface LinkAccountRow {
  [key: string]: string | number;
  id: string;
  c: string;
  iv: string;
  exp: number;
  owner: string;
  revoked: number;
}

export interface LinkAccount {
  id: "link";
  exportAccount(subject: LinkAccountSubject, deps: LinkAccountDeps): Promise<{ links: LinkAccountRow[] }>;
  eraseAccount(subject: LinkAccountSubject, deps: LinkAccountDeps): Promise<{ links: number }>;
}

/** A refusal has a stable code and no stored content or subject identifiers. */
export class LinkAccountError extends Error {
  constructor(readonly code: "invalid_input" | "damaged_record") {
    super(code);
    this.name = "LinkAccountError";
  }
}

const HASH = /^[A-Za-z0-9_-]{43}$/;
const KINDS = ["human", "agent", "agent_of_human", "agent_of_agent", "user_token"];
const PAGE = 100;
const invalid = () => { throw new LinkAccountError("invalid_input"); };
const damaged = () => { throw new LinkAccountError("damaged_record"); };

function rowOf(value: unknown, owner: string): LinkAccountRow {
  if (!value || typeof value !== "object") return damaged();
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_PATTERN.test(r.id) || r.owner !== owner ||
    typeof r.exp !== "number" || !Number.isSafeInteger(r.exp) || r.exp < 0 ||
    (r.revoked !== 0 && r.revoked !== 1) || typeof r.c !== "string" || typeof r.iv !== "string") return damaged();
  if (r.revoked === 1) {
    if (r.c !== "" || r.iv !== "") return damaged();
  } else if (r.c.length < MIN_CIPHERTEXT_CHARS || r.c.length > MAX_CIPHERTEXT_CHARS ||
    !BASE64URL_PATTERN.test(r.c) || r.iv.length !== IV_CHARS || !BASE64URL_PATTERN.test(r.iv)) return damaged();
  return { id: r.id, c: r.c, iv: r.iv, exp: r.exp, owner, revoked: r.revoked };
}

async function collect(subject: LinkAccountSubject, deps: LinkAccountDeps): Promise<LinkAccountRow[]> {
  const id = subject?.id;
  const kind = subject?.kind;
  if (typeof id !== "string" || id.trim() === "" || !KINDS.includes(kind) ||
    typeof deps?.db?.prepare !== "function" || typeof deps.ownerHashes !== "function") return invalid();
  const hashes = await deps.ownerHashes(Object.freeze({ id, kind }));
  if (!Array.isArray(hashes)) return invalid();
  for (const hash of hashes) if (typeof hash !== "string" || !HASH.test(hash)) return invalid();
  const rows: LinkAccountRow[] = [];
  for (const owner of [...new Set(hashes)].sort()) {
    let cursor: string | undefined;
    for (;;) {
      const statement = cursor === undefined
        ? deps.db.prepare("SELECT id,c,iv,exp,owner,revoked FROM links WHERE owner = ? ORDER BY id LIMIT ?").bind(owner, PAGE)
        : deps.db.prepare("SELECT id,c,iv,exp,owner,revoked FROM links WHERE owner = ? AND id > ? ORDER BY id LIMIT ?").bind(owner, cursor, PAGE);
      const page = await statement.all<unknown>();
      if (!Array.isArray(page.results) || page.results.length > PAGE) return damaged();
      for (const value of page.results) {
        const row = rowOf(value, owner);
        if (cursor !== undefined && row.id <= cursor) return damaged();
        cursor = row.id;
        rows.push(row);
      }
      if (page.results.length < PAGE) break;
    }
  }
  return rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Account registry contributor for stored short links. Stop writes first.
 * No decryption or network calls. Plain fragment links live only on devices;
 * the service has no document versions, grants, authors, or separate blobs.
 */
export const linkAccount: LinkAccount = {
  id: "link",
  async exportAccount(subject, deps) {
    return { links: await collect(subject, deps) };
  },
  async eraseAccount(subject, deps) {
    // Validate every selected row before the first delete. Keep the host mapping
    // until completion; each hard delete is safe to repeat after a stop.
    const rows = await collect(subject, deps);
    let links = 0;
    for (const row of rows) {
      const gone = await deps.db.prepare("DELETE FROM links WHERE id = ? AND owner = ? RETURNING id")
        .bind(row.id, row.owner).first<{ id: string }>();
      if (gone !== null) links++;
    }
    return { links };
  },
};
