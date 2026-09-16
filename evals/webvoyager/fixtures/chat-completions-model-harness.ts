import assert from 'node:assert/strict';
import { z } from 'zod';
import sharp from 'sharp';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import type { AgentContext } from '../../../packages/magnitude-core/src/ai/baml_client';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { Image } from '../../../packages/magnitude-core/src/memory/image';
import type { ModelUsage, OpenAIClient, BasetenClient } from '../../../packages/magnitude-core/src/ai/types';
import { DEFAULT_BASETEN_MODEL } from '../../../packages/magnitude-core/src/ai/baseten';
import { buildDefaultBrowserAgentOptions } from '../../../packages/magnitude-core/src/ai/util';
import { PlannerResponseError } from '../../../packages/magnitude-core/src/ai/plannerResponse';
import { ModelResponseError } from '../../../packages/magnitude-core/src/ai/modelResponseError';
import { plannerRepairCases, rejectedValue } from './planner-repair-cases';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { Observation } from '../../../packages/magnitude-core/src/memory/observation';

// Real BAML Chat Completions transport, parser and collector; no external API.
const provider = process.argv[2] === 'baseten' ? 'baseten' : 'openai';
const model = provider === 'baseten' ? DEFAULT_BASETEN_MODEL : 'gpt-5.6-luna';
const inputRate = provider === 'baseten' ? 0.30 : 0.20;
const cachedRate = provider === 'baseten' ? 0.03 : 0.02;
const plan = { reasoning: 'Use the observed button.', memory_updates: [], actions: [{ variant: 'click', x: 12 }] };
const valid = JSON.stringify(plan);
type Reply = { text?: string | null; status?: number; finishReason?: string; refusal?: string; inputTokens?: number; cacheWriteTokens?: number };
let replies: Reply[] = [];
let requests: any[] = [];
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    assert.equal(new URL(request.url).pathname, '/v1/chat/completions');
    assert.equal(request.headers.get('authorization'), 'Bearer loopback-fixture');
    requests.push(await request.json());
    const reply = replies.shift();
    if (!reply) return new Response('Unexpected fixture request', { status: 400 });
    if (reply.status) return Response.json({ error: { message: 'Fixture error', type: 'invalid_request_error' } }, { status: reply.status });
    return Response.json({
        id: `fixture-${requests.length}`, object: 'chat.completion', created: 1, model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply.text, refusal: reply.refusal ?? null,
            // Reasoning must never be parsed as the final plan.
            ...(provider === 'baseten' ? { reasoning_content: 'Thinking about a plan: {"actions":[]}' } : {}),
        }, finish_reason: reply.finishReason ?? 'stop' }],
        usage: { prompt_tokens: reply.inputTokens ?? 100, completion_tokens: 20, total_tokens: (reply.inputTokens ?? 100) + 20,
            prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: reply.cacheWriteTokens ?? 0 }, completion_tokens_details: { reasoning_tokens: 15 } },
    });
} });
const screenshot = new Image(sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png());
const context: AgentContext = { connectorInstructions: [], observationContent: [{ role: 'user', cacheControl: true,
    content: ['A button is visible at x=12.', await screenshot.toBaml()] }] };
const vocabulary = [createAction({ name: 'click', schema: z.object({ x: z.number() }), resolver: async () => {} })];

async function fixture(sequence: Reply[], options: Partial<OpenAIClient['options'] & BasetenClient['options']> = {}) {
    replies = [...sequence]; requests = [];
    const { agentOptions } = buildDefaultBrowserAgentOptions({ agentOptions: { llm: { provider, options: {
        model, apiKey: 'loopback-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, ...options,
        ...(provider === 'baseten' ? { structuredOutputs: options.structuredOutputs ?? true } : {}),
    } } }, browserOptions: {} });
    assert.ok(!Array.isArray(agentOptions.llm) || agentOptions.llm.length === 1);
    const llm = Array.isArray(agentOptions.llm) ? agentOptions.llm[0] : agentOptions.llm!;
    const harness = new ModelHarness({ llm });
    await harness.setup();
    const usage: ModelUsage[] = [];
    harness.events.on('tokensUsed', entry => { usage.push(entry); return {}; });
    return { harness, usage, act: () => harness.partialAct(context, 'Click the button.', [], vocabulary) };
}

