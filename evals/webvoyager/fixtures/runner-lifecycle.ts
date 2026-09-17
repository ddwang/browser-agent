import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type ActOptions } from '../../../packages/magnitude-core/src/agent';
import { Observation } from '../../../packages/magnitude-core/src/memory/observation';
import { measureOperation, operationSleep } from '../../../packages/magnitude-core/src/common/operation';
import { emptyUsage, writeJson, type RunManifest, type TaskResult, type TaskProgress } from '../results';

let mode = 'success';
let trace: string[] = [];
let actOptions: ActOptions | undefined;
const directory = mkdtempSync(join(tmpdir(), 'magnitude-runner-lifecycle-'));
const plan = { reasoning: '', memory_updates: [], actions: [{ variant: 'answer', input: 'SECRET_TYPED_TEXT' }] };

class FixtureBrowserAgent extends Agent {
    browserAgentEvents = new EventEmitter();
    constructor({ agentOptions }: any) {
        const actions = mode === 'action-cancel' ? agentOptions.actions.map((action: any) => ({ ...action,
            resolver: async () => {
                trace.push('dispatched');
                setTimeout(() => process.emit('SIGTERM'), 5);
                await Bun.sleep(80);
                trace.push('resolver-returned');
            },
        })) : agentOptions.actions;
        super({ ...agentOptions, actions, connectors: [{ id: 'fixture',
            collectObservations: () => measureOperation('screenshot', async () => {
                await operationSleep(1);
                return [Observation.fromConnector('fixture', 'SECRET_PAGE')];
            }),
            onStop: async () => { trace.push('stop'); await Bun.sleep(10); },
        }] });
        this.models.setup = async () => {
            if (mode === 'startup') await Bun.sleep(250);
            trace.push('started');
        };
        this.models.partialAct = () => measureOperation('model', async () => {
            trace.push('model');
            if (mode === 'deadline') await Bun.sleep(250); // Deliberately ignores cancellation.
            if (mode === 'cancel') { setTimeout(() => process.emit('SIGTERM'), 5); await Bun.sleep(80); }
            if (mode === 'stuck') await new Promise(() => {});
            if (mode === 'heartbeat') await operationSleep(2200);
            trace.push('plan-returned');
            return plan;
        });
    }
    override async act(task: string | string[], options: ActOptions = {}) {
        actOptions = options;
        return super.act(task, options);
    }
}

