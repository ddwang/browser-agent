import assert from 'node:assert/strict';
import { ClientRegistry } from '@boundaryml/baml';
import sharp from 'sharp';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import { AgentMemory } from '../../../packages/magnitude-core/src/memory/agentMemory';
import { Observation } from '../../../packages/magnitude-core/src/memory/observation';
import { Image } from '../../../packages/magnitude-core/src/memory/image';
import { memoryActions } from '../../../packages/magnitude-core/src/actions/memoryActions';
import { webActions } from '../../../packages/magnitude-core/src/actions/webActions';
import { taskActions } from '../../../packages/magnitude-core/src/actions/taskActions';

const note = { key: 'fixture-record', text: 'Observed total: 437.', sources: [0] };
const plan = { reasoning: 'Keep the observed value before moving on.', actions: [{ variant: 'memory:note', ...note }] };
let requests: any[] = [];
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body = await request.json();
    requests.push(body);
    if (body.model === 'gpt-5.6-luna') return Response.json({
        id: 'fixture', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
    return Response.json({
        id: 'fixture', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: JSON.stringify(plan) }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
    });
} });
try {
    for (const provider of ['anthropic', 'openai'] as const) {
        requests = [];
        class FixtureHarness extends ModelHarness {
            protected createClientRegistry(options: Record<string, any>) {
                const registry = new ClientRegistry();
                registry.addLlmClient('Fixture', provider, { ...options, base_url: `http://127.0.0.1:${server.port}/v1` });
                registry.setPrimary('Fixture');
                return registry;
            }
        }
        const harness = new FixtureHarness({ llm: { provider, options: {
            model: provider === 'openai' ? 'gpt-5.6-luna' : 'claude-haiku-4-5-20251001', apiKey: 'loopback-fixture',
        } } });
        await harness.setup();
        const memory = new AgentMemory({ promptCaching: provider === 'anthropic' });
        memory.recordObservation(Observation.fromConnector('fixture', {
            url: 'https://fixture.invalid/record?filter=unique',
            screenshot: new Image(sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png()),
        }, { type: 'screen', limit: 1 }));
        const act = async () => harness.partialAct({ connectorInstructions: [], observationContent: await memory.render() },
            'Save the observed record.', [], [...memoryActions, ...webActions, ...taskActions]);
        assert.deepEqual(await act(), plan);
        assert.match(JSON.stringify(requests[0]), /\[Observation 0\]/);
        assert.match(JSON.stringify(requests[0]), provider === 'openai' ? /image_url/ : /image\/png/);
        if (provider === 'anthropic') {
            const schema = JSON.stringify(requests[0].output_config.format.schema);
            assert.match(schema, /memory:note/);
            assert.match(schema, /memory:forget/);
        }
        memory.remember(note);
        for (let i = 0; i < 5; i++) {
            memory.recordObservation(Observation.fromConnector('fixture', `Other page ${i}`, { type: 'screen', limit: 1 }));
            await memory.render();
        }
        assert.deepEqual(await act(), plan);
        const request = JSON.stringify(requests[1]);
        assert.match(request, /model-written summaries, not independent evidence/);
        assert.match(request, /Observed total: 437/);
        assert.match(request, /filter=unique/);
        assert.ok(!request.includes('[Observation 0]'), 'the original screenshot has left the model context');
        console.log(`PASS: ${provider} transports source-linked notes after image eviction with the complete action vocabulary`);
    }
} finally { server.stop(true); }
