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

## Rules

- Always pass a schema to `decode`.
- A `CodecError` is a refusal. Report its `code`. Do not retry with higher limits.
- Never print a decoded payload into logs.
