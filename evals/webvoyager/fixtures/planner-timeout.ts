import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { ClientRegistry } from '@boundaryml/baml';
import { z } from 'zod';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import { AgentBusyError, ExtractTimeoutError, OperationCancelledError, OperationDeadlineError, PlannerTimeoutError } from '../../../packages/magnitude-core/src/agent/errors';
import { Image } from '../../../packages/magnitude-core/src/memory/image';
import type { OperationDiagnostics } from '../../../packages/magnitude-core/src/common/operation';
import type { PlannerResponse } from '../../../packages/magnitude-core/src/ai/plannerResponse';

const plan = { reasoning: 'SECRET_REASONING', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'SECRET_EVIDENCE' }] };

const fixtureLlm = { provider: 'anthropic' as const, options: { model: 'fixture', apiKey: 'unused' } };
for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => new Agent({ llm: fixtureLlm, telemetry: false, planner: { timeoutMs } }), /planner.timeoutMs/);
}
for (const maxRetries of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new Agent({ llm: fixtureLlm, telemetry: false, planner: { timeoutMs: 10, maxRetries } }), /planner.maxRetries/);
}
for (const timeoutMs of [0, 1.5]) {
    assert.throws(() => new Agent({ llm: fixtureLlm, telemetry: false, extract: { timeoutMs } }), /extract.timeoutMs/);
}
console.log('PASS: planner policy validates request budgets and retry counts');

for (const scenario of ['retry', 'exhaust', 'cancel'] as const) {
    const planner = { timeoutMs: 20, maxRetries: scenario === 'exhaust' ? 0 : 1 };
    const harness = new ModelHarness({ llm: fixtureLlm, planner });
    const agent = new Agent({ llm: fixtureLlm, planner, telemetry: false });
    const release = Promise.withResolvers<void>(), timedOut = Promise.withResolvers<void>();
    let calls = 0, actions = 0;
    // Stand in for a transport that ignores abort and eventually fulfills.
    (harness as unknown as { partialActAttempt: (...args: any[]) => Promise<PlannerResponse> }).partialActAttempt = async (...args) => {
        if (++calls > 1) return plan;
        const signal = (args[4] as () => AbortSignal)();
        signal.addEventListener('abort', () => timedOut.resolve(), { once: true });
        await release.promise;
        return { ...plan, reasoning: 'LATE_RESPONSE', memory_updates: [{
            key: 'late', text: 'LATE_NOTE', sources: [0], operation: 'add', expected_text: null,
        }] };
    };
    agent.models.partialAct = harness.partialAct.bind(harness);
    agent.events.on('actionStarted', () => { actions++; });
    const controller = new AbortController();
    const result = agent.act('Fixture', { signal: controller.signal });
    const completion = scenario === 'retry' ? result
        : assert.rejects(result, scenario === 'cancel' ? OperationCancelledError : PlannerTimeoutError);
    try {
        await timedOut.promise;
        assert.equal(calls, 1); assert.equal(actions, 0); assert.equal(agent.busy, true);
        assert.equal(agent.operation!.plannerCalls![0].status, 'draining');
        assert.equal(agent.operation!.plannerCalls![0].outcome, 'timeout');
        await assert.rejects(agent.exec({ variant: 'task:done', evidence: 'Unsafe reuse' }), AgentBusyError);
        if (scenario === 'cancel') {
            controller.abort(); await completion;
            assert.equal(agent.busy, true);
        }
        release.resolve(); await completion; await agent.whenIdle();
        assert.equal(calls, scenario === 'retry' ? 2 : 1);
        assert.equal(actions, scenario === 'retry' ? 1 : 0);
        assert.equal(agent.busy, false);
        assert.ok(!JSON.stringify(await agent.memory.toJSON()).includes('LATE_'));
        console.log(`PASS: uncooperative timed-out planner drains before ${scenario}`);
    } finally { release.resolve(); await agent.whenIdle(); await agent.stop(); }
}

{
    const planner = { timeoutMs: 20, maxRetries: 1 };
    const harness = new ModelHarness({ llm: fixtureLlm, planner });
    const agent = new Agent({ llm: fixtureLlm, planner, telemetry: false });
    let calls = 0;
    (harness as unknown as { partialActAttempt: () => Promise<PlannerResponse> }).partialActAttempt = async () => {
        calls++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
        throw new Error('Synchronous failure after the request budget');
    };
    agent.models.partialAct = harness.partialAct.bind(harness);
    try {
        await assert.rejects(agent.act('Fixture'), PlannerTimeoutError);
        assert.equal(calls, 2);
        assert.deepEqual(agent.operation!.plannerCalls!.map(call => call.outcome), ['timeout', 'timeout']);
        assert.equal(agent.operation!.lastAction, undefined);
        console.log('PASS: synchronous failures past budget receive bounded timeout retries');
    } finally { await agent.stop(); }
}

