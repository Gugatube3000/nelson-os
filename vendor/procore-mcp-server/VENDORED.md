# Vendored: procore-mcp-server

- Source: https://github.com/TylerIlunga/procore-mcp-server (MIT, see LICENSE)
- Commit: e3c9da2d17a7d9648a2e793f14e4bbc3726218b4
- Included: compiled `dist/src` (built with `tsc`), the committed endpoint catalog in `data/`, package.json, README.

Nelson OS runs this server as a child process (stdio MCP) for Procore discovery and API calls.
Nelson OS performs the Procore OAuth sign-in itself and writes tokens to the path in
`PROCORE_TOKEN_PATH`, which this server reads. Procore writes never reach this server
without Jonathan's approval in Nelson OS (see server/sync/procore.js).

To update: clone the upstream repo, `npm install && npx tsc`, then replace `dist/src` and `data/`.
