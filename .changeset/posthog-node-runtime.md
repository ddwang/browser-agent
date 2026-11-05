---
"@ddwang/magnitude-core": major
"magnitude-mcp": major
"magnitude-test": major
---

Upgrade PostHog to 5.61.2 and align supported Node.js versions with its security
minimum. Core and MCP now require Node.js `^20.20.0 || >=22.22.0`; the test runner
requires Node.js 22.22 or later. Upgrade Node.js before installing this release.

Core continues to own the shared telemetry client used by the test runner.
