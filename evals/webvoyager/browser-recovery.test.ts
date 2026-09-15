import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('real browser recovery fixtures (isolated from Bun test native-runtime hooks)', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/browser-recovery.ts')], {
        stdout: 'pipe', stderr: 'pipe',
    });
    const deadline = setTimeout(() => child.kill(), 90_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(14);
    } finally { clearTimeout(deadline); }
}, 95_000);
