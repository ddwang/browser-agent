# Dependency maintenance

Use Bun 1.4.4 and the root `bun.lock` for this workspace. Node.js must satisfy
`^22.13.0 || >=24`, as declared in the root package manifest.

```sh
bun install --frozen-lockfile
bun audit
```

The root npm lockfile and the old `magnitude-extract` lockfile were obsolete.
`magnitude-extract` is covered by the root workspace lockfile. The test examples
use a developer's local `.yalc/magnitude-test` package; their generated lockfile
is ignored and they are not an independently reproducible Dependabot target.

## Automated updates

`.github/dependabot.yml` checks the Bun workspace and GitHub Actions weekly.
The file must reach the default branch before the schedule takes effect.
Security alerts and automatic security updates are enabled in GitHub settings.

The initial Dependabot jobs selected `npm_and_yarn` for Bun files and failed.
The Bun configuration corrects that mismatch. After merging, inspect
**Insights → Dependency graph → Dependabot → Recent update jobs** to verify
successful updates.

## Security updates

The Bun audit on 2026-11-04 reports **zero vulnerabilities across 543 packages**,
down from 139 advisory findings in the original Bun lockfile. No advisories
are ignored or dismissed.

- Zod 4.6.6 replaces Zod 3. Schema conversion uses Zod's native JSON Schema API,
  and oversized arrays stop validation at their size limit.
- The MCP server and test runner use the local `@ddwang/magnitude-core` workspace.
  This removes the published core package that still required vulnerable versions.
- tsup replaces pkgroll, removing the build dependency on unpatched deepmerge.
  The build emits CommonJS, ESM, CLI, declaration, and worker files explicitly.
- glob 14 and sucrase 3.35.1 remove the vulnerable glob versions.
- ESLint 10 uses a flat TypeScript configuration. Lint reports errors normally.

Two root overrides remain necessary for build tools whose declared ranges do not
include the fixes:

| Override | Reason | Remove when |
| --- | --- | --- |
| `minimatch: ^11.0.1` | ESLint and the TypeScript parser still request minimatch 10. | Both upstream dependency ranges accept a patched version. |
| `esbuild: ^0.28.2` | tsup 8 requests the vulnerable esbuild 0.27 branch. | tsup accepts esbuild 0.28.1 or later. |

These overrides were checked with real lint and package builds. The test runner's
own esbuild dependency directly requires the patched version; downstream runtime
consumers do not rely on this repository's overrides.

## Zod 4 migration and releases

Custom action and extraction schemas must use Zod 4. Import `z` from
`@ddwang/magnitude-core` to use the same validator as the agent:

```ts
import { createAction, z } from '@ddwang/magnitude-core';

const action = createAction({
    name: 'record',
    schema: z.object({ value: z.string() }),
    resolver: async ({ input }) => { console.log(input.value); },
});
```

The release changeset coordinates the core, MCP server, and test runner updates.
The MCP server and runner declare ordinary semver ranges for the core workspace.
Changesets updates those ranges when versioning releases; its npm publisher does
not rewrite `workspace:` protocols. Validate the actual release path with npm-packed
tarballs, including a temporary Changesets version run, and check their dependencies
and entry points. No packages have been published as part of this update.

## Validation

```sh
bun run build
bun run check-types
bun run lint
bun audit
bun run typecheck
bun run test:offline
bun run test:package
```

Build before running tests to generate the BAML client. Browser tests also need
the Chromium installation triggered by the MCP workspace's install script.
Stage tracked-file deletions before evaluation CLI tests: their provenance hash
reads the Git index's file list.

Validation covers all five package builds and type checks, lint, the offline test
suite, and built-package smoke checks for CommonJS/ESM imports, the CLI,
configuration/test workers, and MCP initialization and tool-schema responses.

## Terminal renderer

The test runner uses Ink 8 and requires Node.js 22.13 or later. Workspace
development also requires Node.js 22.13 or later; CI checks Node.js 22 and 24.
This support-floor change applies to the runner and workspace, not the core
library. The CLI bundles `ink-spinner`, keeping its React imports on the
renderer’s React instance even when an npm consumer retains an older hoisted
spinner. Ink and React remain external dependencies.
