import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('real BAML planner and usage accounting against a loopback provider', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/model-harness.ts')], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
    });
    const deadline = setTimeout(() => child.kill(), 30_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(14);
    } finally { clearTimeout(deadline); }
}, 35_000);

test('real BAML OpenAI transport, planner and usage accounting against a loopback provider', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/openai-model-harness.ts')], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
    });
    const deadline = setTimeout(() => child.kill(), 45_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(18);
    } finally { clearTimeout(deadline); }
}, 50_000);
