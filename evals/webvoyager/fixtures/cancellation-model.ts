import assert from 'node:assert/strict';
import { z } from 'zod';
import sharp from 'sharp';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { OperationCancelledError, OperationDeadlineError } from '../../../packages/magnitude-core/src/agent/errors';
import type { LLMClient } from '../../../packages/magnitude-core/src/ai/types';
import { Image } from '../../../packages/magnitude-core/src/memory/image';
import type { OperationOptions } from '../../../packages/magnitude-core/src/common/operation';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import { ClientRegistry } from '@boundaryml/baml';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}
const image = new Image(sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png());
class FixtureAgent extends Agent {
    extractModel(options: OperationOptions) {
        return this.runOperation(options, () => this.models.extract('Extract', z.string(), image, '<p>fixture</p>'));
    }
}

for (const provider of ['anthropic', 'openai', 'baseten'] as const) {
    let received = deferred(), release = deferred(), requests = 0;
    let mode: 'delayed' | 'retry' = 'delayed';
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
        await request.json(); requests++; received.resolve();
        if (mode === 'retry') return Response.json({ error: { message: 'retry fixture', type: 'rate_limit_error' } }, { status: 429 });
        await release.promise;
        return Response.json(provider === 'anthropic' ? {
            id: 'fixture', type: 'message', role: 'assistant', model: 'fixture',
            content: [{ type: 'text', text: '{"data":"late"}' }], stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
        } : {
            id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"data":"late"}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
    } });
    const llm: LLMClient = { provider, options: { model: 'fixture', apiKey: 'fixture' } };
    class FixtureHarness extends ModelHarness {
        protected createClientRegistry(options: Record<string, any>) {
            const registry = new ClientRegistry();
            registry.addLlmClient('Fixture', provider === 'baseten' ? 'openai-generic' : provider,
                { ...options, base_url: `http://127.0.0.1:${server.port}${provider === 'anthropic' ? '' : '/v1'}` }, 'DefaultRetryPolicy');
            registry.setPrimary('Fixture');
            return registry;
        }
    }
    const harness = new FixtureHarness({ llm });
    await harness.setup();
    const agent = new FixtureAgent({ llm, telemetry: false });
    agent.models.partialAct = harness.partialAct.bind(harness);
    agent.models.query = harness.query.bind(harness);
    agent.models.extract = harness.extract.bind(harness);
    let actions = 0;
    agent.events.on('actionStarted', () => { actions++; });
    try {
        for (const operation of ['act', 'query', 'extract', 'retry', 'deadline'] as const) {
            received = deferred(); release = deferred(); requests = 0;
            mode = operation === 'retry' ? 'retry' : 'delayed';
            const controller = new AbortController();
            const options: OperationOptions = operation === 'deadline' ? { deadline: Date.now() + 200 } : { signal: controller.signal };
            const result = operation === 'act' ? agent.act('Must not execute a late plan', options)
                : operation === 'extract' ? agent.extractModel(options)
                : agent.query('Read the value', z.string(), options);
            // Attach the handler before waiting for the fixture's request.
            const rejected = assert.rejects(result, operation === 'deadline' ? OperationDeadlineError : OperationCancelledError);
            await received.promise;
            if (operation === 'retry') await new Promise(resolve => setTimeout(resolve, 50));
            if (operation !== 'deadline') controller.abort('fixture cancel');
            await rejected;
            // The native model call must finish without the server sending a response.
            // A public Promise.race alone would fail this check by leaving the agent busy.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    agent.whenIdle(),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${provider}/${operation}: native request did not abort`)), 1000); }),
                ]);
            } finally { clearTimeout(timer); }
            assert.equal(agent.busy, false);
            release.resolve();
            if (operation === 'retry') await new Promise(resolve => setTimeout(resolve, 750));
            assert.equal(requests, 1, 'no hidden transport retry after cancellation');
            assert.equal(actions, 0);
            console.log(`PASS: ${provider} ${operation} cancels native request and drains`);
        }
    } finally {
        release.resolve(); await agent.stop(); await server.stop(true);
    }
}
console.log('PASS: all cancellation checks');
