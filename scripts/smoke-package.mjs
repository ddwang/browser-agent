import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowserDependencies } from './verify-browser-dependencies.mjs';
import { verifyPackagedAPI } from './verify-packaged-api.mjs';

// Changesets publishes this Bun workspace with npm, which does not rewrite workspace: ranges.
const packageNames = process.env.MAGNITUDE_CORE_ONLY ? ['magnitude-core'] : ['magnitude-core', 'magnitude-mcp', 'magnitude-test'];
const installedNames = packageNames.map(name => name === 'magnitude-core' ? '@ddwang/magnitude-core' : name);
const packed = await mkdtemp(join(tmpdir(), 'magnitude-npm-smoke-'));
try {
    for (const name of packageNames) {
        execFileSync('npm', ['pack', '--pack-destination', packed], {
            cwd: fileURLToPath(new URL(`../packages/${name}/`, import.meta.url)), stdio: 'pipe',
        });
    }
    for (const filename of await readdir(packed)) {
        const manifest = JSON.parse(execFileSync('tar', ['-xOf', join(packed, filename), 'package/package.json'], { encoding: 'utf8' }));
        if (manifest.name !== '@ddwang/magnitude-core') assert.ok(manifest.dependencies['@ddwang/magnitude-core']);
        for (const range of Object.values(manifest.dependencies)) assert.ok(!range.startsWith('workspace:'), `${manifest.name}: ${range}`);
        const listing = execFileSync('tar', ['-tf', join(packed, filename)], { encoding: 'utf8' });
        assert.ok(listing.includes('package/node_modules/patchright-core/lib/utilsBundle.js'));
        console.log(`PASS: ${manifest.name} npm tarball has publishable dependency ranges`);
    }
    const consumer = await mkdtemp(join(tmpdir(), 'magnitude-browser-consumer-'));
    try {
        const tarballs = (await readdir(packed)).map(filename => join(packed, filename));
        execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', ...tarballs], {
            cwd: consumer, stdio: 'pipe', timeout: 180_000,
        });
        for (const name of installedNames) {
            const directory = join(consumer, 'node_modules', name);
            verifyBrowserDependencies(directory);
            const installedRequire = createRequire(join(directory, 'package.json'));
            execFileSync(process.execPath, ['--max-old-space-size=128',
                fileURLToPath(new URL('./check-brace-expansion.cjs', import.meta.url)),
                installedRequire.resolve('patchright-core/lib/utilsBundle')], { stdio: 'inherit', timeout: 15_000 });
            const wrapper = name === 'magnitude-mcp' ? 'patchright' : 'playwright';
            await writeFile(join(directory, 'security-probe.test.mjs'),
                `import { test } from '${wrapper}/test';\ntest('patched loader', () => {});\n`);
            await writeFile(join(directory, 'security-probe.config.mjs'),
                "export default { testMatch: 'security-probe.test.mjs' };\n");
            const cli = join(installedRequire.resolve(`${wrapper}/package.json`), '..', 'cli.js');
            const listed = execFileSync(process.execPath, [cli, 'test', '--list', '--config', 'security-probe.config.mjs'], {
                cwd: directory, encoding: 'utf8', timeout: 30_000,
            });
            assert.ok(listed.includes('patched loader'));
            console.log(`PASS: ${name} patched ESM loader discovers tests`);
        }
        console.log('PASS: clean npm installation retains the patched driver with scripts disabled');
        execFileSync(process.execPath, [fileURLToPath(new URL('./audit-driver-bundles.mjs', import.meta.url)),
            join(consumer, 'node_modules/@ddwang/magnitude-core'), join(consumer, 'advisories.json')], { stdio: 'inherit', timeout: 45_000 });
        await verifyPackagedAPI(join(consumer, 'node_modules/@ddwang/magnitude-core'));
    } finally { await rm(consumer, { recursive: true, force: true }); }
} finally { await rm(packed, { recursive: true, force: true }); }
