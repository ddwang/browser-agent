import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('extraction reads visible content without changing the browser', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/extraction.ts')], {
        stdout: 'pipe', stderr: 'pipe',
    });
    const deadline = setTimeout(() => child.kill(), 60_000);
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(9);
    } finally { clearTimeout(deadline); }
}, 65_000);
