import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { BrowserAgent } from '../../packages/magnitude-core/src/agent/browserAgent';
import { BrowserConnector } from '../../packages/magnitude-core/src/connectors/browserConnector';
import { createAction } from '../../packages/magnitude-core/src/actions';
import { taskActions } from '../../packages/magnitude-core/src/actions/taskActions';
import { Image } from '../../packages/magnitude-core/src/memory/image';
import type { LLMClient } from '../../packages/magnitude-core/src/ai/types';
import type { OperationDiagnostics } from '../../packages/magnitude-core/src/common/operation';
import { addUsage, emptyUsage, writeJson, type ModelConfig } from '../webvoyager/results';
import { controlClient, loadSuite, portals, retrievalAnswerSchema, type PortalId, type Score, type SuiteName } from './portal';
import { readOracle, stableOracle, type Oracle } from './oracle';
import { assessWrite, routeWrite, writeAnswerSchema, writeInstructions, type WriteEvidence } from './writes';

export interface CaptureConfig {
    portal: PortalId; portalRoot: string; browserOrigin: string; controlOrigin: string;
    actor: ModelConfig; timeoutMs: number; maxActions: number; seed: number;
    groundedControls: boolean; suiteHash: string;
    suite: SuiteName;
}
export interface EpisodeJob extends CaptureConfig { caseId: string; runId: string; loginPath: string; }
export interface Sample { image: string; phase: 'login' | 'task'; oracle: Oracle; elapsedMs: number; }
export interface Episode {
    caseId: string; status: 'running' | 'completed' | 'error' | 'timeout' | 'interrupted'; passed: boolean;
    elapsedMs: number; captureOverheadMs: number; actionCount: number; plannerCalls: number;
    usage: ReturnType<typeof emptyUsage>; operations: OperationDiagnostics[]; samples: Sample[];
    score?: Score; answer?: unknown; error?: string; cleanupErrors: string[];
    write?: WriteEvidence;
    writeAssessment?: ReturnType<typeof assessWrite>;
}

