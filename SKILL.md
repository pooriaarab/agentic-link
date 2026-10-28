---
name: agentic-link
description: Share a document as a link: the content lives in the URL, with no account and no server read. Keywords: share,link,url,snapshot,privacy,encryption,no-account,agents,mcp,cli.
---

# agentic-link

Share a document as a link: the content lives in the URL, with no account and no server read.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-link";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-link summary --text "some text"
agentic-link dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-link mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
