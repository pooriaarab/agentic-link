# Changelog

## 0.4.0

- New `GET /health` on the Worker. It answers `{"ok":true}`, the same as `GET /api/v1/health`. The live demo answers only `/api/v1/health` until it is redeployed from this code.
- `agentic-link mcp --help`, `-h`, `--version`, `-V`, and `-v` print and exit 0 before the server starts. The `agentic-link-mcp` bin takes the same flags. Before, a flag after `mcp` started the server and the command waited on stdin. The top-level `agentic-link -v` prints the version too. Before, it was a usage error with exit 2.
- The `zod` dependency is `^4.6.7`, from `^3.25.0`. Zod below 4.6.6 can exhaust memory on oversized constrained collections (GHSA-mrhx-c7xc-m3w5). Zod 4 words some validation errors differently, so a tool that matches on that text may need an update. zod types are not part of the public API.
- The publish workflow runs one publish at a time per ref, so two runs cannot both publish the same version.

## 0.3.0

- A short link can be revoked. Pass an owner key to `shorten` to get the right to revoke it later. The service answers a revoked link with 410 Gone. An admin key can revoke any link. ([#29](https://github.com/pooriaarab/agentic-link/pull/29))
- The SDK adds `newOwnerKey`, `revokeShort`, and `listShort`. `resolveShort` throws `gone` for a revoked link. ([#30](https://github.com/pooriaarab/agentic-link/pull/30))
- The typed client at `agentic-link/client` adds `revokeLink` and `listLinks`, and takes `ownerKey` and `adminKey` options. ([#29](https://github.com/pooriaarab/agentic-link/pull/29))
- The CLI adds `revoke` and `list`. The MCP server adds `revoke_link` and `list_links`. Keys come from `AGENTIC_LINK_OWNER_KEY` and `AGENTIC_LINK_ADMIN_KEY` only, never from a flag or a tool argument. ([#30](https://github.com/pooriaarab/agentic-link/pull/30))

## 0.2.1

- The MCP bin answers `--help` and `-h` with usage on stdout and exits 0. It answers `--version` and `-V` with the package version. Before, these flags started a stdio server and the command hung. ([#24](https://github.com/pooriaarab/agentic-link/pull/24))
