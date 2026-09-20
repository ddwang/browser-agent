import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('judge keeps actor instructions as historical data, not grading rules', async () => {
    // Isolate the native BAML client from unit-test module mocks.
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/judge-instructions.ts')], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout).toContain('PASS: judge separates actor instruction evidence');
    } finally { clearTimeout(timer); }
}, 25_000);
