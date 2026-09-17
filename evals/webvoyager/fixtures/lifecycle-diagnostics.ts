import assert from 'node:assert/strict';
import { z } from 'zod';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { AgentBusyError, OperationCancelledError } from '../../../packages/magnitude-core/src/agent/errors';
import { checkOperation, measureOperation, type OperationDiagnostics } from '../../../packages/magnitude-core/src/common/operation';

const llm = { provider: 'anthropic' as const, options: { model: 'fixture', apiKey: 'unused' } };
const deferred = () => Promise.withResolvers<void>();
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
const work = { variant: 'work', text: 'SECRET_TYPED_TEXT' };
const action = (resolver: Parameters<typeof createAction>[0]['resolver']) => createAction({
    name: 'work', schema: z.object({ text: z.string() }), resolver,
});

// Both overlap directions serialize; duplicates invoke hooks once. Idle includes queued work.
{
    const started = deferred(), startGate = deferred(), stopped = deferred(), stopGate = deferred();
    let starts = 0, stops = 0;
    const agent = new Agent({ llm, telemetry: false, connectors: [{ id: 'fixture',
        onStart: async () => { starts++; started.resolve(); await startGate.promise; },
        onStop: async () => { stops++; stopped.resolve(); await stopGate.promise; },
    }] });
    agent.models.setup = async () => {};
    const first = agent.start(), duplicate = agent.start();
    await started.promise;
    assert.equal(agent.lifecycle, 'starting');
    await assert.rejects(agent.act('startup is busy'), AgentBusyError);
    const stop = agent.stop(), duplicateStop = agent.stop();
    const restart = agent.start();
    let idle = false;
    void agent.whenIdle().then(() => { idle = true; });
    await tick(); assert.equal(stops, 0); assert.equal(agent.busy, true);
    startGate.resolve(); await Promise.all([first, duplicate]); await stopped.promise;
    assert.equal(agent.lifecycle, 'stopping'); assert.equal(starts, 1); assert.equal(idle, false);
    stopGate.resolve(); await Promise.all([stop, duplicateStop, restart, agent.whenIdle()]);
    assert.equal(starts, 2); assert.equal(stops, 1); assert.equal(agent.lifecycle, 'ready');
    assert.equal(agent.busy, false); assert.equal(idle, true);
    await agent.start(); assert.equal(starts, 2);
    await Promise.all([agent.stop(), agent.stop()]); await agent.stop(); assert.equal(stops, 2);
}

// A failed startup cleans up partial resources and does not poison future lifecycle requests.
{
    let starts = 0, stops = 0;
    const failure = new Error('startup failure');
    const agent = new Agent({ llm, telemetry: false, connectors: [{ id: 'fixture',
        onStart: async () => { if (++starts === 1) throw failure; },
        onStop: async () => { stops++; },
    }] });
    agent.models.setup = async () => {};
    await assert.rejects(agent.start(), error => error === failure);
    assert.equal(agent.lifecycle, 'stopped'); assert.equal(stops, 1); assert.equal(agent.busy, false);
    await agent.start(); assert.equal(agent.lifecycle, 'ready'); await agent.stop();
}

// One failed model must not release startup or allow cleanup before sibling initialization drains.
{
    const entered = deferred(), release = deferred();
    const failure = new Error('one model failed');
    let cleanups = 0;
    const agent = new Agent({ llm, telemetry: false, connectors: [{ id: 'fixture',
        onStop: async () => { cleanups++; },
    }] });
    // Keep the real MultiModelHarness.setup(), with deterministic per-model initialization.
    (agent.models as any).uniqueModels = [
        { setup: async () => { throw failure; } },
        { setup: async () => { entered.resolve(); await release.promise; } },
    ];
    const start = assert.rejects(agent.start(), error => error === failure);
    await entered.promise;
    const stop = agent.stop();
    await tick();
    assert.equal(agent.lifecycle, 'starting'); assert.equal(agent.busy, true); assert.equal(cleanups, 0);
    release.resolve(); await start; await stop; await agent.whenIdle();
    assert.equal(agent.lifecycle, 'stopped'); assert.equal(agent.busy, false); assert.equal(cleanups, 1);
}

