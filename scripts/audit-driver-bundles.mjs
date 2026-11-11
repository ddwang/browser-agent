import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function parseNotice(text) {
  const marker = 'The following npm packages are inlined into this bundle.';
  assert(text.includes(marker), 'Unsupported bundle notice: npm inventory heading is missing');
  assert(text.includes('\n%% '), 'Unsupported bundle notice: inventory terminator is missing');
  const section = text.split(marker)[1].split('\n%% ')[0];
  const lines = section.split('\n').map(line => line.trim()).filter(Boolean);
  assert(lines.length, 'Empty bundle inventory');
  return lines.map(line => {
    const match = /^- ((?:@[^/\s]+\/)?[^@\s]+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?: \(https?:\/\/[^\s]+\))?$/.exec(line);
    assert(match, `Unsupported bundle inventory entry: ${line}`);
    return { name: match[1], version: match[2] };
  });
}

export async function queryAdvisories(packages, request = fetch) {
  const response = await request('https://api.osv.dev/v1/querybatch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ queries: packages.map(({ name, version }) => ({ package: { ecosystem: 'npm', name }, version })) }),
  });
  assert(response.ok, `OSV request failed: HTTP ${response.status}`);
  const { results } = await response.json();
  assert(Array.isArray(results) && results.length === packages.length, 'Incomplete OSV response');
  return results.flatMap((result, index) => {
    assert(result && typeof result === 'object' && !Array.isArray(result), 'Malformed OSV result');
    assert(!result.next_page_token, 'OSV response is paginated; scan coverage is incomplete');
    assert(!result.error, 'OSV returned a query error');
    assert(Object.keys(result).every(key => ['vulns', 'next_page_token'].includes(key)), 'Unexpected OSV result fields');
    assert(result.vulns === undefined || Array.isArray(result.vulns), 'Malformed OSV vulnerabilities');
    return (result.vulns ?? []).map(vulnerability => {
      assert(typeof vulnerability.id === 'string' && /^[\w-]+$/.test(vulnerability.id), 'Malformed OSV advisory ID');
      return { ...packages[index], advisory: vulnerability.id, url: `https://osv.dev/vulnerability/${vulnerability.id}` };
    });
  });
}


// Scan the unpacked SDK, including every notice-bearing embedded JavaScript bundle.
assert(process.argv[2] && process.argv[3], 'Usage: node scripts/audit-driver-bundles.mjs <unpacked-sdk> <report.json>');
const root = resolve(process.argv[2]);
const bundles = [];
const packages = new Map();
for (const name of ['playwright', 'patchright-core']) {
  const directory = join(root, 'node_modules', name);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const notices = (await readdir(directory, { recursive: true })).filter(file => file.endsWith('.js.LICENSE')).sort();
  const expected = name === 'playwright' ? ['lib/matchers/expect.js', 'lib/transform/babelBundle.js', 'lib/transform/esmLoader.js']
    : ['lib/serverRegistry.js', 'lib/utilsBundle.js'];
  for (const file of expected) assert(notices.includes(file + '.LICENSE'), `Missing notice: ${name}/${file}`);
  for (const notice of notices) {
    const file = notice.slice(0, -8);
    const code = await readFile(join(directory, file));
    const text = await readFile(join(directory, notice), 'utf8');
    const components = parseNotice(text);
    const bundle = { parent: manifest.name, version: manifest.version, file,
      sha256: createHash('sha256').update(code).digest('hex'),
      noticeSha256: createHash('sha256').update(text).digest('hex'), components };
    bundles.push(bundle);
    for (const component of components) packages.set(`${component.name}@${component.version}`, component);
  }
}
const components = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const findings = await queryAdvisories(components);
const report = { scanned: new Date().toISOString(), bundles, components, findings };
await writeFile(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
console.log(`${bundles.length} bundles, ${components.length} component versions, ${findings.length} advisory matches`);
for (const finding of findings) console.log(`${finding.name}@${finding.version}: ${finding.advisory}`);
if (findings.length) process.exitCode = 1;
