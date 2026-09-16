import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('viewer renders saved screenshots in a real loopback browser', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/viewer.ts')], { stdout: 'pipe', stderr: 'pipe' });
    const deadline = setTimeout(() => child.kill(), 20_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout).toContain('PASS: legacy and structured screenshots');
    } finally { clearTimeout(deadline); }
}, 25_000);
