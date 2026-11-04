---
"@ddwang/magnitude-core": minor
"magnitude-mcp": minor
"magnitude-test": minor
"magnitude-extract": patch
"create-magnitude-app": patch
---

Upgrade schema validation to Zod 4.6.6 and remove vulnerable runtime and build dependencies. Custom action and extraction schemas must now use Zod 4; the core package re-exports the compatible `z` instance.

The MCP server and test runner now depend on the local `@ddwang/magnitude-core` workspace so their schemas and runtime stay compatible. Release these packages together. Replace pkgroll with tsup while preserving CommonJS, ESM, CLI, and worker entry points.
