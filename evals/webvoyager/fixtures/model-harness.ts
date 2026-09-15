import assert from 'node:assert/strict';
import { ClientRegistry } from '@boundaryml/baml';
import { z } from 'zod';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import { type AgentContext } from '../../../packages/magnitude-core/src/ai/baml_client';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { Image } from '../../../packages/magnitude-core/src/memory/image';
import type { ModelUsage } from '../../../packages/magnitude-core/src/ai/types';
import { PlannerResponseError } from '../../../packages/magnitude-core/src/ai/plannerResponse';
import { ModelResponseError } from '../../../packages/magnitude-core/src/ai/modelResponseError';
import sharp from 'sharp';
import { plannerRepairCases, rejectedValue } from './planner-repair-cases';

// Exercise the actual BAML parser and collector without external model calls.
const plan = { reasoning: 'Click the visible button.', memory_updates: [], actions: [{ variant: 'click', x: 12 }] };
const valid = JSON.stringify(plan);
const xml = '<function_calls><invoke name="web_action"><parameter name="reasoning">Click</parameter><parameter name="actions">[{"variant":"click","x":12}]</parameter></invoke></function_calls>';
type Reply = { text?: string; textFor?: (request: any) => string; status?: number; outputTokens?: number; stopReason?: string };
let replies: Reply[] = [];
let requests: any[] = [];
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    requests.push(await request.json());
    const reply = replies.shift();
    if (!reply) return new Response('Unexpected fixture request', { status: 400 });
    if (reply.status) return new Response('Fixture HTTP error', { status: reply.status });
    return Response.json({
        id: `fixture-${requests.length}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: reply.textFor?.(requests.at(-1)) ?? reply.text }], stop_reason: reply.stopReason ?? 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: reply.outputTokens ?? 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
    });
} });
const context: AgentContext = { connectorInstructions: [], observationContent: [{ role: 'user', cacheControl: false, content: ['A button is visible at x=12.'] }] };
const vocabulary = [createAction({ name: 'click', schema: z.object({ x: z.number() }), resolver: async () => {} })];

async function fixture(sequence: Reply[], providerRetry = false) {
    replies = [...sequence]; requests = [];
    let registryBuilds = 0;
    class FixtureHarness extends ModelHarness {
        protected createClientRegistry(options: Record<string, any>) {
            registryBuilds++;
            const registry = new ClientRegistry();
            registry.addLlmClient('Fixture', 'anthropic', { ...options, base_url: `http://127.0.0.1:${server.port}` }, providerRetry ? 'DefaultRetryPolicy' : undefined);
            registry.setPrimary('Fixture');
            return registry;
        }
    }
    const harness = new FixtureHarness({ llm: { provider: 'anthropic', options: { model: 'claude-haiku-4-5-20251001', apiKey: 'loopback-fixture' } } });
    await harness.setup();
    const usage: ModelUsage[] = [];
    harness.events.on('tokensUsed', entry => { usage.push(entry); return {}; });
    const act = () => harness.partialAct(context, 'Click the button.', [], vocabulary);
    return { harness, usage, act, registryBuilds: () => registryBuilds };
}