export async function captureEpisode(job: EpisodeJob, directory: string, token: string, configure?: (agent: BrowserAgent) => void) {
    const control = controlClient(job.controlOrigin, token);
    const suite = await loadSuite(job.portalRoot, job.portal, job.suite);
    if (suite.hash !== job.suiteHash) throw new Error('Simulator cases changed after manifest creation');
    const test = suite.cases.find(test => test.id === job.caseId);
    if (!test) throw new Error('Unknown portal case');
    const login = new URL(job.loginPath, job.browserOrigin);
    if (login.origin !== job.browserOrigin) throw new Error('Simulator login redirected outside the allowed browser origin');
    mkdirSync(directory, { recursive: true });
    const started = performance.now();
    const deadline = Date.now() + job.timeoutMs;
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Capture interrupted'));
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    const timer = setTimeout(() => controller.abort(new Error('Capture deadline')), job.timeoutMs);
    const report: Episode = { caseId: job.caseId, status: 'running', passed: false, elapsedMs: 0, captureOverheadMs: 0,
        actionCount: 0, plannerCalls: 0, usage: emptyUsage(), operations: [], samples: [], cleanupErrors: [] };
    if (job.suite === 'writes') report.write = { attempts: 0, successfulResponses: 0, lostResponses: 0, blockedVerificationReads: 0, transportErrors: 0 };
    const loseConfirmation = job.caseId.endsWith('-lost-confirmation');
    const save = () => { report.elapsedMs = performance.now() - started; writeJson(join(directory, 'episode.json'), report); };
    save();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let agent: BrowserAgent | undefined;
    let before: unknown;
    let phase: Sample['phase'] = 'login';
    try {
        before = await control(`/runs/${job.runId}/state`);
        browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false });
        const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
        // Restrict browser network requests to the synthetic web service, excluding its control API.
        await context.route('**/*', route => {
            if (new URL(route.request().url()).origin !== job.browserOrigin) return route.abort();
            return report.write ? routeWrite(route, report.write, loseConfirmation) : route.continue();
        });
        const { provider, ...options } = job.actor;
        agent = new BrowserAgent({
            browserOptions: { browser: { context }, url: login.href, groundedControls: job.groundedControls,
                recovery: { noProgress: true }, visuals: { animateCursor: false } },
            agentOptions: { llm: { provider, options } as LLMClient, telemetry: false, maxActions: job.maxActions,
                ...(report.write ? { actions: [...taskActions, createAction({
                    name: 'portal:report', description: 'Finish the write task with an evidence-based outcome. Use unknown when a submission cannot be verified.',
                    schema: writeAnswerSchema,
                    resolver: async ({ input, agent }) => { report.answer = input; agent.queueDone(); },
                })] } : {}),
            },
        });
        const connector = agent.require(BrowserConnector);
        const collect = connector.collectObservations.bind(connector);
        connector.collectObservations = async () => {
            let overhead = performance.now();
            // A navigation during an oracle read must not fail or label the actor's observation.
            const unknown = (): Oracle => ({ label: null, url: agent!.page.url(), resultId: null, evidence: 'oracle unavailable' });
            const before = await readOracle(agent!.page).catch(unknown);
            report.captureOverheadMs += performance.now() - overhead;
            const observations = await collect();
            overhead = performance.now();
            const after = await readOracle(agent!.page).catch(unknown);
            const observation = observations.find(item => item.retention?.type === 'screenshot');
            const screenshot = (observation?.content as { screenshot?: Image } | undefined)?.screenshot;
            if (screenshot instanceof Image) {
                const image = `${String(report.samples.length).padStart(4, '0')}.png`;
                const stored = await screenshot.toJson();
                if (stored.format !== 'png') throw new Error('Expected the existing PNG observation');
                writeFileSync(join(directory, image), Buffer.from(stored.base64, 'base64'));
                report.samples.push({ image, phase, oracle: stableOracle(before, after), elapsedMs: performance.now() - started });
            }
            report.captureOverheadMs += performance.now() - overhead;
            save();
            return observations;
        };
        agent.events.on('actionStarted', () => { report.actionCount++; });
        agent.events.on('planningStarted', () => { report.plannerCalls++; });
        agent.events.on('tokensUsed', usage => addUsage(report.usage, usage));
        agent.events.on('operation', operation => {
            const index = report.operations.findIndex(item => item.id === operation.id);
            if (index < 0) report.operations.push(operation); else report.operations[index] = operation;
        });
        configure?.(agent);
        await agent.start();
        controller.signal.throwIfAborted();
        const controls = { signal: controller.signal, deadline };
        const username = portals[job.portal].username;
        const boundary = `Use only the synthetic portal at ${job.browserOrigin}. Use the visible browser UI, not APIs or developer tools. `;
        const readOnly = 'Never change records, send messages, request renewals, book appointments, or submit downloads. ';
        const credentials = `Use username ${username}, password synthetic-only, and verification code 246810. `;
        await agent.act(boundary + readOnly + credentials + 'Sign in and stop when the home page is visible.', controls);
        phase = 'task';
        report.answer = undefined;
        await agent.act(boundary + (report.write ? writeInstructions : readOnly) + credentials
            + 'If your session expires, sign in again and resume. If content fails to load, use Try again. ' + test.instruction, controls);
        if (!report.write) report.answer = await agent.extract(test.extract!, retrievalAnswerSchema(job.portal, job.caseId), controls);
        report.status = 'completed';
    } catch (error) {
        report.status = Date.now() >= deadline ? 'timeout' : controller.signal.aborted ? 'interrupted' : 'error';
        report.error = error instanceof Error ? error.name : 'Unknown error';
    } finally {
        clearTimeout(timer);
        // Failed attempts also need mutation and wrong-patient checks.
        if (before) try {
            const after = await control(`/runs/${job.runId}/state`);
            report.score = suite.scoreCase(test, before, after, report.answer);
            if (report.write) report.writeAssessment = assessWrite(report.score, report.write, report.answer, loseConfirmation);
            report.passed = report.status === 'completed' && (report.writeAssessment?.passed ?? report.score.passed);
        } catch { report.error ??= 'Outcome verification unavailable'; report.passed = false; }
        save(); // Preserve the outcome even if cleanup hangs or rejects.
        try { await agent?.stop(); } catch { report.cleanupErrors.push('agent_stop'); }
        try { await browser?.close(); } catch { report.cleanupErrors.push('browser_close'); }
        process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
        save();
    }
    return report;
}

if (import.meta.main) {
    const directory = process.argv[2];
    const job: EpisodeJob = JSON.parse(readFileSync(join(directory, 'job.json'), 'utf8'));
    await captureEpisode(job, directory, process.env.SIM_CONTROL_TOKEN ?? '');
}
