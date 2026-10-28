# agentic-link

[![npm version](https://img.shields.io/npm/v/agentic-link)](https://www.npmjs.com/package/agentic-link)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-link) · [Source](https://github.com/pooriaarab/agentic-link) · [Support](https://github.com/pooriaarab/agentic-link/issues)

Share a document as a link: the content lives in the URL, with no account and no server read.

> Status: early. The fragment codec works. Password mode, short links, the CLI,
> and the MCP server are planned. This package is not on npm yet.

## Quick start

```js
import { encode, decode } from "agentic-link";
import { z } from "zod";

const fragment = await encode({ app: "notes", version: 1, payload: { title: "Hi" } });
// "#/v1/notes/<base64url(deflate(json))>"

const { payload } = await decode(fragment, z.object({ title: z.string() }), { app: "notes" });
```

## Features

- Encode a versioned snapshot into a URL fragment, compressed and size-capped.
- Decode treats every link as hostile input. It checks the size before it inflates.
- It caps the inflated size and the expansion ratio while it inflates.
- It refuses unknown versions, prototype keys, deep nesting, and payloads that fail your schema.

## Limits

- The codec needs `CompressionStream` with `deflate-raw` (Node 22, current browsers, Workers).
- Bytes after the end of the compressed data are ignored, not refused.
- A fragment is not encrypted. Anyone with the link can read it.
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
