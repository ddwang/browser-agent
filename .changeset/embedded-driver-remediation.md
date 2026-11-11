---
"@ddwang/magnitude-core": patch
"magnitude-mcp": patch
"magnitude-test": patch
---

Rebuild the embedded Patchright dependency bundles with fixed Hono, MCP SDK,
fast-uri, ip-address, minimatch, and Zod versions. Regenerate notices and input
inventories, pin the resulting artifact hashes, and scan/test clean npm tarball
installations. Preserve Patchright browser behavior and the existing Node and
browser requirements.
