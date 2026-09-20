import assert from 'node:assert/strict';
import { ClientRegistry } from '@boundaryml/baml';
import { z } from 'zod';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import { OperationCancelledError, OperationDeadlineError } from '../../../packages/magnitude-core/src/agent/errors';
import type { OperationDiagnostics } from '../../../packages/magnitude-core/src/common/operation';

for (const provider of ['anthropic', 'openai', 'baseten'] as const) {
    let mode: 'retry' | 'hold' | 'no-usage' = 'retry', requests = 0, usages = 0;
    let received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const snapshots: OperationDiagnostics[] = [];
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
        await request.json(); requests++; received.resolve();
        const headers = {
            [provider === 'anthropic' ? 'request-id' : 'x-request-id']: mode === 'no-usage' ? 'https://SECRET_REQUEST_ID' : `fixture-${requests}`,
            'authorization': 'SECRET_HEADER', 'x-private': 'SECRET_PRIVATE_HEADER',
        };
        if (mode === 'hold') await release.promise;
        if (mode === 'retry' && requests === 1) return Response.json({ error: {
            message: 'SECRET_ERROR', type: 'rate_limit_error',
        } }, { status: 429, headers });
        return Response.json(provider === 'anthropic' ? {
            id: 'SECRET_BODY_ID', type: 'message', role: 'assistant', model: 'SECRET_BODY_MODEL',
            content: [{ type: 'text', text: '{"data":"SECRET_RESPONSE"}' }], stop_reason: 'end_turn',
            ...(mode === 'no-usage' ? {} : { usage: { input_tokens: 1, output_tokens: 1 } }),
        } : {
            id: 'SECRET_BODY_ID', object: 'chat.completion', created: 1, model: 'SECRET_BODY_MODEL',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"data":"SECRET_RESPONSE"}' }, finish_reason: 'stop' }],
            ...(mode === 'no-usage' ? {} : { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        }, { headers });
    } });
    class FixtureHarness extends ModelHarness {
        protected createClientRegistry(options: Record<string, unknown>) {
            const registry = new ClientRegistry();
            registry.addLlmClient('Fixture', provider === 'baseten' ? 'openai-generic' : provider,
                { ...options, base_url: `http://127.0.0.1:${server.port}/SECRET_URL` }, mode === 'no-usage' ? undefined : 'DefaultRetryPolicy');
            registry.setPrimary('Fixture'); return registry;
        }
    }
    const llm = { provider, options: { model: 'fixture', apiKey: 'SECRET_KEY' } };
    const harness = new FixtureHarness({ llm });
    await harness.setup();
    const agent = new Agent({ llm, telemetry: false });
    agent.models.query = harness.query.bind(harness);
    agent.events.on('operation', snapshot => { snapshots.push(snapshot); });
    harness.events.on('tokensUsed', () => { usages++; });
    try {
        assert.equal(await agent.query('SECRET_PROMPT', z.string(), { deadline: Date.now() + 10_000 }), 'SECRET_RESPONSE');
        assert.equal(requests, 2); assert.equal(usages, 1);
        const attempts = agent.operation!.providerAttempts!;
        assert.equal(attempts.length, 2);
        assert.deepEqual(attempts.map(attempt => [attempt.attempt, attempt.httpStatus, attempt.requestId, attempt.outcome]), [
            [1, 429, 'fixture-1', 'failed'], [2, 200, 'fixture-2', 'succeeded'],
        ]);
        assert.ok(attempts[0].startedAt <= attempts[1].startedAt, 'collector order must not determine attempt order');
        for (const attempt of attempts) {
            assert.equal(attempt.operationId, agent.operation!.id);
            assert.equal(attempt.provider, provider); assert.equal(attempt.model, 'fixture');
            assert.ok(attempt.elapsedMs !== null && attempt.elapsedMs >= 0);
        }
        console.log(`PASS: ${provider} records actual retries in order without duplicate usage`);

        for (const cancellation of ['signal', 'deadline'] as const) {
            mode = 'hold'; requests = 0; usages = 0;
            received = Promise.withResolvers<void>(); release = Promise.withResolvers<void>();
            const controller = new AbortController();
            const rejected = assert.rejects(agent.query('SECRET_PROMPT', z.string(), cancellation === 'signal'
                ? { signal: controller.signal } : { deadline: Date.now() + 200 }),
            cancellation === 'signal' ? OperationCancelledError : OperationDeadlineError);
            await received.promise;
            if (cancellation === 'signal') {
                await new Promise(resolve => setTimeout(resolve, 25));
                controller.abort('SECRET_ABORT');
            }
            await rejected;
            const timer = setTimeout(() => { throw new Error('Native request did not drain'); }, 1000);
            try { await agent.whenIdle(); } finally { clearTimeout(timer); }
            assert.equal(requests, 1); assert.equal(usages, 0); assert.equal(agent.busy, false);
            assert.equal(agent.operation!.outcome, cancellation === 'signal' ? 'cancelled' : 'deadline');
            assert.equal(agent.operation!.providerAttempts!.length, 1);
            assert.deepEqual(agent.operation!.providerAttempts![0], {
                operationId: agent.operation!.id, attempt: 1, provider, model: 'fixture',
                startedAt: agent.operation!.providerAttempts![0].startedAt,
                elapsedMs: null, httpStatus: null, requestId: null, outcome: 'unknown',
            });
            const finished = JSON.stringify(agent.operation);
            release.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(JSON.stringify(agent.operation), finished);
            console.log(`PASS: ${provider} ${cancellation} retains unknown evidence and drains`);
        }

        const priorId = agent.operation!.id;
        mode = 'no-usage'; requests = 0; usages = 0;
        await harness.setup();
        // Anthropic requires usage to parse its response; metadata must survive that failure too.
        const query = agent.query('SECRET_PROMPT', z.string());
        if (provider === 'anthropic') await assert.rejects(query);
        else await query;
        assert.notEqual(agent.operation!.id, priorId);
        assert.equal(agent.operation!.providerAttempts!.length, 1);
        assert.equal(agent.operation!.providerAttempts![0].attempt, 1);
        assert.equal(agent.operation!.providerAttempts![0].httpStatus, 200);
        assert.equal(agent.operation!.providerAttempts![0].requestId, null);
        assert.equal(usages, 0);
        assert.ok(!JSON.stringify(snapshots).includes('SECRET'));
        assert.ok(!JSON.stringify(snapshots).includes('http://'));
        console.log(`PASS: ${provider} records usage-free attempts with no stale or sensitive metadata`);
    } finally { release.resolve(); await agent.stop(); server.stop(true); }
}
