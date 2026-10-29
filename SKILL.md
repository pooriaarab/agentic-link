---
name: agentic-link
description: Share a document as a link: the content lives in the URL fragment, with no account and no server read. Use to hand a snapshot to a person as one URL, or to open one safely.
---

# agentic-link

```js
import { encode, decode } from "agentic-link";

const fragment = await encode({ app: "notes", version: 1, payload: { title: "Hi" } });
const { payload } = await decode(fragment, schema, { app: "notes" });
```

Password mode: `encodeSealed(snapshot, password)` and `decodeSealed(fragment, password, schema)`.

Short links: `shorten(link, { endpoint })` returns `https://host/s/<id>#<key>`. `resolveShort(url, { allowedHosts })` opens it.

## CLI and MCP

```sh
agentic-link encode --app notes --json '{...}' --base https://app.example/notes   # one URL
agentic-link shorten "$URL" --endpoint https://links.example
agentic-link open "$URL" --allow-host links.example
agentic-link mcp   # tools: encode_link, decode_link, shorten_link, open_link, revoke_link, list_links
```

Passwords: `--password-env VAR` or `--password-file`. Never on the command line.

## Rules

- Always pass a schema to `decode`.
- A `CodecError` is a refusal. Report its `code`. Do not retry with higher limits.
- Never print a decoded payload into logs.
- Send the password by another route than the link.
- A short URL holds the key. Do not log it.