for (const provider of ['anthropic', 'openai', 'baseten'] as const) {
    for (const scenario of ['retry', 'exhaust', 'exhaust-retry', 'cancel', 'deadline', 'transport', 'format', 'slow-validation', 'start-cancel', 'opt-out', 'query'] as const) {
        let requests = 0, actions = 0;
        const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        const snapshots: OperationDiagnostics[] = [];
        const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
            await request.json();
            const requestNumber = ++requests;
            received.resolve();
            if (scenario === 'transport') return Response.json({ error: {
                message: 'SECRET_ERROR', type: 'rate_limit_error',
            } }, { status: 429 });
            if (scenario === 'opt-out' || scenario === 'query') await sleep(250);
            else if (scenario !== 'slow-validation' && !(scenario === 'retry' && requestNumber === 2) && !(scenario === 'format' && requestNumber === 1)) await release.promise;
            const content = JSON.stringify(scenario === 'query' ? { data: 'ok' }
                : scenario === 'format' && requestNumber === 1 ? { ...plan, memory_updates: undefined } : plan);
            return Response.json(provider === 'anthropic' ? {
                id: 'fixture', type: 'message', role: 'assistant', model: 'fixture',
                content: [{ type: 'text', text: content }], stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            } : {
                id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture',
                choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }, { headers: { 'x-request-id': `fixture-${requestNumber}` } });
        } });
        class FixtureHarness extends ModelHarness {
            protected createClientRegistry(options: Record<string, unknown>) {
                const registry = new ClientRegistry();
                registry.addLlmClient('Fixture', provider === 'baseten' ? 'openai-generic' : provider,
                    { ...options, base_url: `http://127.0.0.1:${server.port}` }, 'DefaultRetryPolicy');
                registry.setPrimary('Fixture'); return registry;
            }
        }
        const llm = { provider, options: { model: 'fixture', apiKey: 'SECRET_KEY' } };
        const planner = scenario === 'opt-out' ? undefined : {
            timeoutMs: scenario === 'deadline' || scenario === 'cancel' ? 2000 : 200,
            ...(['exhaust', 'transport', 'format', 'slow-validation'].includes(scenario) ? { maxRetries: 0 } : {}),
        };
        const harness = new FixtureHarness({ llm, planner });
        await harness.setup();
        const agent = new Agent({ llm, planner, telemetry: false, ...(scenario === 'slow-validation' ? { actions: [createAction({
            name: 'task:done', schema: z.object({ evidence: z.string().refine(() => {
                // Block JS so the timeout callback cannot run before validation rejects.
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
                return false;
            }) }), resolver: async () => { throw new Error('Rejected plan must not execute'); },
        })] } : {}) });
        agent.models.partialAct = harness.partialAct.bind(harness);
        agent.models.query = harness.query.bind(harness);
        agent.events.on('actionStarted', () => { actions++; });
        const controller = new AbortController();
        agent.events.on('operation', snapshot => {
            snapshots.push(snapshot);
            if (scenario === 'start-cancel' && snapshot.plannerCalls?.at(-1)?.status === 'running') controller.abort();
        });
        try {
            if (scenario === 'query') {
                assert.equal(await agent.query('SECRET_QUERY', z.string()), 'ok');
                assert.equal(requests, 1);
                assert.equal(agent.operation!.plannerCalls, undefined);
                assert.equal(agent.operation!.providerAttempts![0].plannerCallId, undefined);
                console.log(`PASS: ${provider} query is unaffected by act budget`);
                continue;
            }
            const result = agent.act('SECRET_TASK', scenario === 'deadline'
                ? { deadline: Date.now() + 200 } : { signal: controller.signal });
            if (scenario === 'retry' || scenario === 'opt-out') await result;
            else {
                const errorType = scenario === 'cancel' || scenario === 'start-cancel' ? OperationCancelledError
                    : scenario === 'deadline' ? OperationDeadlineError : PlannerTimeoutError;
                const rejected = assert.rejects(result, error => {
                    assert.ok(error instanceof errorType);
                    if (error instanceof PlannerTimeoutError) {
                        assert.equal(error.timeoutMs, 200);
                        assert.equal(error.options.variant, 'planner_timeout');
                        assert.equal(error.operation?.outcome, 'failed');
                    }
                    return true;
                });
                if (scenario === 'cancel') { await received.promise; controller.abort('SECRET_REASON'); }
                await rejected;
            }
            const timer = setTimeout(() => { throw new Error('Native planner did not drain'); }, 1000);
            try { await agent.whenIdle(); } finally { clearTimeout(timer); }
            assert.equal(agent.busy, false);
            const calls = agent.operation!.plannerCalls!;
            assert.equal(calls.length, scenario === 'retry' || scenario === 'exhaust-retry' ? 2 : 1);
            assert.ok(calls.every(call => call.status === 'finished' && call.endedAt! >= call.startedAt));
            assert.equal(calls[0].provider, provider);
            assert.equal(calls[0].model, 'fixture');
            assert.equal(calls[0].attempt, 1);
            assert.ok(snapshots.some(snapshot => snapshot.plannerCalls?.[0]?.status === 'running'));
            if (scenario === 'retry') {
                assert.deepEqual(calls.map(call => call.outcome), ['timeout', 'succeeded']);
                assert.equal(calls[1].attempt, 2);
                assert.notEqual(calls[0].id, calls[1].id);
                const attempts = agent.operation!.providerAttempts!;
                assert.deepEqual(attempts.map(attempt => attempt.plannerCallId), calls.map(call => call.id));
                assert.equal(attempts[1].requestId, 'fixture-2');
                assert.ok(snapshots.some(snapshot => snapshot.plannerCalls?.[0]?.status === 'draining'));
                assert.equal(agent.operation!.outcome, 'succeeded');
            } else if (scenario !== 'opt-out') {
                assert.equal(calls[0].outcome, scenario === 'deadline' ? 'deadline'
                    : scenario === 'cancel' || scenario === 'start-cancel' ? 'cancelled' : 'timeout');
                if (scenario === 'exhaust-retry') assert.deepEqual(calls.map(call => [call.attempt, call.outcome]), [[1, 'timeout'], [2, 'timeout']]);
            } else {
                assert.equal(calls[0].timeoutMs, undefined);
                assert.equal(calls[0].outcome, 'succeeded');
                assert.ok(calls[0].elapsedMs >= 200);
            }
            if (scenario !== 'start-cancel') {
                assert.ok(agent.operation!.providerAttempts!.every(attempt => calls.some(call => call.id === attempt.plannerCallId)));
            }
            assert.equal(actions, scenario === 'retry' || scenario === 'opt-out' ? 1 : 0);
            assert.equal(requests, scenario === 'start-cancel' ? 0 : ['retry', 'exhaust-retry', 'format'].includes(scenario) ? 2 : 1);
            assert.ok(!JSON.stringify(snapshots).includes('SECRET'));
            const finished = JSON.stringify(agent.operation);
            release.resolve();
            await sleep(scenario === 'transport' ? 600 : 10);
            assert.equal(JSON.stringify(agent.operation), finished, 'late responses must not change finished diagnostics');
            assert.equal(actions, scenario === 'retry' || scenario === 'opt-out' ? 1 : 0);
            if (scenario === 'transport') assert.equal(requests, 1, 'no hidden native retry after timeout');
            console.log(`PASS: ${provider} ${scenario}`);
        } finally { release.resolve(); await agent.stop(); server.stop(true); }
    }

}

