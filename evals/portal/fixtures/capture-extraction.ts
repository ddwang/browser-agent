import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import { Image } from '../../../packages/magnitude-core/src/memory/image';
import { DEFAULT_BASETEN_MODEL } from '../../../packages/magnitude-core/src/ai/baseten';
import { retrievalAnswerSchema } from '../portal';

const examples = [
    { portal: 'ucsd', id: 'latest-result', answer: { patientName: 'Fixture Patient', collectionDate: '2026-01-01', creatinine: 1.23, unit: 'fixture-unit' } },
    { portal: 'ucsd', id: 'older-result', answer: { collectionDate: '2026-01-01', creatinine: 1.23 } },
    { portal: 'kaiser-permanente', id: 'latest-result', answer: { collectionDate: '2026-01-01', value: 1.23, unit: 'fixture-unit' } },
    { portal: 'ucsd', id: 'empty-results', answer: { hasResults: false } },
] as const;
let calls = 0;
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    assert.equal(request.headers.get('authorization'), 'Bearer loopback-fixture');
    const expected = examples[calls++].answer;
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 1, model: DEFAULT_BASETEN_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(expected) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
} });
try {
    const model = new ModelHarness({ llm: { provider: 'baseten', options: { model: DEFAULT_BASETEN_MODEL,
        apiKey: 'loopback-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, structuredOutputs: true } } });
    await model.setup();
    const image = new Image(sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).png());
    for (const example of examples) {
        assert.deepEqual(await model.extract('Return the displayed scalar fields.', retrievalAnswerSchema(example.portal, example.id), image, ''), example.answer);
    }
    assert.equal(calls, examples.length);
    console.log('PASS: real BAML extraction preserves named scalar fields');
} finally { server.stop(true); }
