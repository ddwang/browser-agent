import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { caseIds, loadSuite, writeCaseIds } from './portal';

async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, BASETEN_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', SIM_CONTROL_TOKEN: '' } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
}

test('capture dry-run reuses the six cases without credentials or network calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'portal-cli-'));
    try {
        const path = join(root, 'portals/ucsd/eval'); mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'cases.mjs'), `export const cases = ${JSON.stringify([...caseIds, 'send-message', 'book-followup'].map(id => ({ id, instruction: 'Visible fixture task', extract: 'Fixture extraction' })))}; export const scoreCase = () => ({ passed:false });`);
        const result = await cli(['capture', '--portal-root', root, '--out', join(root, 'out'), '--dry-run']);
        expect(result.code).toBe(0);
        const manifest = JSON.parse(result.stdout);
        expect(manifest.episodes).toEqual(caseIds);
        expect(manifest.browserOrigin).toBe('http://127.0.0.1:4312');
        expect(manifest.actor.reasoningEffort).toBe('high');
        expect(manifest.groundedControls).toBe(false);
        expect(manifest.suite).toBe('retrieval');
        const writes = await cli(['capture', '--portal-root', root, '--out', join(root, 'writes'), '--suite', 'writes', '--dry-run']);
        expect(writes.code).toBe(0);
        expect(JSON.parse(writes.stdout).episodes).toEqual(writeCaseIds);
        const invalid = await cli(['capture', '--portal-root', root, '--out', join(root, 'out'), '--case', 'send-message', '--dry-run']);
        expect(invalid.code).toBe(1); expect(invalid.stderr).toContain('Unknown retrieval case');
        const remote = await cli(['capture', '--portal-root', root, '--out', join(root, 'out'), '--browser-url', 'https://real.example', '--dry-run']);
        expect(remote.code).toBe(1); expect(remote.stderr).toContain('loopback');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('holdout exposure is rejected before loading fixtures or opening browsers', async () => {
    const result = await cli(['capture', '--portal-root', '/nonexistent', '--out', '/nonexistent', '--portal', 'kaiser-permanente', '--dry-run']);
    expect(result.code).toBe(1); expect(result.stderr).toContain('held out');
    const writes = await cli(['capture', '--portal-root', '/nonexistent', '--out', '/nonexistent', '--portal', 'kaiser-permanente', '--suite', 'writes', '--dry-run']);
    expect(writes.code).toBe(1); expect(writes.stderr).toContain('development-only');
});

test('booking scorer reads time from the committed visit, not the event timestamp or expected task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'portal-booking-'));
    try {
        const path = join(root, 'portals/ucsd/eval'); mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'cases.mjs'), `export const cases = [{ id:'send-message', instruction:'Send' }, { id:'book-followup', instruction:'Book' }];
            export const scoreCase = (test, before, after) => ({ passed: test.id === 'book-followup' && after.events[0].time === '10:30 AM' });`);
        const suite = await loadSuite(root, 'ucsd', 'writes');
        const test = suite.cases.find(test => test.id === 'book-followup-lost-confirmation')!;
        const after = { patients: [{ id: 'patient', visits: [{ id: 'visit', time: '10:30 AM' }] }],
            events: [{ type: 'appointment-booked', patientId: 'patient', id: 'visit', time: '2026-01-01T12:00:00Z' }] };
        expect(suite.scoreCase(test, {}, after, undefined).passed).toBe(true);
        expect(after.events[0].time).toBe('2026-01-01T12:00:00Z');
        after.patients[0].visits[0].time = '9:00 AM';
        expect(suite.scoreCase(test, {}, after, undefined).passed).toBe(false);
        after.patients[0].visits = [];
        expect(suite.scoreCase(test, {}, after, undefined).passed).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('development screenshots can be replayed after question changes, but holdout captures cannot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'portal-cli-'));
    try {
        const path = join(root, 'manifest.json');
        const manifest = { synthetic: true, portal: 'ucsd', protocolHash: 'earlier-questions', episodes: [...caseIds] };
        writeFileSync(path, JSON.stringify(manifest));
        const args = ['replay', root, '--out', join(root, 'out'), '--endpoint', 'https://model-fixture.api.baseten.co/deployment/pinned/predict'];
        const dev = await cli(args);
        expect(dev.code).toBe(1); expect(dev.stderr).toContain('Set BASETEN_API_KEY');
        writeFileSync(path, JSON.stringify({ ...manifest, suite: 'writes', episodes: writeCaseIds }));
        const writes = await cli(args);
        expect(writes.code).toBe(1); expect(writes.stderr).toContain('retrieval screens only');
        writeFileSync(path, JSON.stringify({ ...manifest, portal: 'kaiser-permanente' }));
        const holdout = await cli(args);
        expect(holdout.code).toBe(1); expect(holdout.stderr).toContain('Holdout capture protocol changed');
    } finally { rmSync(root, { recursive: true, force: true }); }
});
