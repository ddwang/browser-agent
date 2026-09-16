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
        expect(stdout.match(/^PASS:/gm)).toHaveLength(23);
        expect(stdout).toContain('$.memory_updates[0].sources: too_big');
        expect(stdout).not.toContain('UNTRUSTED_PLAN_VALUE');
    } finally { clearTimeout(deadline); }
}, 35_000);

for (const provider of ['openai', 'baseten']) test(`real BAML ${provider} transport, planner and usage accounting against a loopback provider`, async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/chat-completions-model-harness.ts'), provider], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
    });
    const deadline = setTimeout(() => child.kill(), 45_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(provider === 'openai' ? 25 : 27);
        expect(stdout).toContain('$.actions[0].x: invalid_type');
        expect(stdout).not.toContain('UNTRUSTED_PLAN_VALUE');
    } finally { clearTimeout(deadline); }
}, 50_000);
