import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('planner budgets abort native requests, bound retries, and correlate lifecycle diagnostics', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/planner-timeout.ts')], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off', MAGNITUDE_LOG_LEVEL: 'silent' },
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ code, stderr, stdout: code ? stdout : '' }).toEqual({ code: 0, stderr: '', stdout: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(42);
    } finally { clearTimeout(timer); }
}, 35_000);
