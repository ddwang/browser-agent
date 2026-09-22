import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('grounded controls use current nodes and preserve execution guarantees', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/grounded-controls.ts')], {
        stdout: 'pipe', stderr: 'pipe',
    });
    const deadline = setTimeout(() => child.kill(), 120_000);
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ code, stderr, stdout: code === 0 ? undefined : stdout }).toEqual({ code: 0, stderr: '', stdout: undefined });
        expect(stdout.match(/^PASS:/gm)?.length).toBe(34);
    } finally { clearTimeout(deadline); }
}, 125_000);
