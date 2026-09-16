import { expect, test } from 'bun:test';
import { join } from 'node:path';

// Isolate the native BAML client from unit tests that mock generated modules.
for (const fixture of ['cancellation-agent', 'cancellation-model']) {
    test(fixture, async () => {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, `fixtures/${fixture}.ts`)], {
            stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
        });
        const timer = setTimeout(() => child.kill(), 25_000);
        try {
            const [stdout, stderr, code] = await Promise.all([
                new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
            ]);
            expect({ code, stderr, stdout: code ? stdout : '' }).toEqual({ code: 0, stderr: '', stdout: '' });
            expect(stdout).toContain('PASS: all cancellation checks');
        } finally { clearTimeout(timer); }
    }, 30_000);
}
