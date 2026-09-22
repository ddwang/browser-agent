// Optional wiring test against a trusted MySimChart checkout. No model requests.
// Starts an isolated UCSD instance on ephemeral ports; never consumes the Kaiser holdout.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { captureEpisode, type EpisodeJob } from '../capture';
import { checkSimulator, controlClient, loadSuite, writeCaseIds } from '../portal';

const root = resolve(process.argv[2]);
const output = mkdtempSync(join(resolve(process.argv[3]), 'portal-djev-smoke-'));
const { createSimulator } = await import(pathToFileURL(join(root, 'portals/ucsd/src/server.mjs')).href);
const app = createSimulator();
const serve = async (server: Server) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const browserOrigin = await serve(app.web), controlOrigin = await serve(app.control);
const control = controlClient(controlOrigin, app.token);
const suite = await loadSuite(root, 'ucsd');
const writes = await loadSuite(root, 'ucsd', 'writes');
const done = () => ({ reasoning: 'Scripted plumbing fixture, not a model benchmark', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Fixture' }] });
try {
    await checkSimulator(browserOrigin, 'ucsd', control);
    for (const mode of ['latest-result', 'empty-results', 'interrupted', ...writeCaseIds, 'wrong-recipient', 'validation-error', 'duplicate-submit'] as const) {
        const isWrite = !['latest-result', 'empty-results', 'interrupted'].includes(mode);
        const negative = ['wrong-recipient', 'validation-error', 'duplicate-submit'].includes(mode);
        const run = await control('/runs', 'POST', { seed: 42, scenario: mode === 'empty-results' ? 'empty' : 'baseline', require2fa: true });
        try {
            const job: EpisodeJob = { portal: 'ucsd', portalRoot: root, browserOrigin, controlOrigin,
                actor: { provider: 'anthropic', model: 'scripted-fixture-no-network' }, timeoutMs: 60_000, maxActions: 10,
                seed: 42, groundedControls: false, suite: isWrite ? 'writes' : 'retrieval', suiteHash: isWrite ? writes.hash : suite.hash,
                caseId: negative ? 'send-message' : mode === 'interrupted' ? 'latest-result' : mode,
                runId: run.id, loginPath: run.loginPath };
            const report = await captureEpisode(job, join(output, mode), app.token, agent => {
                agent.models.setup = async () => {};
                let step = 0;
                agent.models.partialAct = async () => {
                    if (mode === 'interrupted') {
                        process.emit('SIGINT');
                        await new Promise(resolve => setTimeout(resolve, 100));
                        return done();
                    }
                    if (step++ === 0) {
                        await agent.page.locator('input[name="username"]').fill('alex.morgan');
                        await agent.page.locator('input[name="password"]').fill('synthetic-only');
                        await agent.page.getByRole('button', { name: 'Sign In', exact: true }).click();
                        await agent.page.locator('input[name="code"]').fill('246810');
                        await agent.page.getByRole('button', { name: 'Verify', exact: true }).click();
                        await agent.page.getByRole('heading', { name: 'Welcome, Alex!' }).waitFor();
                        return done();
                    }
                    if (isWrite) {
                        if (mode.startsWith('book-followup')) {
                            await agent.page.goto(new URL('/UCSD/Scheduling', browserOrigin).href);
                            await agent.page.getByRole('button', { name: /Specialty Follow-up/ }).click();
                            await agent.page.getByRole('button', { name: /Dr. Elena Brooks/ }).click();
                            await agent.page.locator('[data-action="schedule-time"][data-date="2026-10-21"][data-time="10:30 AM"]').click();
                            await agent.page.getByRole('button', { name: 'Schedule appointment', exact: true }).click();
                        } else {
                            for (let attempt = 0; attempt < (mode === 'duplicate-submit' ? 2 : 1); attempt++) {
                                await agent.page.goto(new URL('/UCSD/AskQuestion', browserOrigin).href);
                                await agent.page.getByRole('button', { name: /Send a message to your doctor/ }).click();
                                const select = agent.page.locator('select[name="providerId"]');
                                const recipient = mode === 'wrong-recipient'
                                    ? await select.locator('option[value]:not([value=""]):not([value="genetics"])').first().getAttribute('value') : 'genetics';
                                await select.selectOption(recipient!);
                                await agent.page.getByLabel('Subject', { exact: true }).fill('Symptom log');
                                if (mode !== 'validation-error') await agent.page.getByLabel('Message', { exact: true }).fill('I will bring my symptom log to the next visit.');
                                await agent.page.getByRole('button', { name: 'Send', exact: true }).click();
                                if (!mode.endsWith('-lost-confirmation') && mode !== 'validation-error') {
                                    await agent.page.getByText('Your message has been sent.', { exact: true }).waitFor();
                                }
                            }
                        }
                        let outcome = mode === 'validation-error' ? 'not_completed' : 'confirmed';
                        if (mode.endsWith('-lost-confirmation')) {
                            await agent.page.getByText('The submission response is unavailable. The outcome could not be confirmed.', { exact: true }).waitFor();
                            await agent.page.reload();
                            await agent.page.getByText('Your information is temporarily unavailable.', { exact: true }).waitFor();
                            outcome = 'unknown';
                        } else if (mode.startsWith('book-followup')) {
                            await agent.page.getByText('Your appointment is scheduled.', { exact: true }).waitFor();
                        }
                        return { reasoning: 'Scripted write plumbing, not a model benchmark', memory_updates: [], actions: [{
                            variant: 'portal:report', outcome, evidence: outcome === 'unknown' ? 'Submission and subsequent verification unavailable'
                                : outcome === 'not_completed' ? 'Required message field is empty' : 'Portal showed confirmation',
                        }] };
                    }
                    if (step === 2) {
                        await agent.page.getByRole('link', { name: 'Test Results', exact: true }).click();
                        if (mode === 'empty-results') {
                            await agent.page.getByText('No results found', { exact: true }).waitFor();
                            return done();
                        }
                        await agent.page.locator('.result-row').first().waitFor();
                        return { reasoning: 'Observe list', memory_updates: [], actions: [{ variant: 'wait', seconds: 0 }] };
                    }
                    const first = agent.page.locator('.result-row').first();
                    const destination = new URL((await first.getAttribute('href'))!, agent.page.url()).href;
                    await first.click();
                    await agent.page.waitForURL(destination);
                    await agent.page.locator('.lab-component').first().waitFor();
                    return done();
                };
                // Test-only extraction stub reads the displayed DOM, not the control answer key.
                agent.models.extract = async () => mode === 'empty-results' ? { hasResults: false } : {
                    patientName: 'Alex Morgan', collectionDate: '2026-09-10',
                    creatinine: Number((await agent.page.locator('.lab-value').first().innerText()).split(/\s/)[0]), unit: 'mg/dL',
                };
            });
            assert.equal(report.status, mode === 'interrupted' ? 'interrupted' : 'completed');
            assert.equal(report.passed, mode !== 'interrupted' && !negative);
            assert.deepEqual(report.cleanupErrors, []);
            assert.equal(report.score?.wrongPatient, false);
            if (!negative) assert.deepEqual(report.score?.unexpectedChanges, []);
            assert.ok(report.samples.some(sample => sample.oracle.label === 'login'));
            if (mode === 'interrupted') assert.equal(report.actionCount, 0, 'late model response dispatches no action');
            else if (isWrite) {
                assert.equal(report.write?.attempts, mode === 'validation-error' ? 0 : mode === 'duplicate-submit' ? 2 : 1);
                if (mode.endsWith('-lost-confirmation')) assert.ok(report.write!.blockedVerificationReads > 0);
                if (negative) assert.equal(report.score?.passed, false);
            } else assert.ok(report.samples.some(sample => sample.oracle.label === (mode === 'empty-results' ? 'empty_results' : 'result_detail')));
            console.log(`PASS scripted wiring: ${mode}, ${report.samples.length} saved screenshots`);
        } finally { await control(`/runs/${run.id}`, 'DELETE'); }
    }
    console.log(`Artifacts: ${output}\nNo Djev/actor inference; no holdout evaluation.`);
} finally {
    await Promise.all([app.web, app.control].map((server: Server) => new Promise<void>(resolve => server.close(() => resolve()))));
}
