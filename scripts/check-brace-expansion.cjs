const assert = require('node:assert/strict');
const { minimatch } = require(process.argv[2]);

assert.deepEqual(minimatch.braceExpand('file-{a,b}.{js,ts}'), ['file-a.js', 'file-a.ts', 'file-b.js', 'file-b.ts']);
assert.deepEqual(minimatch.braceExpand('file-{1..3}.js'), ['file-1.js', 'file-2.js', 'file-3.js']);
assert.equal(minimatch('file-a.js', 'file-{a,b}.js'), true);
assert.equal(minimatch('file-c.js', 'file-{a,b}.js'), false);

// Exercise the actual inlined parser in a subprocess with a heap limit and timeout.
for (const pattern of [
    '{a,b}'.repeat(1500),
    '{1..100000}{1..100000}',
    '{' + '{a,b},'.repeat(8000) + 'z}',
    '{'.repeat(15000) + 'a,b' + '}'.repeat(15000),
    '{a}' + '}'.repeat(60000) + ',z}',
]) {
    const expanded = minimatch.braceExpand(pattern);
    assert.ok(expanded.length <= 100_000);
    assert.ok(expanded.reduce((total, item) => total + item.length, 0) <= 4_000_000);
}
console.log('PASS: bundled brace expansion preserves glob matching and bounds adversarial inputs');
