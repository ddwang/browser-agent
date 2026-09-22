import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const fixture of [
    { name: 'real Chromium oracle respects visibility and the clinical iframe', file: 'oracle.ts', message: '16 browser oracle cases' },
    { name: 'capture extraction retains scalar fields through the real BAML transport', file: 'capture-extraction.ts', message: 'extraction preserves named scalar fields', baml: true },
    { name: 'write routing preserves commits, validation failures, and duplicate attempts in Chromium', file: 'write-routing.ts', message: 'write routing preserves server truth' },
]) test(fixture.name, async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', fixture.file)], {
        stdout: 'pipe', stderr: 'pipe', ...(fixture.baml ? { env: { ...process.env, BAML_LOG: 'off' } } : {}),
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr, stdout: code ? stdout : undefined }).toEqual({ code: 0, stderr: '', stdout: undefined });
        expect(stdout).toContain(fixture.message);
    } finally { clearTimeout(timer); }
}, 35_000);