try {
    {
        const changed = { ...plan, actions: [{ variant: 'tap', x: 'left' }] };
        const { harness, registryBuilds } = await fixture([
            { text: valid }, { text: valid }, { text: valid }, { text: valid },
            { text: JSON.stringify(changed) }, { text: JSON.stringify(changed) },
        ]);
        const action = createAction({ name: 'click', schema: z.object({ x: z.number() }), resolver: async () => {} });
        const actions = [action];
        const act = () => harness.partialAct(context, 'Fixture', [], actions);
        await act();
        await act();
        assert.equal(registryBuilds(), 2, 'setup and one planner registry, reused on the next step');
        action.description = 'A changed action description';
        await act();
        assert.equal(registryBuilds(), 3);
        assert.match(JSON.stringify(requests.at(-1).output_config), /A changed action description/);
        actions.push(createAction({ name: 'other', schema: z.object({ x: z.number() }), resolver: async () => {} }));
        await act();
        assert.equal(registryBuilds(), 4, 'changed membership invalidates the cache');
        actions.splice(0, actions.length, createAction({ name: 'tap', schema: z.object({ x: z.string() }), resolver: async () => {} }) as any);
        assert.deepEqual(await act(), changed);
        assert.equal(registryBuilds(), 5);
        await harness.setup();
        assert.deepEqual(await act(), changed);
        assert.equal(registryBuilds(), 7, 'setup invalidates the cached registry and type builder');
        console.log('PASS: planner setup is reused while action descriptions, membership, names, schemas and model setup invalidate it');
    }
    {
        const { harness } = await fixture([{ text: '{"answer":true}' }, { text: '{"answer":true}' }]);
        const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
        for (const format of ['png', 'jpeg'] as const) {
            const screenshot = new Image(sharp(png).toFormat(format));
            assert.deepEqual(await harness.extract('Answer?', z.object({ answer: z.boolean() }), screenshot, '<p>Fixture</p>'), { answer: true });
            const image = requests.at(-1).messages.flatMap((message: any) => message.content).find((part: any) => part.type === 'image');
            assert.equal(image.source.media_type, `image/${format}`);
            assert.equal((await sharp(Buffer.from(image.source.data, 'base64')).metadata()).format, format);
        }
        console.log('PASS: model image media type matches the emitted bytes after conversion');
    }
    {
        const screenshot = new Image(sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png());
        for (const { schema, data, expected } of [
            { schema: z.string(), data: 'observed', expected: 'observed' },
            { schema: z.array(z.number()), data: [1, 2], expected: [1, 2] },
            { schema: z.string().transform(value => `${value}!`), data: 'observed', expected: 'observed!' },
            { schema: z.object({ answer: z.boolean() }).transform(value => value.answer), data: { answer: true }, expected: true },
        ]) {
            const reply = { text: JSON.stringify({ data }) };
            const { harness, usage } = await fixture([reply, reply]);
            assert.deepEqual(await harness.query(context, 'Read the value.', schema), expected);
            assert.deepEqual(await harness.extract('Read the value.', schema, screenshot, '<p>Fixture</p>'), expected);
            assert.equal(usage.length, 2);
        }
        console.log('PASS: query and extraction unwrap primitive, array and transformed schemas exactly once');
    }
    {
        const { act, usage } = await fixture([{ text: valid }]);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 1);
        assert.match(JSON.stringify(requests[0]), /Return exactly one complete JSON object/);
        assert.equal(requests[0].output_config.format.type, 'json_schema');
        assert.equal(requests[0].output_config.format.schema.properties.actions.items.properties.variant.const, 'click');
        assert.equal(usage.length, 1);
        assert.deepEqual([usage[0].inputTokens, usage[0].outputTokens, usage[0].cacheWriteInputTokens, usage[0].cacheReadInputTokens], [10, 20, 30, 40]);
        assert.ok(Math.abs(usage[0].inputCost! - 0.0000515) < 1e-12);
        assert.equal(usage[0].outputCost, 0.0001);
        console.log('PASS: valid plan and exact cached usage');
    }
    for (const rejected of [xml, `Here is the plan: ${valid}`, JSON.stringify({ reasoning: plan.reasoning, actions: plan.actions })]) {
        const { act, usage } = await fixture([{ text: rejected, outputTokens: 4096 }, { text: valid }]);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        assert.equal(usage.reduce((sum, item) => sum + item.outputTokens, 0), 4116);
        assert.match(JSON.stringify(requests[1]), /No actions were executed/);
        assert.ok(!JSON.stringify(requests[1]).includes(rejected));
        assert.equal(context.observationContent.length, 1);
        console.log('PASS: rejected response accounted before bounded format repair');
    }
    {
        const { act, usage } = await fixture([{ text: xml }, { text: xml }]);
        await assert.rejects(act(), error => error instanceof PlannerResponseError
            && error.message.includes('invalid plan on both attempts') && error.diagnostic.includes('invalid_json'));
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        console.log('PASS: invalid plans fail after two attempts');
    }
    for (const { value, diagnostic } of plannerRepairCases) {
        const { act, usage } = await fixture([{ text: JSON.stringify(value) }, { text: valid }]);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        const repair = requests[1].messages.at(-1).content.map((part: any) => part.text ?? '').join('');
        assert.ok(repair.includes(diagnostic), repair);
        assert.ok(!repair.includes(rejectedValue));
        assert.ok(repair.length < 1600);
        assert.equal(context.observationContent.length, 1);
        console.log('PASS: Anthropic retry receives bounded field-level diagnostics without rejected values');
    }
    {
        const { act, harness, usage } = await fixture([{ text: valid }, { status: 400 }, { text: '{"answer":true}' }]);
        await act();
        await assert.rejects(act());
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 1);
        assert.deepEqual(await harness.query(context, 'Answer?', z.object({ answer: z.boolean() })), { answer: true });
        assert.equal(usage.length, 2);
        assert.equal(usage.reduce((sum, item) => sum + item.inputTokens, 0), 20);
        console.log('PASS: HTTP failure has no format retry or duplicate usage');
    }
    {
        const { harness, usage } = await fixture([{ text: '{"other":"invalid"}' }, { text: '{"other":"invalid"}' }]);
        const schema = z.object({ answer: z.boolean() });
        await assert.rejects(harness.query(context, 'Answer?', schema));
        assert.equal(usage.length, 1);
        const screenshot = Image.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7mgAAAAASUVORK5CYII=');
        await assert.rejects(harness.extract('Answer?', schema, screenshot, '<p>Fixture</p>'));
        assert.equal(usage.length, 2);
        console.log('PASS: query and extraction parse failures are accounted');
    }
    {
        const { act, usage } = await fixture([{ status: 502 }, { text: valid }], true);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 1);
        console.log('PASS: provider retry reports only the response with usage');
    }
    {
        const { act, usage } = await fixture([{ text: xml }, { text: valid }], true);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        console.log('PASS: default provider policy does not lose paid invalid responses');
    }
    {
        const { harness, usage } = await fixture([{ text: '{"answer":true}', outputTokens: 21 }, { text: '{"answer":false}', outputTokens: 22 }]);
        await Promise.all([harness.query(context, 'First?', z.object({ answer: z.boolean() })), harness.query(context, 'Second?', z.object({ answer: z.boolean() }))]);
        assert.equal(usage.length, 2);
        assert.deepEqual(usage.map(entry => entry.outputTokens).sort(), [21, 22]);
        console.log('PASS: concurrent calls do not duplicate usage');
    }
    for (const stopReason of ['refusal', 'max_tokens']) {
        const { act, usage } = await fixture([{ text: valid, stopReason }]);
        await assert.rejects(act(), ModelResponseError);
        assert.equal(requests.length, 1);
        assert.equal(usage.length, 1);
        console.log('PASS: terminal provider reason fails without executing or retrying a plan');
    }
    {
        const { harness, usage } = await fixture([{ text: '{"score":99}' }]);
        await assert.rejects(harness.query(context, 'Return a score.', z.object({ score: z.number().max(5) })));
        assert.equal(requests[0].output_config.format.schema.properties.score.maximum, undefined);
        assert.equal(usage.length, 1);
        console.log('PASS: local constraints still reject native-output responses with usage');
    }
    {
        const reply = { textFor: (request: any) => 'alpha' in request.output_config.format.schema.properties ? '{"alpha":"first"}' : '{"beta":2}' };
        const { harness, usage } = await fixture([reply, reply]);
        const responses = await Promise.all([
            harness.query(context, 'First shape.', z.object({ alpha: z.string() })),
            harness.query(context, 'Second shape.', z.object({ beta: z.number() })),
        ]);
        assert.deepEqual(responses, [{ alpha: 'first' }, { beta: 2 }]);
        assert.equal(usage.length, 2);
        console.log('PASS: concurrent native schemas remain isolated per invocation');
    }
} finally { server.stop(true); }
