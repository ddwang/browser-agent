import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('actual provider attempts survive retries, cancellation, and absent usage without exposing payloads', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/provider-diagnostics.ts')], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ code, stderr, stdout: code ? stdout : '' }).toEqual({ code: 0, stderr: '', stdout: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(12);
    } finally { clearTimeout(timer); }
}, 35_000);