mock.module('../../../packages/magnitude-core/src/agent/browserAgent', () => ({ BrowserAgent: FixtureBrowserAgent }));
mock.module('patchright', () => ({ chromium: { launchPersistentContext: async () => {
    if (mode === 'launch') await Bun.sleep(250);
    trace.push('browser');
    return { close: async () => { trace.push('context-closed'); } };
} } }));
const { runTaskWorker } = await import('../wv-runner');
const originalError = console.error;
const diagnostics: string[] = [];
console.error = (...args) => { diagnostics.push(args.join(' ')); };
try {
    for (mode of ['success', 'deadline', 'cancel', 'startup', 'launch', 'action-cancel', 'stuck', 'heartbeat']) {
        trace = []; actOptions = undefined;
        const runDir = join(directory, mode);
        const timeoutMs = ['deadline', 'startup', 'launch', 'stuck'].includes(mode) ? 100 : 10_000;
        const manifest: RunManifest = {
            createdAt: new Date().toISOString(), revision: 'fixture', dirty: false, sourceHash: 'fixture', judgeVersion: 3, workers: 1,
            actor: { provider: 'anthropic', model: 'fixture' }, judge: { provider: 'anthropic', model: 'fixture' },
            timeoutMs, judgeTimeoutMs: 1000, tasks: [{ id: 'Fixture--0', web_name: 'Fixture', web: 'https://fixture.invalid/SECRET_URL', ques: 'SECRET_PROMPT' }],
        };
        // CLI creates the directory and initial checkpoint before spawning a worker.
        mkdirSync(runDir);
        writeJson(join(runDir, 'manifest.json'), manifest);
        writeJson(join(runDir, 'Fixture--0.json'), { ...emptyUsage(), status: 'running', time: 0, actionCount: 0, memory: null });
        const listeners = process.listenerCount('SIGTERM');
        const started = Date.now();
        const execution = runTaskWorker(runDir, 'Fixture--0');
        if (mode === 'heartbeat') {
            await Bun.sleep(2100);
            const heartbeat: TaskProgress = await Bun.file(join(runDir, 'Fixture--0.status.json')).json();
            assert.equal(heartbeat.operation?.phase, 'model');
            assert.ok(heartbeat.operation!.timings.model!.totalMs > 1000);
            assert.equal(heartbeat.busy, true);
        }
        const code = await execution;
        const result: TaskResult = await Bun.file(join(runDir, 'Fixture--0.json')).json();
        const progress: TaskProgress = await Bun.file(join(runDir, 'Fixture--0.status.json')).json();
        assert.equal(process.listenerCount('SIGTERM'), listeners, 'worker removes its signal listeners');
        assert.equal(progress.phase, 'finished');
        assert.ok(trace.includes('context-closed'));
        if (mode === 'startup' || mode === 'launch') {
            assert.equal(result.status, 'timeout'); assert.equal(code, 1);
            assert.equal(actOptions, undefined); assert.ok(!trace.includes('model'));
            assert.equal(result.cleanup?.status, 'settled');
            if (mode === 'startup') assert.ok(trace.indexOf('stop') > trace.indexOf('started'));
        } else {
            assert.ok(actOptions!.signal instanceof AbortSignal);
            assert.ok(actOptions!.deadline! >= started + timeoutMs);
            assert.ok(actOptions!.deadline! < started + timeoutMs + 500);
            assert.equal(result.operation?.kind, 'act');
            assert.equal(result.operation?.timings.model?.count, 1);
            for (const phase of ['context', 'observations', 'screenshot'] as const) assert.ok(result.operation?.timings[phase]?.count! >= 1);
            assert.equal(progress.operation?.id, result.operation?.id);
            assert.ok(!JSON.stringify([result.operation, result.failureOperation]).includes('SECRET'));
            if (mode === 'success' || mode === 'heartbeat') {
                assert.equal(code, 0); assert.equal(result.status, 'completed'); assert.equal(result.actionCount, 1);
                assert.equal(result.operation?.outcome, 'succeeded');
                assert.equal(result.operation?.lastAction?.state, 'completed');
                assert.equal(result.operation?.timings.action?.count, 1);
                assert.equal(result.cleanup?.status, 'settled');
            } else {
                assert.equal(code, 1); assert.equal(result.actionCount, 0, 'no late action completion enters the saved audit');
                assert.equal(result.status, mode === 'cancel' || mode === 'action-cancel' ? 'cancelled' : 'timeout');
                assert.equal(result.operation?.outcome, result.status === 'cancelled' ? 'cancelled' : 'deadline');
                assert.equal(result.failureOperation?.status, 'draining');
                if (mode === 'stuck') {
                    assert.equal(result.operation?.status, 'draining'); assert.equal(progress.busy, true);
                    assert.equal(result.cleanup?.status, 'timed_out'); assert.equal(result.operation?.cancellationToDrainMs, undefined);
                } else {
                    assert.equal(result.operation?.status, 'finished'); assert.equal(progress.busy, false);
                    assert.ok(result.operation!.cancellationToDrainMs! >= 0);
                    assert.ok(result.operation!.cancellationToIdleMs! >= result.operation!.cancellationToDrainMs!);
                    assert.equal(result.cleanup?.status, 'settled');
                }
                if (mode === 'action-cancel') {
                    assert.equal(result.failureOperation?.lastAction?.state, 'started');
                    assert.equal(result.operation?.lastAction?.state, 'completed');
                }
            }
        }
        console.log(`PASS: runner ${mode}`);
    }
    assert.ok(diagnostics.some(message => message.includes('Operation deadline exceeded')));
    assert.ok(diagnostics.some(message => message.includes('Cleanup exceeded 5 seconds')));
    console.log('PASS: all cancellation checks');
} finally {
    console.error = originalError;
    rmSync(directory, { recursive: true, force: true });
}
