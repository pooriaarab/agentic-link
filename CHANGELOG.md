# Changelog

## 0.3.0

- A short link can be revoked. Pass an owner key to `shorten` to get the right to revoke it later. The service answers a revoked link with 410 Gone. An admin key can revoke any link. ([#29](https://github.com/pooriaarab/agentic-link/pull/29))
- The SDK adds `newOwnerKey`, `revokeShort`, and `listShort`. `resolveShort` throws `gone` for a revoked link.
- The CLI adds `revoke` and `list`. The MCP server adds `revoke_link` and `list_links`. Keys come from `AGENTIC_LINK_OWNER_KEY` and `AGENTIC_LINK_ADMIN_KEY` only, never from a flag or a tool argument. ([#30](https://github.com/pooriaarab/agentic-link/pull/30))

## 0.2.1

- The MCP bin answers `--help` and `-h` with usage on stdout and exits 0. It answers `--version` and `-V` with the package version. Before, these flags started a stdio server and the command hung. ([#24](https://github.com/pooriaarab/agentic-link/pull/24))
