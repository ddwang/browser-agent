import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Includes code, generated notices, and input inventories for all five bundles.
const artifacts = JSON.parse(readFileSync(new URL('./driver-build/artifacts.json', import.meta.url), 'utf8'));

export function verifyBrowserDependencies(directory) {
    const require = createRequire(join(directory, 'package.json'));
    const manifest = require('./package.json');
    const name = manifest.name === 'magnitude-mcp' ? 'patchright' : 'playwright';
    assert.equal(manifest.dependencies[name], name === 'patchright' ? '1.64.3' : 'npm:patchright@1.64.3');
    for (const bundled of [name, 'patchright-core']) assert.ok(manifest.bundledDependencies.includes(bundled));
    const wrapperRequire = createRequire(require.resolve(`${name}/package.json`));
    assert.equal(wrapperRequire('./package.json').version, '1.64.3');
    const core = dirname(wrapperRequire.resolve('patchright-core/package.json'));
    assert.equal(wrapperRequire('patchright-core/package.json').version, '1.64.3');
    assert.equal(core, dirname(require.resolve('patchright-core/package.json')), 'Wrapper must use the bundled driver');
    const wrapper = dirname(require.resolve(`${name}/package.json`));
    for (const [artifact, digest] of Object.entries(artifacts)) {
        const [parent, ...parts] = artifact.split('/');
        const filename = join(parent === 'playwright' ? wrapper : core, ...parts);
        assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), digest,
            `${filename}: unverified driver artifact; run bun install --frozen-lockfile`);
    }
    for (const file of readdirSync(join(core, 'bin')).filter(file => file.endsWith('.sh'))) {
        assert.doesNotMatch(readFileSync(join(core, 'bin', file), 'utf8'), /curl[^\n]*(?:\s-k\b|--insecure)/);
    }
    console.log(`PASS: ${manifest.name} uses the patched Patchright 1.64.3 driver`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    verifyBrowserDependencies(resolve(process.argv[2] ?? process.cwd()));
}
