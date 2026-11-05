---
"@ddwang/magnitude-core": minor
"magnitude-test": minor
"magnitude-mcp": patch
---

Replace stale Playwright/Rebrowser dependencies with pinned Patchright 1.64.3
and bundle a security backport of brace-expansion 5.0.12 in npm releases.

Browser launches now use installed Google Chrome Stable by default. Install
Chrome and keep it updated; Magnitude no longer downloads bundled Chromium
during test initialization or MCP installation. Explicit browser selections
remain supported and must be updated by the caller.
