import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeFilterLists } from './adblock';

test('filter list snapshots are identified by name and content hash', () => {
    const directory = mkdtempSync(join(tmpdir(), 'magnitude-filter-lists-'));
    try {
        mkdirSync(join(directory, 'other'));
        writeFileSync(join(directory, 'easylist.txt'), '##.ad\n');
        writeFileSync(join(directory, 'other', 'easylist.txt'), '##.banner\n');
        expect(describeFilterLists([join(directory, 'easylist.txt')])).toEqual([
            { name: 'easylist.txt', sha256: new Bun.CryptoHasher('sha256').update('##.ad\n').digest('hex') },
        ]);
        expect(() => describeFilterLists([join(directory, 'easylist.txt'), join(directory, 'other', 'easylist.txt')]))
            .toThrow('Filter list file names must be unique.');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('filter lists block requests and hide elements in every tab', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/adblock.ts')], {
        stdout: 'pipe', stderr: 'pipe',
    });
    const deadline = setTimeout(() => child.kill(), 60_000);
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ code, stderr, stdout: code === 0 ? undefined : stdout }).toEqual({ code: 0, stderr: '', stdout: undefined });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(3);
    } finally { clearTimeout(deadline); }
}, 65_000);
