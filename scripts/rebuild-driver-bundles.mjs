import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only rebuild dependency barrels. Patchright's browser implementation stays intact.
const configuration = fileURLToPath(new URL('./driver-build/', import.meta.url));
assert(process.argv[2], 'Usage: node scripts/rebuild-driver-bundles.mjs <extracted-upstream-source>');
const source = resolve(process.argv[2]);
const provenance = JSON.parse(readFileSync(join(configuration, 'source.json')));
for (const [file, digest] of Object.entries(provenance.files)) {
    assert.equal(createHash('sha256').update(readFileSync(join(source, file))).digest('hex'), digest,
        `Unexpected upstream source: ${file}; extract ${provenance.repository}@${provenance.commit}`);
}
for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(configuration, file), join(source, file));
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' });
const require = createRequire(join(source, 'package.json'));
const { build } = require('esbuild');
// Some packages declare a license but no repository. Preserve their license text
// and omit the optional URL instead of inventing attribution metadata.
const reporter = join(source, 'utils/build/bundle_report.js');
const originalReporter = readFileSync(reporter, 'utf8');
writeFileSync(reporter, originalReporter.replace(
    'throw new Error(`Malformed repository for ${pkg.name}@${pkg.version}: ${JSON.stringify(pkg.repository)}`);',
    'return undefined;'));
let writeReports;
try { ({ writeReports } = require(reporter)); } finally { writeFileSync(reporter, originalReporter); }
const definitions = [
    { name: 'patchright-core', entry: 'packages/playwright-core/src/utilsBundle.ts', file: 'lib/utilsBundle.js',
        external: ['express', '@anthropic-ai/sdk'], alias: { 'raw-body': join(source, 'utils/build/raw-body.ts') } },
    { name: 'patchright', entry: 'packages/playwright/src/transform/esmLoader.ts', file: 'lib/transform/esmLoader.js',
        external: ['playwright-core', 'playwright-core/*', '../package', '../globals', '../transform/esmLoader.js'] },
];
const outputRequire = createRequire(new URL('../package.json', import.meta.url));
for (const { name, entry, file, external, alias } of definitions) {
    const relativeOutput = join(name === 'patchright-core' ? 'packages/playwright-core' : 'packages/playwright', file);
    const outfile = join(source, relativeOutput);
    const result = await build({ absWorkingDir: source, entryPoints: [entry], outfile: relativeOutput,
        bundle: true, platform: 'node', format: 'cjs', target: 'node20', metafile: true,
        external, alias, logOverride: { 'direct-eval': 'silent' } });
    // The upstream report generator resolves its metafile paths relative to cwd.
    const previous = process.cwd();
    process.chdir(source);
    try { writeReports(result); } finally { process.chdir(previous); }
    for (const installed of name === 'patchright' ? ['patchright', 'playwright'] : [name]) {
        const directory = dirname(outputRequire.resolve(`${installed}/package.json`));
        for (const suffix of ['', '.LICENSE', '.txt']) copyFileSync(outfile + suffix, join(directory, file + suffix));
    }
    // Retain the metafile so generated versions can be traced to actual inputs.
    writeFileSync(outfile + '.meta.json', JSON.stringify(result.metafile, null, 2) + '\n');
}
