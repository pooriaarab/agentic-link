# agentic-link agent guide

Share a document as a link: the content lives in the URL, with no account and no server read.

## Mental model

A snapshot is JSON for one app. `encode` turns it into a URL fragment:
`#/v1/<app>/<base64url(deflate(json))>`. A browser never sends the fragment
to a server. `decode` turns a fragment back into a snapshot. It treats every
link as hostile input.

## SDK

```js
import { encode, decode } from "agentic-link";

const fragment = await encode({ app: "notes", version: 1, payload: { title: "Hi" } });
const { payload } = await decode(fragment, schema, { app: "notes" });
```

Password mode: `encodeSealed(snapshot, password)` and `decodeSealed(fragment, password, schema)`. A plain `decode` of a sealed link throws `sealed`.

`schema` is any object with a zod-style `safeParse`.

## Rules

- Always pass a schema to `decode`. Never trust a decoded payload without one.
- Treat a `CodecError` as a refusal. Show its `code`. Do not retry with other limits to get past it.
- Do not log or print a decoded payload. A link can hold private content.
- Link version is the link format version. Put your own payload version inside the payload.
- Send the password by another route than the link. A password in the same message protects nothing.
