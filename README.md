# agentic-link

[![npm version](https://img.shields.io/npm/v/agentic-link)](https://www.npmjs.com/package/agentic-link)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-link) · [Source](https://github.com/pooriaarab/agentic-link) · [Support](https://github.com/pooriaarab/agentic-link/issues)

Share a document as a link: the content lives in the URL, with no account and no server read.

> Status: early. The fragment codec and password mode work. Short links work.
> The CLI and the MCP server work. This package is not on npm yet.

## Quick start

```js
import { encode, decode } from "agentic-link";
import { z } from "zod";

const fragment = await encode({ app: "notes", version: 1, payload: { title: "Hi" } });
// "#/v1/notes/<base64url(deflate(json))>"

const { payload } = await decode(fragment, z.object({ title: z.string() }), { app: "notes" });
```

## Password mode

```js
import { encodeSealed, decodeSealed } from "agentic-link";

const sealed = await encodeSealed({ app: "notes", version: 1, payload }, "a long password");
// "#/v1/notes/~<base64url(sealed bytes)>"
const { payload: back } = await decodeSealed(sealed, "a long password", schema, { app: "notes" });
```

AES-256-GCM. The key comes from PBKDF2-SHA256 (600,000 iterations or more), a random 16-byte salt,
and the NFKC-normalised password. Each seal has a fresh 12-byte IV. The header holds the version and
iteration count. The tag covers the header and the route, so a change to any of them fails. A wrong
password and a changed link give the same error, `open_failed`. A header with fewer than 600,000 or
more than 2,000,000 iterations is refused before any key work. WebCrypto only.

## CLI

```sh
npx agentic-link encode --app notes --json '{"title":"Hi"}' --base https://app.example/notes
npx agentic-link decode 'https://app.example/notes#/v1/notes/...'
npx agentic-link shorten "$LINK" --endpoint https://links.example
npx agentic-link open "$SHORT_URL" --allow-host links.example
```

`encode` prints one URL. `decode` and `open` print `{ app, version, payload }` as JSON. A link comes from the
argument or from stdin. Passwords never go on the command line, where process lists show them: use
`--password-env VAR` or `--password-file path`. Exit codes: 0 done, 1 the link or the service refused (the
code is on stderr, never the content), 2 bad usage. `open` fetches a short URL only from an allowed host
when you pass `--allow-host` or set `AGENTIC_LINK_ALLOWED_HOSTS`.

## MCP

`npx agentic-link mcp` serves four tools over stdio: `encode_link`, `decode_link`, `shorten_link`, and
`open_link`. A failure is a tool result with `isError` set and a JSON `{ error, message }`. The endpoint
(`AGENTIC_LINK_ENDPOINT`) and the allowed hosts (`AGENTIC_LINK_ALLOWED_HOSTS`) come from the environment,
never from tool arguments, so an agent that reads a stranger's document cannot choose where the server
connects. Without allowed hosts, `open_link` refuses short URLs.

## Short links

A long link can run to thousands of characters. A short link stores the long one on a Worker you deploy.
The Worker holds only ciphertext.

```js
import { shorten, resolveShort } from "agentic-link";

const { url } = await shorten(longLink, { endpoint: "https://links.example", ttl: 604800 });
// "https://links.example/s/<id>#<key>"
const back = await resolveShort(url, { allowedHosts: ["links.example"] });
```

`shorten` encrypts the link here with a fresh AES-256-GCM key and IV. It sends only the ciphertext, the IV,
and a lifetime. The key goes into the short URL's fragment, which `fetch` never sends. The Worker cannot
read the link, and it cannot change or recall one. A short link expires after an hour, a day, a week
(default), or a month.

Worker limits: 16,384 base64url characters of ciphertext (about 12 KB of link), 100 links per address per
UTC day (`DAILY_LIMIT`), no update, no delete, and no logs. The Worker stores a keyed hash of the address
(`BRAKE_KEY`, 32 characters or more, required: the Worker refuses to serve without it). An hourly job deletes
expired links and old counts.

Deploy:

```sh
wrangler d1 create agentic-link --location eu   # then paste the id into wrangler.jsonc
wrangler d1 migrations apply DB --remote
wrangler secret put BRAKE_KEY
wrangler deploy
```

`resolveShort` fetches only `<origin>/api/v1/links/<id>` and refuses http except on loopback. Pass
`allowedHosts` when an agent opens links from strangers.

HTTP API: `POST /api/v1/links` `{ c, iv, ttl }` returns `201 { id, exp }`. `GET /api/v1/links/<id>` returns
`{ c, iv, exp }` or 404. There is no page at `/s/<id>` yet: open a short link with `resolveShort`.

## Features

- Encode a versioned snapshot into a URL fragment, compressed and size-capped.
- Decode treats every link as hostile input. It checks the size before it inflates.
- It caps the inflated size and the expansion ratio while it inflates.
- It refuses unknown versions, prototype keys, deep nesting, and payloads that fail your schema.

## Limits

- The codec needs `CompressionStream` with `deflate-raw` (Node 22, current browsers, Workers).
- Bytes after the end of the compressed data are ignored, not refused.
- A plain fragment is not encrypted. Anyone with the link can read it.
- A sealed link hides the content, not its length, its app name, or that it has a password.
- Short-link metadata: the service sees that a link was made, when, its size, and the sender's address at request time. Cloudflare sees addresses and paths as for any site.
- D1 keeps a point-in-time history for a limited window. A deleted row can come back from it. It is still ciphertext.
- Anyone with a sealed link can guess passwords offline. Use a long random password and send it by another route.
- Defaults: 64 KiB compressed, 1 MiB inflated, expansion ratio 100 above 64 KiB, depth 64.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-link"`.
- **CLI**: `npx agentic-link --help`.
- **MCP server**: `npx agentic-link mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