try {
    {
        const reasoningEffort = provider === 'baseten' ? 'high' : 'medium';
        const tokenKey = provider === 'baseten' ? 'max_tokens' : 'max_completion_tokens';
        const { act, usage } = await fixture([{ text: valid }], { reasoningEffort,
            ...(provider === 'baseten' ? { maxTokens: 8192 } : { maxCompletionTokens: 8192 }) });
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].model, model);
        assert.equal(requests[0].reasoning_effort, reasoningEffort);
        assert.equal(requests[0][tokenKey], 8192);
        if (provider === 'baseten') {
            const format = requests[0].response_format;
            assert.equal(format.type, 'json_schema');
            assert.equal(format.json_schema.strict, true);
            const schema = format.json_schema.schema;
            assert.deepEqual(schema.required, ['reasoning', 'memory_updates', 'actions']);
            assert.deepEqual(schema.properties.memory_updates.items.required, ['key', 'text', 'sources', 'operation', 'expected_text']);
            assert.deepEqual(schema.properties.memory_updates.items.properties.operation.enum, ['add', 'correct']);
            assert.deepEqual(schema.properties.memory_updates.items.properties.expected_text.anyOf.map((s: any) => s.type), ['string', 'null']);
            assert.equal(schema.properties.memory_updates.items.properties.sources.items.type, 'integer');
            assert.equal(schema.properties.actions.items.properties.variant.const, 'click');
            assert.equal(schema.additionalProperties, false);
        } else assert.equal(requests[0].response_format, undefined);
        const image = requests[0].messages.flatMap((message: any) => message.content).find((part: any) => part.type === 'image_url');
        assert.ok(image.image_url.url.startsWith('data:image/png;base64,'));
        for (const key of ['temperature', provider === 'baseten' ? 'max_completion_tokens' : 'max_tokens', 'output_config']) assert.ok(!(key in requests[0]), key);
        assert.deepEqual(usage[0].llm, { provider, model });
        assert.deepEqual([usage[0].inputTokens, usage[0].outputTokens, usage[0].cacheReadInputTokens], [60, 20, 40]);
        assert.ok(Math.abs(usage[0].inputCost! - (60 * inputRate + 40 * cachedRate) / 1e6) < 1e-12);
        assert.ok(Math.abs(usage[0].outputCost! - 0.000024) < 1e-12);
        console.log(`PASS: ${provider} actor options, strict plan and non-duplicated cached/reasoning usage`);
    }
    if (provider === 'baseten') {
        const { act } = await fixture([{ text: valid }], { structuredOutputs: false });
        await act();
        assert.equal(requests[0].response_format, undefined);
        assert.equal(requests[0].structuredOutputs, undefined);
        console.log('PASS: Baseten native output can be disabled without leaking the SDK option');
    }
    if (provider === 'openai') {
        const { act, usage } = await fixture([{ text: valid, cacheWriteTokens: 30 }]);
        await act();
        assert.deepEqual([usage[0].inputTokens, usage[0].cacheWriteInputTokens, usage[0].cacheReadInputTokens], [30, 30, 40]);
        assert.ok(Math.abs(usage[0].inputCost! - (30 * 0.20 + 30 * 0.25 + 40 * 0.02) / 1e6) < 1e-12);
        console.log('PASS: cache writes use their own rate without double counting input');
    }
    for (const unknown of ['gpt-4.1', `${model}-custom`]) {
        const { act, usage } = await fixture([{ text: valid }], { model: unknown });
        await act();
        assert.equal(usage[0].inputCost, undefined);
        if (provider === 'baseten') assert.equal(usage[0].outputCost, undefined);
        console.log('PASS: unknown model or cache pricing is not silently estimated as free');
    }
    {
        const { act } = await fixture([{ text: valid }]);
        await act();
        for (const key of ['temperature', 'reasoning_effort', 'max_completion_tokens', 'max_tokens']) assert.ok(!(key in requests[0]), key);
        console.log(`PASS: unspecified ${provider} options use API defaults`);
    }
    {
        const { act } = await fixture([{ text: valid }], { reasoningEffort: 'none', temperature: 0.3 });
        await act();
        assert.equal(requests[0].temperature, 0.3);
        assert.equal(requests[0].reasoning_effort, 'none');
        console.log('PASS: explicit supported sampling options are preserved');
    }
    for (const inputTokens of (provider === 'openai' ? [272_000, 272_001] : [])) {
        const { act, usage } = await fixture([{ text: valid, inputTokens }]);
        await act();
        const multiplier = inputTokens > 272_000 ? 2 : 1;
        assert.ok(Math.abs(usage[0].inputCost! - ((inputTokens - 40) * 0.20 + 40 * 0.02) / 1e6 * multiplier) < 1e-12);
        assert.ok(Math.abs(usage[0].outputCost! - 20 * 1.20 / 1e6 * (multiplier === 2 ? 1.5 : 1)) < 1e-12);
        console.log('PASS: Luna pricing accounts for the full-request long-context threshold');
    }
    {
        const { harness } = await fixture([{ text: '{"answer":true}' }, { text: '{"answer":true}' }]);
        for (const format of ['png', 'jpeg'] as const) {
            const screenshot = new Image(sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).toFormat(format));
            assert.deepEqual(await harness.extract('Answer?', z.object({ answer: z.boolean() }), screenshot, '<p>Fixture</p>'), { answer: true });
            if (provider === 'baseten') assert.deepEqual(requests.at(-1).response_format.json_schema.schema.required, ['answer']);
            const image = requests.at(-1).messages.flatMap((message: any) => message.content).find((part: any) => part.type === 'image_url');
            assert.ok(image.image_url.url.startsWith(`data:image/${format};base64,`));
            assert.equal((await sharp(Buffer.from(image.image_url.url.split(',')[1], 'base64')).metadata()).format, format);
        }
        console.log(`PASS: screenshots reach ${provider} as valid image data URLs`);
    }
    for (const rejected of [`Here is the plan: ${valid}`, '{"reasoning":"bad","actions":[]}', JSON.stringify({ reasoning: plan.reasoning, actions: plan.actions })]) {
        const { act, usage } = await fixture([{ text: rejected }, { text: valid }]);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        assert.match(JSON.stringify(requests[1]), /No actions were executed/);
        if (provider === 'baseten') assert.deepEqual(requests[1].response_format, requests[0].response_format);
        console.log(`PASS: ${provider} format retry is bounded and both completions are counted`);
    }
    {
        const { act, usage } = await fixture([{ text: 'invalid' }, { text: JSON.stringify(plannerRepairCases[0].value) }]);
        await assert.rejects(act(), error => error instanceof PlannerResponseError
            && error.message.includes('invalid plan on both attempts') && error.diagnostic === plannerRepairCases[0].diagnostic);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        console.log(`PASS: invalid ${provider} plans exhaust after two attempts`);
    }
    for (const { value, diagnostic } of plannerRepairCases) {
        const { act, usage } = await fixture([{ text: JSON.stringify(value) }, { text: valid }]);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        const content = requests[1].messages.at(-1).content;
        const repair = typeof content === 'string' ? content : content.map((part: any) => part.text ?? '').join('');
        assert.ok(repair.includes(diagnostic), repair);
        assert.ok(!repair.includes(rejectedValue));
        assert.ok(repair.length < 1600);
        assert.equal(context.observationContent.length, 1);
        console.log(`PASS: ${provider} retry receives bounded field-level diagnostics without rejected values`);
    }
    {
        const note = { key: 'record', text: 'Visible fact.', sources: [0], operation: 'add', expected_text: null };
        const repaired = { ...plan, actions: [{ variant: 'finish' }] };
        const { harness, usage } = await fixture([
            { text: JSON.stringify({ ...plan, memory_updates: [note], actions: [{ variant: 'finish' }, { variant: 'click', x: rejectedValue }] }) },
            { text: JSON.stringify(repaired) },
        ]);
        let finishes = 0;
        const agent = new Agent({ telemetry: false, maxActions: 1,
            llm: { provider, options: { model, apiKey: 'unused' } },
            connectors: [{ id: 'fixture', collectObservations: async () => [Observation.fromConnector('fixture', 'Visible fact.')] }],
            actions: [...vocabulary, createAction({ name: 'finish', resolver: async ({ agent }) => { finishes++; await agent.queueDone(); } })],
        });
        agent.models.partialAct = harness.partialAct.bind(harness);
        await agent.act('Complete the observed task.');
        const memory = await agent.memory.toJSON();
        assert.equal(finishes, 1);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        assert.equal(memory.notes, undefined);
        assert.equal(memory.observations.filter(o => o.source.startsWith('action:taken:')).length, 1);
        assert.ok(!JSON.stringify(memory).includes(rejectedValue));
        console.log('PASS: invalid whole plans execute neither valid leading notes nor actions before repair');
    }
    for (const reply of [
        { text: valid, finishReason: 'length' }, { text: '{', finishReason: 'length' },
        { text: valid, finishReason: 'content_filter' }, { text: null, refusal: 'Fixture refusal' },
    ]) {
        const { act, usage } = await fixture([reply]);
        await assert.rejects(act(), ModelResponseError);
        assert.equal(requests.length, 1);
        assert.equal(usage.length, 1);
        console.log('PASS: refusal or truncation never executes or retries a partial plan');
    }
    for (const status of (provider === 'baseten' ? [429, 529] : [])) {
        const { act, usage } = await fixture([{ status }, { text: valid }]);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 1);
        console.log(`PASS: Baseten ${status} retries use the existing policy without phantom usage`);
    }
    {
        const { act, usage } = await fixture([{ text: valid }, { status: 400 }]);
        await act();
        await assert.rejects(act());
        assert.equal(usage.length, 1);
        if (provider === 'baseten') {
            assert.ok(requests.every(request => request.response_format?.json_schema?.strict === true));
            assert.equal(requests.length, 7, 'the existing provider retry budget is unchanged; no retry drops the schema');
        }
        console.log(`PASS: ${provider} HTTP failure does not reuse previous usage`);
    }
    {
        const { harness, usage } = await fixture([{ text: '{"score":99}' }]);
        await assert.rejects(harness.query(context, 'Return a score.', z.object({ score: z.number().max(5) })));
        if (provider === 'baseten') assert.deepEqual(requests[0].response_format.json_schema.schema.required, ['score']);
        assert.equal(usage.length, 1);
        console.log(`PASS: ${provider} query keeps local schema validation and failed-call accounting`);
    }
    if (provider === 'baseten') {
        for (const { schema, value, expected } of [
            { schema: z.string(), value: 'observed', expected: 'observed' },
            { schema: z.array(z.number()), value: [1, 2], expected: [1, 2] },
            { schema: z.string().transform(value => value.toUpperCase()), value: 'observed', expected: 'OBSERVED' },
        ]) {
            const { harness } = await fixture([{ text: JSON.stringify({ data: value }) }, { text: JSON.stringify({ data: value }) }]);
            assert.deepEqual(await harness.query(context, 'Read the value.', schema), expected);
            assert.deepEqual(await harness.extract('Read the value.', schema, screenshot, '<p>Fixture</p>'), expected);
            assert.ok(requests.every(request => request.response_format.json_schema.schema.required.includes('data')));
        }
        console.log('PASS: Baseten query and extraction wrap primitive, array and transformed schemas without changing results');
    }
    if (provider === 'baseten') {
        const value = { field: 'observed' };
        const schema = z.object({ field: z.string() }).passthrough();
        const { harness } = await fixture([{ text: JSON.stringify(value) }]);
        assert.deepEqual(await harness.query(context, 'Read the record.', schema), value);
        assert.equal(requests[0].response_format, undefined);
        console.log('PASS: unsupported Baseten schemas retain the existing prompt-only path');
    }
} finally { server.stop(true); }