// extract() under its own policy: a stalled request is aborted, drains, and is retried once by default.
const pixel = Image.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
for (const provider of ['anthropic', 'baseten'] as const) for (const scenario of ['retry', 'exhaust'] as const) {
    let requests = 0;
    const release = Promise.withResolvers<void>();
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
        await request.json();
        if (++requests === 1 || scenario === 'exhaust') await release.promise;
        const content = JSON.stringify({ subject: 'Previous appointment instructions' });
        return Response.json(provider === 'anthropic' ? {
            id: 'fixture', type: 'message', role: 'assistant', model: 'fixture',
            content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        } : {
            id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
    } });
    class FixtureHarness extends ModelHarness {
        protected createClientRegistry(options: Record<string, unknown>) {
            const registry = new ClientRegistry();
            registry.addLlmClient('Fixture', provider === 'baseten' ? 'openai-generic' : provider,
                { ...options, base_url: `http://127.0.0.1:${server.port}` }, 'DefaultRetryPolicy');
            registry.setPrimary('Fixture'); return registry;
        }
    }
    const llm = { provider, options: { model: 'fixture', apiKey: 'unused' } };
    const extract = { timeoutMs: 200, ...(scenario === 'exhaust' ? { maxRetries: 0 } : {}) };
    const harness = new FixtureHarness({ llm, extract });
    await harness.setup();
    const agent = new Agent({ llm, extract, telemetry: false });
    const run = () => (agent as unknown as { runOperation: <T>(options: object, fn: () => Promise<T>, kind: string) => Promise<T> })
        .runOperation({}, () => harness.extract('Return the subject', z.object({ subject: z.string() }), pixel, 'Previous appointment instructions'), 'extract');
    try {
        if (scenario === 'retry') assert.deepEqual(await run(), { subject: 'Previous appointment instructions' });
        else await assert.rejects(run(), error => error instanceof ExtractTimeoutError && error.timeoutMs === 200 && error.options.variant === 'extract_timeout');
        release.resolve();
        await agent.whenIdle();
        assert.equal(requests, scenario === 'retry' ? 2 : 1);
        assert.equal(agent.operation!.plannerCalls, undefined, 'extract is not recorded as a planner call');
        assert.equal(agent.operation!.providerAttempts!.length, requests);
        console.log(`PASS: ${provider} extract ${scenario === 'retry' ? 'recovers from a stalled request' : 'reports ExtractTimeoutError'}`);
    } finally { release.resolve(); await agent.stop(); server.stop(true); }
}
