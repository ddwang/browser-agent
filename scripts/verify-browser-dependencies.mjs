import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Regenerate with scripts/rebuild-patchright-braces.mjs, then review the patch before updating this digest.
const bundleDigest = 'b722d49dee6c5a82578799054b155984123018f682dd99683638663af5d12431';
const loaderDigest = 'd85eb84e7a00e74b378fef36f4e91c2cad6c803254b5edb52c96ef0dd1b3babe';

function verifyBundle(filename, digest) {
    assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), digest,
        `${filename}: unverified Patchright bundle; run bun install --frozen-lockfile`);
    const notices = readFileSync(`${filename}.LICENSE`, 'utf8');
    assert.ok(notices.includes('brace-expansion@5.0.12'));
    assert.ok(!notices.includes('brace-expansion@5.0.7'));
}

export function verifyBrowserDependencies(directory) {
    const require = createRequire(join(directory, 'package.json'));
    const manifest = require('./package.json');
    const name = manifest.name === 'magnitude-mcp' ? 'patchright' : 'playwright';
    assert.equal(manifest.dependencies[name], name === 'patchright' ? '1.64.3' : 'npm:patchright@1.64.3');
    for (const bundled of [name, 'patchright-core']) assert.ok(manifest.bundledDependencies.includes(bundled));
    const wrapperRequire = createRequire(require.resolve(`${name}/package.json`));
    assert.equal(wrapperRequire('./package.json').version, '1.64.3');
    verifyBundle(join(dirname(require.resolve(`${name}/package.json`)), 'lib/transform/esmLoader.js'), loaderDigest);
    const core = dirname(wrapperRequire.resolve('patchright-core/package.json'));
    assert.equal(wrapperRequire('patchright-core/package.json').version, '1.64.3');
    assert.equal(core, dirname(require.resolve('patchright-core/package.json')), 'Wrapper must use the bundled driver');
    verifyBundle(join(core, 'lib/utilsBundle.js'), bundleDigest);
    for (const file of readdirSync(join(core, 'bin')).filter(file => file.endsWith('.sh'))) {
        assert.doesNotMatch(readFileSync(join(core, 'bin', file), 'utf8'), /curl[^\n]*(?:\s-k\b|--insecure)/);
    }
    console.log(`PASS: ${manifest.name} uses the patched Patchright 1.64.3 driver`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    verifyBrowserDependencies(resolve(process.argv[2] ?? process.cwd()));
}
