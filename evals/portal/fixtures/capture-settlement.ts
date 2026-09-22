import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { captureEpisode, type EpisodeJob } from '../capture';
import { caseIds, loadSuite } from '../portal';

const root = mkdtempSync(join(tmpdir(), 'portal-settlement-'));
const casesPath = join(root, 'portals/ucsd/eval');
mkdirSync(casesPath, { recursive: true });
writeFileSync(join(casesPath, 'cases.mjs'), `
export const cases = ${JSON.stringify([...caseIds, 'send-message', 'book-followup'].map(id => ({ id, instruction: 'Submit once', extract: 'Read the result' })))};
export function scoreCase(test, before, after) {
    const wrongPatient = after.events.some(event => event.patientId !== 'alex');
    const unexpectedEvents = test.id === 'latest-result' ? after.events : [];
    const unexpectedChanges = wrongPatient ? ['other.messages'] : [];
    return { passed: after.events.length === 1 && !wrongPatient && !unexpectedEvents.length,
        outcome: after.events.length === 1, wrongPatient, unexpectedEvents, unexpectedChanges };
}`);

const done = () => ({ reasoning: 'Scripted capture settlement fixture', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Fixture' }] });
try {
    for (const mode of ['interrupted-write', 'interrupted-retrieval', 'deadline', 'unsettled', 'failed-response', 'unsettled-actor'] as const) {
        const events: { type: string; patientId: string }[] = [];
        let stateReads = 0, submissions = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let committed!: () => void;
        const commit = new Promise<void>(resolve => { committed = resolve; });
        const control = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
            stateReads++;
            return Response.json({ events });
        } });
        const web = createServer(async (request, response) => {
            if (request.url === '/api/action') {
                for await (const _chunk of request) { /* Receive the dispatched submission before cancelling. */ }
                submissions++;
                if (mode !== 'deadline') process.emit('SIGINT');
                if (mode === 'unsettled') await gate;
                else if (mode === 'failed-response') { committed(); request.socket.destroy(); return; }
                else await new Promise(resolve => setTimeout(resolve, mode === 'deadline' ? 4250 : 150));
                events.push({ type: 'message-sent', patientId: mode === 'interrupted-retrieval' ? 'other' : 'alex' });
                committed();
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ message: 'Sent' }));
                return;
            }
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end(`<h1>Welcome</h1><button style="position:absolute;left:20px;top:100px;width:150px;height:40px" onclick="fetch('/api/action',{method:'POST',body:'fixture'}).catch(()=>{})">Submit</button>`);
        });
        await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
        const suiteName = mode === 'interrupted-retrieval' ? 'retrieval' : 'writes';
        const suite = await loadSuite(root, 'ucsd', suiteName);
        const directory = join(root, mode);
        const job: EpisodeJob = { portal: 'ucsd', portalRoot: root, browserOrigin: `http://127.0.0.1:${(web.address() as AddressInfo).port}`, controlOrigin: control.url.origin,
            actor: { provider: 'anthropic', model: 'scripted-no-network' }, timeoutMs: mode === 'deadline' ? 4000 : 20_000,
            maxActions: 10, seed: 42, groundedControls: false, suite: suiteName, suiteHash: suite.hash,
            caseId: suiteName === 'retrieval' ? 'latest-result' : 'send-message', runId: 'fixture', loginPath: '/' };
        try {
            const report = await captureEpisode(job, directory, 'fixture-token', agent => {
                agent.models.setup = async () => {};
                let step = 0;
                agent.models.partialAct = async () => {
                    if (step++ === 0) return done();
                    if (mode === 'unsettled-actor') {
                        process.emit('SIGINT');
                        await gate;
                        return done();
                    }
                    if (step === 2) return { reasoning: 'Submit once', memory_updates: [], actions: [{ variant: 'mouse:click', x: 95, y: 120 }] };
                    await commit;
                    return done();
                };
            });
            assert.equal(report.status, mode === 'deadline' ? 'timeout' : 'interrupted', mode);
            assert.equal(report.passed, false, mode);
            assert.equal(submissions, mode === 'unsettled-actor' ? 0 : 1, 'no duplicate submissions');
            if (['unsettled', 'failed-response', 'unsettled-actor'].includes(mode)) {
                assert.deepEqual(report.verification, { status: 'unavailable', reason: mode === 'failed-response' ? 'submission_unsettled' : 'work_not_settled' }, mode);
                assert.equal(report.score, undefined, 'uncertain settlement must not publish a final score');
                assert.equal(report.writeAssessment, undefined);
                assert.equal(stateReads, 1, 'no premature final control read');
                assert.ok(report.elapsedMs < 15_000, 'drainage is bounded');
            } else {
                assert.equal(report.score?.outcome, true, 'final score must include the late commit');
                assert.equal(report.verification?.status, 'verified', mode);
                assert.equal(stateReads, 2);
                if (mode === 'interrupted-retrieval') {
                    assert.equal(report.score?.wrongPatient, true);
                    assert.deepEqual(report.score?.unexpectedChanges, ['other.messages']);
                    assert.equal(report.score?.unexpectedEvents.length, 1);
                }
            }
            release();
            if (mode === 'unsettled') { await commit; assert.equal(events.length, 1, 'server may commit after unavailable verification'); }
            assert.equal(report.actionCount, mode === 'unsettled-actor' ? 1 : 2, 'late model output dispatches no further action');
            const saved = JSON.parse(readFileSync(join(directory, 'episode.json'), 'utf8'));
            assert.deepEqual(saved.score, report.score);
            assert.deepEqual(saved.verification, report.verification);
            console.log(`PASS: ${mode}`);
        } finally { release(); web.closeAllConnections(); await new Promise<void>(resolve => web.close(() => resolve())); control.stop(true); }
    }
    console.log('PASS: capture waits for submissions or preserves uncertainty');
} finally { rmSync(root, { recursive: true, force: true }); }
