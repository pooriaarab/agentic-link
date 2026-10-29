# Changelog

## 0.2.1

- The MCP bin answers `--help` and `-h` with usage on stdout and exits 0. It answers `--version` and `-V` with the package version. Before, these flags started a stdio server and the command hung. ([#24](https://github.com/pooriaarab/agentic-link/pull/24))