// Stop returns after cleanup, but restart cannot race an uncooperative cancelled resolver.
{
    const entered = deferred(), release = deferred();
    const agent = new Agent({ llm, telemetry: false, actions: [action(async () => { entered.resolve(); await release.promise; })] });
    agent.models.setup = async () => {};
    const result = agent.exec(work); await entered.promise;
    const rejected = assert.rejects(result, OperationCancelledError);
    await agent.stop(); await rejected;
    assert.equal(agent.busy, true);
    await assert.rejects(agent.start(), AgentBusyError);
    release.resolve(); await agent.whenIdle(); await agent.start(); await agent.stop();
}

// Cancellation snapshots retain dispatch uncertainty; later diagnostics report drain and idle separately.
{
    const entered = deferred(), release = deferred(), stopEntered = deferred(), cleanup = deferred(), drained = deferred();
    const controller = new AbortController();
    const snapshots: OperationDiagnostics[] = [];
    const agent = new Agent({ llm, telemetry: false,
        actions: [action(async () => { entered.resolve(); await release.promise; })],
        connectors: [{ id: 'fixture', onStop: async () => { checkOperation(); stopEntered.resolve(); await cleanup.promise; } }],
    });
    agent.events.on('operation', snapshot => {
        snapshots.push(snapshot);
        if (snapshot.status === 'finished') drained.resolve();
    });
    const result = agent.exec(work, undefined, { signal: controller.signal }); await entered.promise;
    controller.abort('SECRET_ABORT_REASON');
    let cancellation!: OperationCancelledError;
    await assert.rejects(result, error => { cancellation = error as OperationCancelledError; return error instanceof OperationCancelledError; });
    assert.equal(cancellation.operation?.status, 'draining');
    assert.equal(cancellation.operation?.lastAction?.state, 'started');
    const frozenSnapshot = JSON.stringify(cancellation.operation);
    await assert.rejects(agent.exec(work), error => error instanceof AgentBusyError && error.operation?.id === cancellation.operation?.id);
    const stop = agent.stop(); await stopEntered.promise;
    release.resolve(); await drained.promise;
    assert.equal(agent.busy, true); assert.equal(agent.operation?.cancellationToIdleMs, undefined);
    cleanup.resolve(); await stop; await agent.whenIdle();
    assert.equal(agent.operation?.outcome, 'cancelled');
    assert.equal(agent.operation?.lastAction?.state, 'completed');
    assert.ok(agent.operation!.cancellationToIdleMs! >= agent.operation!.cancellationToDrainMs!);
    assert.ok(agent.operation?.timings.action?.count === 1);
    assert.equal(new Set(snapshots.map(snapshot => snapshot.id)).size, 1);
    assert.equal(JSON.stringify(cancellation.operation), frozenSnapshot);
    assert.ok(!JSON.stringify(snapshots).includes('SECRET'));
}

// Hooks run before dispatch. Abort from a diagnostic callback also prevents dispatch.
for (const boundary of ['hook', 'action-phase'] as const) {
    const gate = deferred(), entered = deferred(), controller = new AbortController();
    let calls = 0;
    const agent = new Agent({ llm, telemetry: false, actions: [action(async () => { calls++; })],
        connectors: boundary === 'hook' ? [{ id: 'fixture', beforeAction: async () => { entered.resolve(); await gate.promise; } }] : [],
    });
    if (boundary === 'action-phase') agent.events.on('operation', snapshot => {
        if (snapshot.phase === 'action') controller.abort();
    });
    const result = agent.exec(work, undefined, { signal: controller.signal });
    if (boundary === 'hook') { await entered.promise; controller.abort(); }
    await assert.rejects(result, error => error instanceof OperationCancelledError && error.operation?.lastAction?.state === 'pending');
    gate.resolve(); await agent.whenIdle(); assert.equal(calls, 0);
}

