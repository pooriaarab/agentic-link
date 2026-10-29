# Changelog

## 0.4.0

Minor. Additive. The SDK, the CLI, the MCP tools and the `/api/v1` routes keep their shape.

- The Worker serves `GET /health` as well as `GET /api/v1/health`. Both use one handler. ([#34](https://github.com/pooriaarab/agentic-link/pull/34))
- `mcp --help`, `-h`, `--version`, `-V` and `-v` print their text and exit 0. They do not start the MCP server. Both MCP bins share this check, and `agentic-link-mcp` accepts `-v` now. Before, `mcp --help` started the server and waited on stdin. ([#34](https://github.com/pooriaarab/agentic-link/pull/34))
- The zod dependency is `^4.6.7`. Earlier versions can use a lot of memory on oversized constrained collections (GHSA-mrhx-c7xc-m3w5). ([#40](https://github.com/pooriaarab/agentic-link/pull/40))
- The MCP SDK floor is `^1.23.0`, the first release that accepts zod 4 schemas. Before, an install could resolve an older SDK, which reads the zod 4 tool schemas wrongly.
- The publish workflow runs one publish at a time per ref. A newer run waits, and an older run that is still waiting is cancelled. A running publish finishes. ([#38](https://github.com/pooriaarab/agentic-link/pull/38))
- A test checks `GET /health`, and the README says which health path the demo serves. ([#37](https://github.com/pooriaarab/agentic-link/pull/37))

## 0.3.0

- A short link can be revoked. Pass an owner key to `shorten` to get the right to revoke it later. The service answers a revoked link with 410 Gone. An admin key can revoke any link. ([#29](https://github.com/pooriaarab/agentic-link/pull/29))
- The SDK adds `newOwnerKey`, `revokeShort`, and `listShort`. `resolveShort` throws `gone` for a revoked link. ([#30](https://github.com/pooriaarab/agentic-link/pull/30))
- The typed client at `agentic-link/client` adds `revokeLink` and `listLinks`, and takes `ownerKey` and `adminKey` options. ([#29](https://github.com/pooriaarab/agentic-link/pull/29))
- The CLI adds `revoke` and `list`. The MCP server adds `revoke_link` and `list_links`. Keys come from `AGENTIC_LINK_OWNER_KEY` and `AGENTIC_LINK_ADMIN_KEY` only, never from a flag or a tool argument. ([#30](https://github.com/pooriaarab/agentic-link/pull/30))

## 0.2.1

- The MCP bin answers `--help` and `-h` with usage on stdout and exits 0. It answers `--version` and `-V` with the package version. Before, these flags started a stdio server and the command hung. ([#24](https://github.com/pooriaarab/agentic-link/pull/24))
