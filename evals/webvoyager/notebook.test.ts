import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('real agent notebook lifecycle and action accounting without model calls', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/notebook-agent.ts')], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
    });
    const deadline = setTimeout(() => child.kill(), 15_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(5);
    } finally { clearTimeout(deadline); }
}, 20_000);

test('both real provider adapters transport durable notes and parse notebook actions', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/notebook-provider.ts')], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
    });
    const deadline = setTimeout(() => child.kill(), 20_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(2);
    } finally { clearTimeout(deadline); }
}, 25_000);
