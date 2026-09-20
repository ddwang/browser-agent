import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('real agent notebook lifecycle and action accounting without model calls', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/notebook-agent.ts')], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
    });
    const deadline = setTimeout(() => child.kill(), 15_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout.match(/^PASS:/gm)).toHaveLength(15);
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

for (const provider of ['anthropic', 'baseten']) test(`${provider} live schema probe isolates query and planner contexts`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'magnitude-probe-context-'));
    const output = join(directory, 'probe.json');
    const child = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, 'fixtures/probe-context.ts'),
        join(import.meta.dir, 'fixtures/structured-output-live.ts'), output, provider], {
        cwd: directory, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, BAML_LOG: 'off', ANTHROPIC_API_KEY: 'fixture', BASETEN_API_KEY: 'fixture' },
    });
    const deadline = setTimeout(() => child.kill(), 15_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        const expectedChecks = provider === 'baseten' ? 4 : 3;
        expect(JSON.parse(stdout).passed).toBe(expectedChecks);
        const result = JSON.parse(readFileSync(output, 'utf8'));
        expect(result.checks).toHaveLength(expectedChecks);
        expect(result.failure).toBeUndefined();
    } finally {
        clearTimeout(deadline);
        rmSync(directory, { recursive: true, force: true });
    }
}, 20_000);
