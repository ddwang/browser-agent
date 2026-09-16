import assert from 'node:assert/strict';
import { z } from 'zod';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { BrowserAgent } from '../../../packages/magnitude-core/src/agent/browserAgent';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { AgentBusyError, OperationCancelledError, OperationDeadlineError } from '../../../packages/magnitude-core/src/agent/errors';
import { BrowserConnector } from '../../../packages/magnitude-core/src/connectors/browserConnector';
import { BrowserBlockedError } from '../../../packages/magnitude-core/src/web/recovery';
import { WebHarness } from '../../../packages/magnitude-core/src/web/harness';
import { retry } from '../../../packages/magnitude-core/src/common/retry';
import { retryOnError, retryOnErrorIsSuccess } from '../../../packages/magnitude-core/src/common/util';
import { operationSleep, drainAll } from '../../../packages/magnitude-core/src/common/operation';
import { Observation } from '../../../packages/magnitude-core/src/memory/observation';

const llm = { provider: 'anthropic' as const, options: { model: 'fixture', apiKey: 'unused' } };
const plan = { reasoning: 'Finish', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Complete' }] };
function agentWithAction(resolver: Parameters<typeof createAction>[0]['resolver']) {
    return new Agent({ llm, telemetry: false, actions: [createAction({ name: 'work', resolver })] });
}
const work = { variant: 'work' };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

// Pre-cancelled and expired requests never touch hooks, memory, models, or actions.
{
    const agent = agentWithAction(async () => { assert.fail('Must not dispatch'); });
    const controller = new AbortController();
    controller.abort('caller reason');
    for (const call of [
        () => agent.act('pre-cancelled', { signal: controller.signal }),
        () => agent.exec(work, undefined, { signal: controller.signal }),
        () => agent.query('query', z.string(), { signal: controller.signal }),
    ]) await assert.rejects(call(), error => error instanceof OperationCancelledError && error.cause === 'caller reason');
    await assert.rejects(agent.act('expired', { deadline: Date.now() - 1 }), OperationDeadlineError);
    await assert.rejects(agent.act('invalid', { deadline: NaN }), TypeError);
    assert.equal(agent.busy, false);
    console.log('PASS: pre-aborted and expired requests');
}

// Late model success or failure cannot write thoughts/notes or dispatch actions.
for (const failure of [false, true]) {
    const entered = Promise.withResolvers<void>();
    const model = Promise.withResolvers<typeof plan>();
    const controller = new AbortController();
    const agent = new Agent({ llm, telemetry: false });
    agent.models.partialAct = async () => { entered.resolve(); return model.promise; };
    let actions = 0, thoughts = 0;
    agent.events.on('actionStarted', () => { actions++; });
    agent.events.on('thought', () => { thoughts++; });
    const result = agent.act('late plan', { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await assert.rejects(result, OperationCancelledError);
    assert.equal(agent.busy, true);
    await assert.rejects(agent.act('overlap'), AgentBusyError);
    await assert.rejects(agent.query('overlap', z.string()), AgentBusyError);
    const before = await agent.memory.toJSON();
    if (failure) model.reject(new Error('401 Unauthorized'));
    else model.resolve({ ...plan, memory_updates: [{ key: 'late', text: 'Must not save', sources: [0], operation: 'add', expected_text: null }] } as typeof plan);
    await agent.whenIdle();
    assert.equal(agent.busy, false);
    assert.equal(actions, 0);
    assert.equal(thoughts, 0);
    assert.deepEqual(await agent.memory.toJSON(), before);
    agent.models.partialAct = async () => plan;
    await agent.act('safe reuse');
    assert.equal(actions, 1);
    console.log(`PASS: late model ${failure ? 'error' : 'success'} cannot act or mutate memory`);
}

// Cancellation at synchronous event boundaries must be checked before dispatch/mutation.
for (const event of ['actStarted', 'planningStarted', 'thought', 'actionStarted', 'actionDone'] as const) {
    const controller = new AbortController();
    let calls = 0;
    const agent = agentWithAction(async () => { calls++; });
    agent.models.partialAct = async () => ({ ...plan, actions: [work, work] });
    agent.events.on(event, () => controller.abort());
    await assert.rejects(agent.act('event boundary', { signal: controller.signal }), OperationCancelledError);
    await agent.whenIdle();
    assert.equal(calls, event === 'actionDone' ? 1 : 0);
}
console.log('PASS: event callbacks cannot bypass cancellation gates');

// whenIdle() called synchronously from an action must refer to that operation.
{
    const release = Promise.withResolvers<void>();
    let idle = false;
    const agent = agentWithAction(async ({ agent }) => {
        void agent.whenIdle().then(() => { idle = true; });
        await release.promise;
    });
    const result = agent.exec(work);
    await tick(); assert.equal(idle, false);
    release.resolve(); await result; assert.equal(idle, true);
}

// A hook already running holds the lock; the action after it must not begin.
{
    const hook = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const agent = new Agent({ llm, telemetry: false, connectors: [{ id: 'delayed', beforeAction: async (_action, options) => {
        assert.ok(options?.signal);
        entered.resolve(); await hook.promise;
    } }] });
    const result = agent.exec(plan.actions[0], undefined, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await assert.rejects(result, OperationCancelledError);
    assert.equal(agent.busy, true);
    hook.resolve();
    await agent.whenIdle();
    console.log('PASS: asynchronous hooks drain before reuse');
}

// An already-dispatched side effect is not rolled back. Subsequent actions are suppressed.
{
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let effects = 0;
    const agent = agentWithAction(async ({ signal, deadline }) => {
        assert.ok(signal); assert.ok(deadline);
        effects++; entered.resolve(); await release.promise;
    });
    agent.models.partialAct = async () => ({ ...plan, actions: [work, work] });
    const result = agent.act('in flight', { signal: controller.signal, deadline: Date.now() + 5000 });
    await entered.promise;
    controller.abort();
    await assert.rejects(result, OperationCancelledError);
    assert.equal(effects, 1); assert.equal(agent.busy, true);
    release.resolve(); await agent.whenIdle();
    assert.equal(effects, 1);
    console.log('PASS: in-flight side effect remains unknown; no subsequent action');
}

// Detached callbacks retain the old operation identity even after the agent is reused.
{
    const release = Promise.withResolvers<void>();
    let late!: Promise<void>;
    const agent = agentWithAction(async ({ agent }) => {
        late = release.promise.then(async () => {
            await assert.rejects(agent.queueDone(), OperationCancelledError);
            await assert.rejects(agent.exec(work), OperationCancelledError);
        });
    });
    await agent.exec(work);
    release.resolve(); await late;
    console.log('PASS: stale callbacks cannot finish or dispatch a new operation');
}

// Pause and stop must wake without requiring an explicit resume.
for (const stop of [false, true]) {
    const controller = new AbortController(), paused = Promise.withResolvers<void>();
    const agent = new Agent({ llm, telemetry: false });
    agent.models.partialAct = async () => plan;
    agent.pause(); agent.events.on('pause', () => paused.resolve());
    const result = agent.act('paused', { signal: controller.signal });
    await paused.promise;
    if (stop) await agent.stop(); else controller.abort();
    await assert.rejects(result, OperationCancelledError);
    await agent.whenIdle();
    assert.equal(agent.busy, false);
    if (!stop) { agent.resume(); await agent.act('resumed'); }
}
console.log('PASS: cancellation and stop interrupt pauses');

{
    const agent = new Agent({ llm, telemetry: false });
    agent.models.partialAct = async () => plan;
    agent.pause(); agent.events.on('pause', () => agent.resume());
    await agent.act('synchronous resume');
}

// Both retry helpers stop during backoff, including paths that normally swallow errors.
for (const retryFn of [
    (fn: () => Promise<void>) => retry(fn, { delay: 10_000, throwOnExhaustion: false }),
    (fn: () => Promise<void>) => retryOnError(fn, { mode: 'retry_all', delayMs: 10_000 }),
    (fn: () => Promise<void>) => retryOnErrorIsSuccess(fn, { mode: 'retry_all', delayMs: 10_000 }),
]) {
    let attempts = 0;
    const entered = Promise.withResolvers<void>(), controller = new AbortController();
    const agent = agentWithAction(async () => { await retryFn(async () => { attempts++; entered.resolve(); throw new Error('retry'); }); });
    const result = agent.exec(work, undefined, { signal: controller.signal });
    await entered.promise; await tick(); controller.abort();
    await assert.rejects(result, OperationCancelledError); await agent.whenIdle();
    assert.equal(attempts, 1);
}
console.log('PASS: retries and backoff respect cancellation');

// One deadline covers all steps, and aborts ordinary sleeps without executing later work.
{
    let count = 0;
    const agent = agentWithAction(async ({ agent }) => { count++; if (count === 2) await operationSleep(10_000); await agent.queueDone(); });
    agent.models.partialAct = async () => ({ ...plan, actions: [work] });
    const deadline = Date.now() + 100;
    await assert.rejects(agent.act(['one', 'two', 'three'], { deadline }), error => error instanceof OperationDeadlineError && error.deadline === deadline);
    await agent.whenIdle(); assert.equal(count, 2);
    console.log('PASS: shared multi-step deadline');
}

// Cooldown cancellation and unaffordable Retry-After use the real browser connector.
{
    const connector = new BrowserConnector();
    const entered = Promise.withResolvers<void>();
    const agent = agentWithAction(async () => { entered.resolve(); await connector.wait(10_000); });
    const controller = new AbortController();
    const result = agent.exec(work, undefined, { signal: controller.signal });
    await entered.promise; controller.abort();
    await assert.rejects(result, OperationCancelledError); await agent.whenIdle();
    assert.equal(connector.recovery.waitUntil, undefined);
    const retryAt = Date.now() + 60_000;
    connector.recovery.observe('limited', undefined, { reason: 'rate_limit', evidence: 'HTTP 429', retryAt });
    await assert.rejects(agent.exec(work, undefined, { deadline: Date.now() + 1000 }), error =>
        error instanceof BrowserBlockedError && error.block.retryAt === retryAt && error.block.evidence.includes('deadline'));
    assert.equal(connector.recovery.waitUntil, undefined);
    console.log('PASS: cooldown abort and structured deadline block preserve Retry-After');
}

{
    const connector = new BrowserConnector();
    let clicks = 0;
    connector.getHarness = () => ({ click: async () => { clicks++; } }) as unknown as WebHarness;
    const agent = new Agent({ llm, telemetry: false, connectors: [connector] });
    connector.recovery.observe('limited', undefined, { reason: 'rate_limit', evidence: 'HTTP 429', retryAt: Date.now() + 60_000 });
    const controller = new AbortController();
    const result = agent.exec({ variant: 'mouse:click', x: 1, y: 2 }, undefined, { signal: controller.signal });
    assert.ok(connector.recovery.waitUntil);
    controller.abort(); await assert.rejects(result, OperationCancelledError); await agent.whenIdle();
    assert.equal(clicks, 0);
    assert.equal(connector.recovery.waitUntil, undefined);
    console.log('PASS: browser action cannot follow a cancelled rate-limit cooldown');
}

// Pending parallel work must drain even after a sibling rejects.
{
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const agent = agentWithAction(async () => { entered.resolve(); await drainAll([Promise.reject(new Error('first')), release.promise]); });
    const result = agent.exec(work);
    await entered.promise; await tick(); assert.equal(agent.busy, true);
    release.resolve(); await assert.rejects(result, /first/); await agent.whenIdle();
}

// Built-in click preparation cannot issue a click after cancellation.
{
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let clicks = 0;
    const fakePage = { mouse: { move: async () => {}, click: async () => { clicks++; } } };
    const harness = new WebHarness({ on() {} } as any);
    Object.defineProperty(harness, 'page', { get: () => fakePage });
    harness.visualizer.moveVirtualCursor = async () => { entered.resolve(); await release.promise; };
    harness.visualizer.hideAll = async () => {};
    harness.visualizer.showAll = async () => {};
    const agent = agentWithAction(async () => { await harness.click({ x: 1, y: 2 }, { transform: false }); });
    const controller = new AbortController();
    const result = agent.exec(work, undefined, { signal: controller.signal });
    await entered.promise; controller.abort(); await assert.rejects(result, OperationCancelledError);
    assert.equal(agent.busy, true);
    release.resolve(); await agent.whenIdle(); assert.equal(clicks, 0);
    console.log('PASS: no click after delayed browser preparation');
}

// Composite input stops between commands while releasing held input state.
for (const action of ['type', 'drag', 'selectAll', 'clickAndType'] as const) {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController();
    const events: string[] = [];
    const blocked = async (name: string) => { events.push(name); entered.resolve(); await release.promise; };
    const page = {
        mouse: {
            move: async () => { events.push('move'); },
            down: () => blocked('down'), up: async () => { events.push('up'); },
            click: () => blocked('click'),
        },
        keyboard: {
            type: () => blocked('type'), press: async () => { events.push('press'); },
            down: () => blocked('key-down'), up: async () => { events.push('key-up'); },
        },
    };
    const harness = new WebHarness({ on() {} } as any);
    Object.defineProperty(harness, 'page', { get: () => page });
    harness.visualizer.moveVirtualCursor = async () => {};
    harness.visualizer.hideAll = async () => {};
    harness.visualizer.showAll = async () => {};
    const agent = agentWithAction(async () => {
        if (action === 'type') await harness.type({ content: 'before<enter>after' });
        if (action === 'drag') await harness.drag({ x1: 1, y1: 1, x2: 2, y2: 2 }, { transform: false });
        if (action === 'selectAll') await harness.selectAll();
        if (action === 'clickAndType') await harness.clickAndType({ x: 1, y: 1, content: 'after' }, { transform: false });
    });
    const result = agent.exec(work, undefined, { signal: controller.signal });
    await entered.promise; controller.abort(); await assert.rejects(result, OperationCancelledError);
    assert.equal(agent.busy, true);
    release.resolve(); await agent.whenIdle();
    assert.deepEqual(events, action === 'type' ? ['type'] : action === 'drag' ? ['move', 'down', 'up']
        : action === 'selectAll' ? ['key-down', 'key-up'] : ['move', 'click']);
}
console.log('PASS: composite input stops and releases held buttons/keys');

// All browser entry points participate, without opening a browser for pre-aborted calls.
{
    const agent = new BrowserAgent({ agentOptions: { llm, telemetry: false } });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(agent.nav('http://fixture.invalid', { signal: controller.signal }), OperationCancelledError);
    await assert.rejects(agent.extract('extract', z.string(), { signal: controller.signal }), OperationCancelledError);
    console.log('PASS: nav and extract accept operation controls');
}

// Query also discards a delayed model result and respects memory rendering options.
{
    const entered = Promise.withResolvers<void>(), model = Promise.withResolvers<string>(), controller = new AbortController();
    const agent = new Agent({ llm, telemetry: false, connectors: [{ id: 'fixture', collectObservations: async () => [Observation.fromConnector('fixture', 'value')] }] });
    agent.models.query = async () => { entered.resolve(); return model.promise; };
    const result = agent.query('query', z.string(), { signal: controller.signal, history: 'full' });
    await entered.promise; controller.abort(); await assert.rejects(result, OperationCancelledError);
    assert.equal(agent.busy, true); model.resolve('late'); await agent.whenIdle();
}
console.log('PASS: all cancellation checks');
