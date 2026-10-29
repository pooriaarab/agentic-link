# agentic-link agent guide

Share a document as a link: the content lives in the URL, with no account and no server read.

## Mental model

A snapshot is JSON for one app. `encode` turns it into a URL fragment:
`#/v1/<app>/<base64url(deflate(json))>`. A browser never sends the fragment
to a server. `decode` turns a fragment back into a snapshot. It treats every
link as hostile input.

## CLI and MCP

- CLI: `agentic-link encode|decode|shorten|open`. Passwords: `--password-env VAR` or `--password-file`, never argv.
- MCP: `agentic-link mcp` with `encode_link`, `decode_link`, `shorten_link`, `open_link`.
- To hand a document to a person: `encode --base <page url>`, then `shorten` if the URL is long, then give them the one URL.

## SDK

```js
import { encode, decode } from "agentic-link";

const fragment = await encode({ app: "notes", version: 1, payload: { title: "Hi" } });
const { payload } = await decode(fragment, schema, { app: "notes" });
```

Password mode: `encodeSealed(snapshot, password)` and `decodeSealed(fragment, password, schema)`. A plain `decode` of a sealed link throws `sealed`.

Short links: `shorten(link, { endpoint })` and `resolveShort(shortUrl, { allowedHosts })`. The key lives in the short URL's fragment. Never send it anywhere.

`schema` is any object with a zod-style `safeParse`.

## Rules

- Always pass a schema to `decode`. Never trust a decoded payload without one.
- Treat a `CodecError` as a refusal. Show its `code`. Do not retry with other limits to get past it.
- Do not log or print a decoded payload. A link can hold private content.
- Link version is the link format version. Put your own payload version inside the payload.
- Send the password by another route than the link. A password in the same message protects nothing.
- Set `AGENTIC_LINK_ALLOWED_HOSTS` (MCP) or `--allow-host` (CLI), and pass `allowedHosts` to `resolveShort` for links from strangers. Never open a short link on a host you did not choose.
- The short-link service holds ciphertext only. Do not paste a short URL, which holds the key, into logs or tickets.
