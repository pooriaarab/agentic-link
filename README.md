# agentic-link

[![npm version](https://img.shields.io/npm/v/agentic-link)](https://www.npmjs.com/package/agentic-link)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-link) · [Source](https://github.com/pooriaarab/agentic-link) · [Support](https://github.com/pooriaarab/agentic-link/issues)

Share a document as a link: the content lives in the URL, with no account and no server read.

> Status: early. The fragment codec and password mode work. Short links, the CLI,
> and the MCP server are planned. This package is not on npm yet.

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
