# agentic-link

[![npm version](https://img.shields.io/npm/v/agentic-link)](https://www.npmjs.com/package/agentic-link)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-link) · [Source](https://github.com/pooriaarab/agentic-link) · [Support](https://github.com/pooriaarab/agentic-link/issues)

Share a document as a link: the content lives in the URL, with no account and no server read.

> Status: 0.3.0. The codec, password mode, short links, the CLI, and the MCP server work.
> There is no web page yet.

## Install

```sh
npm install agentic-link       # the library
npx agentic-link --help        # the CLI; `npx agentic-link mcp` starts the MCP server
```

Node 22 or later. The code uses only web-standard APIs (`CompressionStream`, WebCrypto), so the same
library runs in browsers, Workers, and Node.

## Quick start

```sh
# One URL that holds the whole document.
agentic-link encode --app notes --json '{"title":"Plan","body":"..."}' --base https://app.example/notes

# Read it back.
agentic-link decode 'https://app.example/notes#/v1/notes/...'
```

The same in code. The schema below uses zod (`npm install zod`). Any object with a `safeParse` method works:

```js
import { encode, decode } from "agentic-link";
import { z } from "zod";

const fragment = await encode({ app: "notes", version: 1, payload: { title: "Hi" } });
// "#/v1/notes/<base64url(deflate(json))>"

const { payload } = await decode(fragment, z.object({ title: z.string() }), { app: "notes" });
```

A browser never sends the part of a URL after `#` to a server. So the link carries the document, and no
server reads it.

## Features

- **Fragment codec.** `encode` and `decode` turn a versioned JSON snapshot into `#/v1/<app>/<payload>` and back.
- **Hostile-input checks.** Decode checks the size before it inflates. While it inflates, it caps the inflated
  size and the expansion ratio. It refuses unknown versions, prototype keys (`__proto__`, `constructor`,
  `prototype`), deep nesting, bad UTF-8, non-JSON, non-canonical base64url, and payloads that fail your schema.
  Error messages never repeat the content.
- **Password mode.** `encodeSealed` and `decodeSealed` use AES-256-GCM. The key comes from PBKDF2-SHA256
  (600,000 iterations or more), a random salt, and the NFKC-normalised password. Each seal has a fresh IV. The
  tag covers the header and the route, so a changed version, iteration count, salt, IV, app name, or byte of
  ciphertext fails. A wrong password and a changed link give the same error, `open_failed`. A forged iteration
  count is refused before any key work. WebCrypto only.
- **Short links.** `shorten` encrypts a link on your machine and stores only the ciphertext on a Worker you
  deploy. The key stays in the short URL's fragment. `resolveShort` opens it.
- **Revoke.** A creator who passes an owner key can revoke a short link and list their links. A revoked link
  answers 410 Gone. An admin key can revoke any link.
- **CLI.** `encode`, `decode`, `shorten`, `open`, `revoke`, `list`.
- **MCP server.** `agentic-link mcp` serves `encode_link`, `decode_link`, `shorten_link`, `open_link`, `revoke_link`, and `list_links`.
- **Agent docs.** The package ships `llms.txt` and `SKILL.md`.

### Password mode

```js
import { encodeSealed, decodeSealed } from "agentic-link";

const sealed = await encodeSealed({ app: "notes", version: 1, payload }, "a long random password");
// "#/v1/notes/~<base64url(sealed bytes)>"
const back = await decodeSealed(sealed, "a long random password", schema, { app: "notes" });
```

A plain `decode` of a sealed link throws `sealed`.

### Short links

```js
import { shorten, resolveShort } from "agentic-link";

const { url } = await shorten(longLink, { endpoint: "https://links.example", ttl: 604800 });
// "https://links.example/s/<id>#<key>"
const back = await resolveShort(url, { allowedHosts: ["links.example"] });
```

The Worker holds ciphertext and nothing else. It cannot read a link or change one. A link
lasts an hour, a day, a week (default), or a month. Limits: 16,384 base64url characters of ciphertext (about
12 KB of link). The Worker counts links per client per UTC day (`DAILY_LIMIT`, default 100). An IPv4 client is
one address. An IPv6 client is its /64 prefix, so a client cannot dodge the limit by rotating addresses in its
own /64. The Worker normalizes the address first, and an IPv4-mapped IPv6 address counts as its IPv4 address.
A global cap (`GLOBAL_DAILY_LIMIT`, default 10,000) limits the links stored per UTC day across all clients.
Both limits answer 429 with `Retry-After`. A missing address, or one that does not parse, shares one bucket.
All such clients share one daily limit (`DAILY_LIMIT`). When that shared bucket is full, each of its clients gets
429 until UTC midnight.
One client with about 100 addresses or /64s can fill the global cap. Each address or /64 can store 100 links per
day (the default `DAILY_LIMIT`). So 100 of them can store 10,000 links, which is the default `GLOBAL_DAILY_LIMIT`.
When the global cap is full, the Worker answers 429 to every new short link until UTC midnight. Reads still work.
Long links do not use the Worker, so they still work. The Worker keeps no logs. It stores a keyed hash of the
client identity, not the address. It needs `BRAKE_KEY`, 32 characters or more, and refuses to serve
without it. An hourly job deletes expired links and old counts.

Deploy the Worker to your own Cloudflare account:

```sh
wrangler d1 create agentic-link --jurisdiction eu  # paste the id into wrangler.jsonc
wrangler d1 migrations apply DB --remote
wrangler secret put BRAKE_KEY
wrangler deploy
```

HTTP API: `POST /api/v1/links` with `{ c, iv, ttl }` returns `201 { id, exp }`. `GET /api/v1/links/<id>`
returns `{ c, iv, exp }`, or 404 once the link is gone.

### CLI

```sh
agentic-link encode --app <name> [--json <text> | --file <path> | stdin] [--base <url>]
agentic-link decode [<link>] [--app <name>]
agentic-link shorten [<link>] [--endpoint <url>] [--ttl <seconds>]
agentic-link open [<link>] [--app <name>] [--allow-host <host>]...
agentic-link revoke [<short id or url>] [--endpoint <url>]
agentic-link list [--endpoint <url>]
```

Add `--password-env <VAR>` or `--password-file <path>` to seal or open. The CLI refuses `--password`,
because process lists show command lines. `decode` and `open` print `{ app, version, payload }` as JSON.
Exit codes: 0 done, 1 the link or the service refused (the error code goes to stderr, never the content),
2 bad usage.

### Revoke and list

```js
import { newOwnerKey, shorten, revokeShort, listShort } from "agentic-link";

const ownerKey = newOwnerKey(); // keep it secret; use one key per person
const { url, id } = await shorten(longLink, { endpoint: "https://links.example", ownerKey });
await listShort({ endpoint: "https://links.example", ownerKey }); // [{ id, exp, revoked }]
await revokeShort(url, { endpoint: "https://links.example", ownerKey }); // or the bare id; adminKey works too
```

- Only the creator's owner key or the service's admin key may revoke. A link made without a key can only be
  revoked by an admin. After a revoke, `resolveShort` throws `gone`. Other codes: `forbidden` (wrong owner),
  `unauthorized` (no key, or a key that is not 32 to 128 base64url characters), `not_found`.
- `revokeShort` reads only the id from a short URL. The key goes only to the `endpoint` you pass, never to the
  host in the URL.
- The CLI and MCP read keys from the environment only: `AGENTIC_LINK_OWNER_KEY` (also signs `shorten`) and
  `AGENTIC_LINK_ADMIN_KEY`. A key is never a flag or a tool argument.
- If you lose the owner key, only an admin can revoke your links. The Worker hashes owner keys with
  `BRAKE_KEY`, so rotating `BRAKE_KEY` also orphans every owner key until its links expire. Revoked rows stay
  in the database as small tombstones.
- `ADMIN_KEY` must be 32 to 128 base64url characters (`A-Z a-z 0-9 - _`). Any other value turns admin off.
- A list holds the 100 links that expire last, not the 100 newest.

### MCP

`agentic-link mcp` serves six tools over stdio. A failure is a tool result with `isError` set and a JSON
`{ error, message }`. The endpoint (`AGENTIC_LINK_ENDPOINT`) and the allowed hosts
(`AGENTIC_LINK_ALLOWED_HOSTS`), and the keys come from the environment, never from tool arguments. So an agent that reads
a stranger's document cannot choose where the server connects. Without allowed hosts, `open_link` refuses
short URLs.

## Threat model

Read this before you trust a link with something private.

### The one rule

**Whoever has the link has the document.** The link is the document. Anything that holds the link holds
the document: a chat, a mail server, a browser history, a person. A password changes this. It does not
change the rest of this page.

### What a link leaks, and how the package limits it

| What leaks | Who sees it | What the package does | What it cannot do |
| --- | --- | --- | --- |
| **Length.** The link is as long as the compressed document. | Anyone who sees the link or the stored ciphertext, including the short-link service. | Caps the size (64 KiB compressed by default). | Hide length. A password hides the words, not their number. Nothing pads the link. |
| **Browser history.** A browser keeps the full URL, fragment included. It also syncs history and bookmarks to other devices and to the browser maker. | Anyone with the device, the synced account, or a backup. | Password mode puts only ciphertext in the URL. A short link puts only an id and a key in it. | A plain link in history is the document. A short link in history holds its key, so history plus access to the service reads the document until the link expires. A sealed link's password is the only thing that keeps the content out of history. |
| **Referrer.** A page can tell the next site where you came from. | The next site, if the page sends the address. | The fragment is never part of the `Referer` header. The Worker sends `Referrer-Policy: no-referrer`. The library makes no request from a page. | Control a page you build. Send `Referrer-Policy: no-referrer` from it, and open outside links with `rel="noreferrer"`. |
| **The message that carries the link.** | The chat or mail provider, and anything that previews links. | A password lets you send the link in one message and the password by another route. | Protect a link sent in the open. A password in the same message as its link protects nothing. |
| **The host that serves your page.** | Whoever serves the page can serve code that reads `location.hash`. | The package's own code reads the fragment only in the page that calls it. | Protect against a host that serves hostile code. Trust the host or host the page yourself. |
| **The short-link service.** | The service sees that a link was made, when, its size, and the sender's address at request time. It also sees each reader's address when the reader opens a short link, and when. Cloudflare sees addresses and paths as it does for any site. | Stores only ciphertext. The key never leaves the fragment. Stores a keyed hash of the address. Keeps no logs. Expires links and sweeps them every hour. | Hide that a link was made. Cloudflare D1 keeps a point-in-time history for a limited window, so a deleted row can return from it. It is still ciphertext. |
| **The app name.** It sits in the route. | Anyone who sees the link. | The tag covers the route, so a changed app name does not open a sealed link. | Hide which app a link is for. |

### What the package protects against

- **A hostile link.** Every link is hostile input. Decode checks size before it inflates, caps the inflated
  size and the expansion ratio, refuses prototype keys and deep nesting, and runs your schema last. A
  zip bomb is refused. A truncated or non-canonical link is refused.
- **A changed sealed link.** The AES-GCM tag covers the header and the route. A wrong password and a
  changed link look the same, so a failure tells an attacker nothing.
- **A downgrade.** A header that asks for fewer than 600,000 PBKDF2 iterations is refused. One that asks for
  more than 2,000,000 is refused before it can burn your CPU.
- **A service that reads documents.** The service holds ciphertext under a key it never receives.
- **A client steered at a private host.** `resolveShort` uses https (http only on loopback), does not follow
  redirects, caps the response, and takes a host allow list. The MCP server takes its hosts from the
  environment.
- **A password in a process list.** The CLI refuses `--password`.
- **Abuse of the service.** Body size, ciphertext size, lifetime, a per-client daily count (IPv6 by /64), and a global daily count are capped.
  The Worker refuses to serve without its secret. A row with a bad expiry reads as gone.

### What it does not protect against

- **A plain link can be changed.** Anyone who passes it on can edit it. Only a sealed link detects change,
  and only for someone who does not know the password.
- **Offline password guessing.** A sealed link holds everything needed to test a password. There is no lockout.
  PBKDF2 slows each guess. It does not stop a short password. Use a long random password. Send it by another
  route than the link.
- **A bad payload that passes your schema.** The codec checks shape, not meaning. Treat decoded text as
  untrusted when you show it. Escape it. Never run it.
- **A compromised device, browser, or extension.** It reads the document as shown, and the password as typed.
- **A screenshot, a printout, a forwarded copy.** Once shown, it is shown.
- **Short links disappearing.** They expire, and a service can fail. A short link is a convenience, not storage.
- **Bytes after the compressed data.** `DecompressionStream` does not report them. They are ignored, so one
  document can have more than one spelling.
- **A link that is too long for a chat.** Some apps cut long links. Use a short link or send a file.

## HTTP client

`agentic-link/client` is a typed client for the short-link Worker routes. It uses only `fetch`, so it runs in
browsers, Workers, and Node 22. The Worker is in `agentic-link/worker`.

```ts
import { createClient, LinkApiError } from "agentic-link/client";

const links = createClient({ baseUrl: "https://links.example.com" });
await links.health(); // { ok: true }
const { id, exp } = await links.createLink({ c: ciphertext, iv, ttl: 86_400 });
const stored = await links.getLink(id); // { c, iv, exp }
try {
  await links.getLink("abcdefghjk");
} catch (error) {
  if (error instanceof LinkApiError) console.error(error.code, error.status);
}
```

- The service has no accounts. Reads and creates need no key. The Worker limits each address per day.
- A creator can pass `ownerKey` (32 to 128 base64url characters) to `createClient`. The Worker stores only a keyed
  hash of it. The same `ownerKey` revokes the link and lists the creator's links. A link made with no key has no
  owner, so only an admin can revoke it.
- `revokeLink(id)` calls `DELETE /api/v1/links/:id`. Only the owner key of its creator, or `adminKey`, may revoke.
  `listLinks()` calls `GET /api/v1/links` and returns the 100 links of the owner key that expire last, revoked ones marked.
  With `adminKey` it returns that many of all links.
- The Worker reads `ADMIN_KEY` (a secret, 32 to 128 base64url characters). If it is missing or in another shape, admin is off.
  An admin key never owns a link, and a create with one answers 400.
- A revoked link answers `410 gone` on read, never a redirect. The Worker empties its ciphertext and keeps the
  row, so the sweep never deletes it and the id is never used again. A row whose revoked flag is not `0` counts
  as revoked. Revoking twice is the same as once. A wrong owner gets `403`, and no key gets `401`.
- The client sends ciphertext only. To encrypt and to build a short URL, use `shorten` and `resolveShort`.
- A failed call throws `LinkApiError`. `code` is the API error code, or `unknown` when the reply is not an API
  error. `status` is the HTTP status. `retryAfter` holds the seconds to wait on a `429`. A reply over 17 KB fails as `unknown`.
- A `200` reply with the wrong shape fails as `unknown`. A link id that is not 10 characters from the link alphabet
  is refused before any request.
- The client never follows a redirect and never retries.

## Limits

- Needs `CompressionStream` with `deflate-raw` (Node 22, current browsers, Workers).
- The link format version is `v1`. Put your own payload version inside the payload.
- Defaults: 64 KiB compressed, 1 MiB inflated, expansion ratio 100 above 64 KiB, depth 64. Callers may change them.
- A short link holds about 12 KB of link.
- One heavy client can fill the global daily cap of short links until UTC midnight. At the defaults, that takes about 100 addresses or /64s. Reads and long links still work.
- There is no page at `/s/<id>` and no web UI yet. Open a short link with `resolveShort`, the CLI, or MCP.
- Open formats (ODF, DOCX) belong to the apps that use this package, not to this one.

## Live demo

A demo of the short-link service runs at <https://agentic-link-demo.hello-fd1.workers.dev>. Check it:

```sh
curl https://agentic-link-demo.hello-fd1.workers.dev/api/v1/health   # {"ok":true}
```

Use it with `--endpoint https://agentic-link-demo.hello-fd1.workers.dev` (CLI) or `shorten(link, { endpoint })` (SDK). It is a demo, not a production service. It stores ciphertext only, has low daily limits, and can reset at any time. To open a demo short link, pass `--allow-host agentic-link-demo.hello-fd1.workers.dev` (CLI) or `allowedHosts` (SDK).

To redeploy it on your own account, follow these steps:

```sh
export WRANGLER_SEND_METRICS=false
npx wrangler d1 create agentic-link-demo --jurisdiction eu
```

Put the new `database_id` in `wrangler.demo.jsonc`. Then run:

```sh
npx wrangler d1 migrations apply agentic-link-demo --remote --config wrangler.demo.jsonc
npx wrangler secret put BRAKE_KEY --config wrangler.demo.jsonc   # 32 characters or more
npm run deploy:demo
```

Deploy by hand. Do not add a Cloudflare token to CI.

## Develop

```sh
npm ci
npm run ci:local   # build, typecheck, and tests; the end-to-end tests run the real Worker under wrangler dev
```

Set `WRANGLER_SEND_METRICS=false` when you run wrangler. The tests do.

## License

MIT.
