# Patchright security backport

The Patchright 1.64.3 patches replace the inlined brace-expansion 5.0.7 in the
driver's `lib/utilsBundle.js` and the wrapper's `lib/transform/esmLoader.js`
with bundles of the upstream 5.0.12 implementation. They keep
the rest of Patchright unchanged and preserves the upstream license notices.
This addresses CVE-2026-14257, CVE-2026-69152, CVE-2026-102276,
CVE-2026-102278, and CVE-2026-102277. See
[the upstream report](https://github.com/microsoft/playwright/issues/43895).

Bun applies the patch even with `--ignore-scripts`. The three published browser
packages bundle their pinned Patchright wrapper and patched driver because a
consumer's npm install does not apply this repository's Bun patches. Their
prepack checks reject unpatched drivers. Package smoke tests also inspect the
tarballs and test a clean npm installation with lifecycle scripts disabled.

To regenerate, start from an unpatched Patchright 1.64.3 installation, run
`bun patch patchright-core@1.64.3 --ignore-scripts`, then
`node scripts/rebuild-patchright-braces.mjs patchright-core` and
`bun patch --commit node_modules/patchright-core --ignore-scripts`. Repeat these
steps with `patchright` instead of `patchright-core`. Review the
resulting diffs before updating the digests in
`scripts/verify-browser-dependencies.mjs`.

Remove this backport and the bundled dependencies when a verified upstream
release includes brace-expansion 5.0.12 or later. Updating a root override does
not replace code already inlined in the driver.

Normal Magnitude launches use installed Google Chrome Stable. Keep Chrome
updated independently of the npm dependencies. Explicit `channel`,
`executablePath`, remote CDP, and supplied browser/context options remain under
the caller's control; this patch does not update those browsers.
