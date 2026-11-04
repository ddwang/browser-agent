import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
assert.equal(require('brace-expansion/package.json').version, '5.0.12');
const name = process.argv[2] ?? 'patchright-core';
assert.ok(['patchright', 'patchright-core'].includes(name));
assert.equal(require(`${name}/package.json`).version, '1.64.3');
const directory = dirname(require.resolve(`${name}/package.json`));
const filename = join(directory, name === 'patchright-core' ? 'lib/utilsBundle.js' : 'lib/transform/esmLoader.js');
const source = await readFile(filename, 'utf8');
const start = source.indexOf('// node_modules/brace-expansion/dist/esm/index.js\n');
const end = source.indexOf('// node_modules/minimatch/dist/esm/assert-valid-pattern.js\n', start);
assert.ok(start !== -1 && end > start, 'Unexpected Patchright bundle layout');
assert.ok(source.slice(start, end).includes('const { max = EXPANSION_MAX } = options'), 'Expected the unpatched 5.0.7 bundle');
const result = await build({
    stdin: { contents: "export { expand } from 'brace-expansion';", resolveDir: dirname(require.resolve('brace-expansion/package.json')) },
    bundle: true,
    format: 'iife',
    globalName: 'magnitudeBraceExpansion',
    platform: 'node',
    target: 'node20',
    write: false,
});
await writeFile(filename, source.slice(0, start)
    + '// Magnitude security backport: brace-expansion 5.0.12 (see patches/README.md).\n'
    + result.outputFiles[0].text + '\nvar expand = magnitudeBraceExpansion.expand;\n\n'
    + source.slice(end));
const notices = `${filename}.LICENSE`;
await writeFile(notices, (await readFile(notices, 'utf8')).replaceAll('brace-expansion@5.0.7', 'brace-expansion@5.0.12'));
