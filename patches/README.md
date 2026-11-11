# Patchright dependency rebuild

Patchright 1.64.3 is still the latest published Patchright release as of November
10, 2026. Its dependency bundles contain vulnerable code. Magnitude rebuilds
`patchright-core/lib/utilsBundle.js` and
`patchright/lib/transform/esmLoader.js` from pinned upstream source with fixed
dependencies. The browser implementation, browser revisions, and SDK entry points
stay unchanged. The former brace-expansion splice has been replaced by a complete
source rebuild, retaining brace-expansion 5.0.12.

See [the advisory dispositions and artifact verification](../docs/security/embedded-driver-remediation.md).

## Source and build pipeline

The public Patchright 1.64.3 npm metadata records Playwright commit
`cfe490d941f992655948eee8fd4fd94e1c4234bf` (Playwright 1.64.1). Its
`utils/build/build.js` defines both dependency bundles, the `raw-body` alias,
externals, Node 20 target, and the generated license/input reports. These source entry points
do not contain Patchright's browser patches. The existing Patchright package
supplies the browser implementation; only the dependency bundles and their
reports are replaced.

`scripts/driver-build/source.json` pins every upstream source input plus the
build definitions, TypeScript configuration, and notice generator by SHA-256.
`scripts/driver-build/package.json` and `package-lock.json` maintain the exact
build dependencies, including all baseline components and the security updates.
The lockfile pins transitive code with npm integrity hashes. This build workspace
is separate from the SDK's runtime dependencies: root overrides alone cannot fix
inlined JavaScript.

To regenerate in a disposable upstream checkout:

```sh
mkdir -p /tmp/magnitude-playwright-source
gh api repos/microsoft/playwright/tarball/cfe490d941f992655948eee8fd4fd94e1c4234bf > /tmp/magnitude-playwright-source.tgz
tar -xzf /tmp/magnitude-playwright-source.tgz -C /tmp/magnitude-playwright-source --strip-components=1
bun patch patchright-core@1.64.3 --ignore-scripts
bun patch patchright@1.64.3 --ignore-scripts
node scripts/rebuild-driver-bundles.mjs /tmp/magnitude-playwright-source
bun patch --commit node_modules/patchright-core --ignore-scripts
bun patch --commit node_modules/patchright --ignore-scripts
```

The rebuilder validates source hashes before installing the maintained lockfile,
generates bundles and notices with esbuild and the upstream report generator,
and copies the outputs into the installed driver and both wrapper aliases.
It also saves esbuild input/output metafiles in the disposable source checkout.
The only report-generator adaptation permits absent optional repository URLs;
the package names, versions, and complete upstream license texts are retained.

Review the resulting dependency and license diffs. Update
`scripts/driver-build/artifacts.json` only after reviewing the rebuilt code and
running a live scan. This manifest pins all five notice-bearing bundles, notices,
and rebuilt input inventories. Prepack rejects mismatches. Bun applies the
patches even with `--ignore-scripts`; npm consumers receive the patched packages
inside the SDK tarball.

Pack and verify the actual publication artifact:

```sh
bun run build
mkdir -p /tmp/magnitude-package
(cd packages/magnitude-core && npm pack --pack-destination /tmp/magnitude-package)
tar -xzf /tmp/magnitude-package/ddwang-magnitude-core-*.tgz -C /tmp/magnitude-package
node scripts/audit-driver-bundles.mjs /tmp/magnitude-package/package /tmp/magnitude-package/advisories.json
bun run test:package
```

Remove the backport only after inspecting and testing an upstream tarball whose
embedded components scan clean. Keep the host's Google Chrome Stable updated
independently. Explicit browser channels, executable paths, CDP connections, and
supplied dedicated contexts retain their existing behavior.