// Failure metadata preserves identity without exposing error messages or input, including frozen errors.
for (const frozen of [false, true]) {
    const failure = new Error('SECRET_ERROR https://private.example/SECRET_URL');
    if (frozen) Object.freeze(failure);
    const agent = new Agent({ llm, telemetry: false, actions: [action(async () => { throw failure; })] });
    await assert.rejects(agent.exec(work), error => error === failure);
    assert.equal(agent.operation?.outcome, 'failed'); assert.equal(agent.operation?.lastAction?.state, 'failed');
    assert.ok(!JSON.stringify(agent.operation).includes('SECRET'));
    assert.equal('operation' in failure, !frozen);
}

// New diagnostics cannot make synchronous listener failures fail a task. Snapshot mutation is isolated.
{
    const agent = new Agent({ llm, telemetry: false, actions: [action(async () => {})] });
    agent.events.on('operation', () => { throw new Error('SECRET_LISTENER'); });
    await agent.exec(work);
    const snapshot = agent.operation!;
    snapshot.lastAction!.name = 'mutated'; snapshot.timings.action!.count = 999;
    assert.equal(agent.operation?.lastAction?.name, 'work'); assert.equal(agent.operation?.timings.action?.count, 1);
    agent.events.removeAllListeners('operation');
    const firstId = agent.operation?.id; await agent.exec(work); assert.notEqual(agent.operation?.id, firstId);
}

// stop() called from a resolver must run connector cleanup outside the aborted operation context.
{
    let cleaned = false;
    const agent = new Agent({ llm, telemetry: false,
        actions: [action(async ({ agent }) => { await agent.stop(); })],
        connectors: [{ id: 'fixture', onStop: async () => { checkOperation(); cleaned = true; } }],
    });
    await assert.rejects(agent.exec(work), OperationCancelledError); await agent.whenIdle(); assert.equal(cleaned, true);
}

// A diagnostic idle callback can start new work without resolving its idle promise early.
{
    const controller = new AbortController(), release = deferred(), entered = deferred();
    const agent = new Agent({ llm, telemetry: false, actions: [action(async () => { entered.resolve(); await release.promise; })] });
    let next: Promise<unknown> | undefined;
    agent.events.on('operation', snapshot => {
        if (snapshot.cancellationToIdleMs !== undefined && !next) next = agent.exec(work);
    });
    controller.abort(); await assert.rejects(agent.exec(work, undefined, { signal: controller.signal }), OperationCancelledError);
    await entered.promise;
    let idle = false; void agent.whenIdle().then(() => { idle = true; });
    await tick(); assert.equal(idle, false); release.resolve(); await next; await agent.whenIdle();
    assert.equal(agent.busy, false);
}

// Model/context timings come from execution, not task strings; operation kinds remain distinct.
{
    const agent = new Agent({ llm, telemetry: false });
    agent.models.query = async () => measureOperation('model', async () => 'answer');
    await agent.query('SECRET_PROMPT', z.string());
    assert.equal(agent.operation?.kind, 'query');
    for (const phase of ['context', 'observations', 'model'] as const) assert.equal(agent.operation?.timings[phase]?.count, 1);
    assert.ok(!JSON.stringify(agent.operation).includes('SECRET'));
}

// Resuming at the new phase boundary must not leave a newly-created pause promise hanging.
{
    const agent = new Agent({ llm, telemetry: false });
    agent.models.partialAct = async () => ({ reasoning: '', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'done' }] });
    agent.events.on('operation', snapshot => { if (snapshot.phase === 'paused') agent.resume(); });
    agent.pause(); await agent.act('resume from diagnostics');
    assert.equal(agent.paused, false); assert.equal(agent.busy, false);
    assert.equal(agent.operation?.timings.paused?.count, 1);
}
console.log('PASS: all cancellation checks');
