# Embedded driver dependency remediation

Reviewed November 10, 2026. Candidate SDK: `@ddwang/magnitude-core@0.3.1-ddwang.22`.

The published `.21` tarball reproduces **16 advisory/package-version matches** across six packages. The rebuilt `.22` tarball has **zero matches** across five notice-bearing bundles and 165 distinct component versions (163 before). No advisory exceptions or suppressions are used.

## Advisory dispositions

The baseline IDs and applicability rationale come from the consuming application’s [policy](https://github.com/Ciitizen/prod-ari-ultrafast/blob/main/.github/security/bundled-dependencies.json) and [review](https://github.com/Ciitizen/prod-ari-ultrafast/blob/main/docs/bundled-dependencies.md). Its temporary exceptions concerned optional MCP/static serving, local test patterns, and bounded SOCKS address inputs. Those application-specific arguments were not treated as fixes for SDK consumers.

| Advisory | Embedded component before | Rebuilt version | Disposition |
| --- | --- | --- | --- |
| [GHSA-frvp-7c67-39w9](https://osv.dev/vulnerability/GHSA-frvp-7c67-39w9) | `@hono/node-server@1.19.14` | `2.1.6` | Fixed; no current OSV match |
| [GHSA-rmxm-3fg6-px4f](https://osv.dev/vulnerability/GHSA-rmxm-3fg6-px4f) | `@hono/node-server@1.19.14` | `2.1.6` | Fixed; no current OSV match |
| [GHSA-22jm-h49p-29qw](https://osv.dev/vulnerability/GHSA-22jm-h49p-29qw) | `@modelcontextprotocol/sdk@1.29.0` | `1.32.2` | Fixed; no current OSV match |
| [GHSA-46jr-4wx8-v453](https://osv.dev/vulnerability/GHSA-46jr-4wx8-v453) | `@modelcontextprotocol/sdk@1.29.0` | `1.32.2` | Fixed; no current OSV match |
| [GHSA-6prh-2h8m-c8cw](https://osv.dev/vulnerability/GHSA-6prh-2h8m-c8cw) | `@modelcontextprotocol/sdk@1.29.0` | `1.32.2` | Fixed; no current OSV match |
| [GHSA-6qxp-vccf-f47h](https://osv.dev/vulnerability/GHSA-6qxp-vccf-f47h) | `@modelcontextprotocol/sdk@1.29.0` | `1.32.2` | Fixed; no current OSV match |
| [GHSA-f897-62hf-6gxq](https://osv.dev/vulnerability/GHSA-f897-62hf-6gxq) | `@modelcontextprotocol/sdk@1.29.0` | `1.32.2` | Fixed; no current OSV match |
| [GHSA-rvq5-wwqv-78pq](https://osv.dev/vulnerability/GHSA-rvq5-wwqv-78pq) | `@modelcontextprotocol/sdk@1.29.0` | `1.32.2` | Fixed; no current OSV match |
| [GHSA-333x-w4r6-6crp](https://osv.dev/vulnerability/GHSA-333x-w4r6-6crp) | `fast-uri@3.1.7` | `3.1.9` | Fixed; no current OSV match |
| [GHSA-hrr3-gc8f-f4qj](https://osv.dev/vulnerability/GHSA-hrr3-gc8f-f4qj) | `fast-uri@3.1.7` | `3.1.9` | Fixed; no current OSV match |
| [GHSA-w74x-v6f9-j3xg](https://osv.dev/vulnerability/GHSA-w74x-v6f9-j3xg) | `fast-uri@3.1.7` | `3.1.9` | Fixed; no current OSV match |
| [GHSA-wjr9-j795-jxcr](https://osv.dev/vulnerability/GHSA-wjr9-j795-jxcr) | `fast-uri@3.1.7` | `3.1.9` | Fixed; no current OSV match |
| [GHSA-xhq7-xmqj-769h](https://osv.dev/vulnerability/GHSA-xhq7-xmqj-769h) | `fast-uri@3.1.7` | `3.1.9` | Fixed; no current OSV match |
| [GHSA-rxp7-6hxx-x8q5](https://osv.dev/vulnerability/GHSA-rxp7-6hxx-x8q5) | `ip-address@10.7.2` | `10.7.6` | Fixed; no current OSV match |
| [GHSA-g3hv-75wg-m249](https://osv.dev/vulnerability/GHSA-g3hv-75wg-m249) | `minimatch@10.2.5` | `11.0.1` | Fixed; no current OSV match |
| [GHSA-mrhx-c7xc-m3w5](https://osv.dev/vulnerability/GHSA-mrhx-c7xc-m3w5) | `zod@4.4.3` | `4.6.7` | Fixed; no current OSV match |

All findings occur in `patchright-core/lib/utilsBundle.js`. Minimatch also occurs in `playwright/lib/transform/esmLoader.js` (the SDK’s `playwright` directory is the Patchright wrapper alias). Hono requires the fixed 2.x line; minimatch requires 11.0.1. The rebuilt MCP SDK supports Hono 2.x. Fast-uri remains on its fixed 3.x line. Brace-expansion remains at the previously backported 5.0.12. New transitive components are `@isaacs/nonrecursive-glob-match@1.1.0` and `hono@4.13.17`; both scan clean.

**Unresolved findings: none in the scanned embedded npm inventory.** This does not attest to unlisted JavaScript, WebP/WASM, host browsers, Node, or operating-system libraries.

## Artifact hashes

SHA-256 identifies the exact tarballs reviewed:

- Before (.21): `2f875d90a3bc22327244e71e7c8deb7eec76af7b8ceea34debdad6389808171e`
- After (.22): `dfff763fdf0321f7a656c143f52d4c839228d3b396590b117e48ed8b8cc09b45`

| Bundle | Before SHA-256 | After SHA-256 |
| --- | --- | --- |
| `patchright/lib/matchers/expect.js` | `da085b0d6b780ff5c47e4e62f476c9b184c1026f0ec97f9b11aa4f1bc26daff5` | `da085b0d6b780ff5c47e4e62f476c9b184c1026f0ec97f9b11aa4f1bc26daff5` |
| `patchright/lib/transform/babelBundle.js` | `cd656ca6a9857b3efbbb7e015a2fa3abd4bc0e88956661cc9b14d9d7f142f093` | `cd656ca6a9857b3efbbb7e015a2fa3abd4bc0e88956661cc9b14d9d7f142f093` |
| `patchright/lib/transform/esmLoader.js` | `d85eb84e7a00e74b378fef36f4e91c2cad6c803254b5edb52c96ef0dd1b3babe` | `a65e56dcce22eb0ef437656c28bcb6fce26b7e2db59c1244f63cb2a5a5d90478` |
| `patchright-core/lib/serverRegistry.js` | `38025f08f335705b099b9f188bf45b5908a56a722825fe895b1e90f56d5595b6` | `38025f08f335705b099b9f188bf45b5908a56a722825fe895b1e90f56d5595b6` |
| `patchright-core/lib/utilsBundle.js` | `b722d49dee6c5a82578799054b155984123018f682dd99683638663af5d12431` | `f14a299e5b0534ee00cb3941a432a66b371b0dc86cf72dbe191d592da4dd0765` |

The complete [before inventory](driver-before.json) and [after inventory](driver-after.json) include every component, bundle hash, notice hash, scan timestamp, and advisory ID. The [artifact manifest](../../scripts/driver-build/artifacts.json) enforces these code/notice hashes and the rebuilt input inventories during prepack and clean installation checks.

## Source and behavior preservation

See the [rebuild instructions](../../patches/README.md) for the pinned source revision, per-input hashes, dependency lockfile, upstream build definitions, and report generation. Both maintained bundles were regenerated twice and reproduced the same code, notices, and input-inventory hashes. A clean Bun installation using a separate empty cache verifies patch application independently of the edited checkout.

Compared with the published `.21` tarball, both `dist/index.cjs` and `dist/index.mjs` are byte-identical. All browser implementation files, browser revisions, and the other three dependency bundles are unchanged. Only the two dependency barrels, notices, and input inventories change; Bun’s package marker files also differ.

## Packaged verification

The SDK was packed with `npm pack`, installed into a clean npm consumer with lifecycle scripts disabled, scanned, and exercised through its installed public API. Verification uses the saved `.22` tarball, not source imports.

- CJS and ESM imports, checkpoint restoration, lifecycle and cancellation/draining checks.
- Zod 4 JSON schema generation and real BAML schema conversion through a local OpenAI-compatible fixture.
- Invalid plan followed by one corrected response; the invalid action does not execute and the valid action executes once. The repair request includes the validation correction.
- Browser server connection, native coordinate clicks and typing, native select handling, and cleanup in headless Chrome 157.0.8103.50.
- Supplied dedicated `BrowserContext` identity is preserved. Agent stop closes that context; the host browser and an unrelated sibling context remain usable. This is the existing ownership contract.
- `telemetry:false` produces zero PostHog captures during fixture planning, actions, browser startup, and shutdown.
- The exact installed tarball passes on Node 20.20.0, 20.20.2, 22.22.0, 22.22.2, 23.11.1, 24.21.0, 25.9.0, and 26.13.0.
- `bun run build`, `bun run lint`, and `bun run typecheck` pass. The full offline suite passes: **457 tests, zero failures**, including browser/provider fixtures.
- Core-only clean package installation passes strict npm engine validation on Node 20.20.0; all three packages pass it on Node 22.22.0.
- All three browser packages retain patched bundles in clean npm installations; their ESM test loader discovers a fixture and brace-expansion adversarial probes pass.

The live scanner inventories every `*.js.LICENSE` under the SDK’s embedded wrapper/core and requires all five known notices. It queries every declared component against OSV, rejects incomplete/paginated/error responses, and fails on any finding. Notice versions are backed by the maintained source lockfile and esbuild-generated input reports; hashes enforce the reviewed build.

**Requirements unchanged:** Core supports Node `^20.20.0 || >=22.22.0`; the test runner requires Node 22.22 or later. Default launches use installed Google Chrome Stable. No browser revision or browser-selection behavior changes. No paid model calls were made.

## Release

The PR prepares `.22` for the repository’s existing manual core publisher (`scripts/publish.sh`), which now accepts the exact verified tarball as an optional argument. It also includes a Changesets entry for all three packages sharing these patches. The separate automated Changesets workflow currently plans **1.0.0** because existing major entries are pending; it does not produce `.22`. Local npm authentication initially returned E401, and no repository release secret was configured. Publication and CI status are recorded in the PR; candidate verification alone is not a publication claim.
