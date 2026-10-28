# agentic-link

[![npm version](https://img.shields.io/npm/v/agentic-link)](https://www.npmjs.com/package/agentic-link)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-link) · [Source](https://github.com/pooriaarab/agentic-link) · [Support](https://github.com/pooriaarab/agentic-link/issues)

Share a document as a link: the content lives in the URL, with no account and no server read.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- Encode a versioned snapshot into a URL fragment, compressed and size-capped.
- Decode with a schema check, because every link is hostile input.
- Optional password encryption with WebCrypto.
- Optional short links that store only ciphertext.
- Open a link and import it into your own storage.

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
