import assert from 'node:assert/strict';
import { z } from 'zod';
import sharp from 'sharp';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import type { AgentContext } from '../../../packages/magnitude-core/src/ai/baml_client';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { Image } from '../../../packages/magnitude-core/src/memory/image';
import type { ModelUsage, OpenAIClient } from '../../../packages/magnitude-core/src/ai/types';
import { buildDefaultBrowserAgentOptions } from '../../../packages/magnitude-core/src/ai/util';
import { PlannerResponseError } from '../../../packages/magnitude-core/src/ai/plannerResponse';
import { ModelResponseError } from '../../../packages/magnitude-core/src/ai/modelResponseError';

// Real BAML Chat Completions transport, parser and collector; no external API.
const plan = { reasoning: 'Use the observed button.', actions: [{ variant: 'click', x: 12 }] };
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
        id: `fixture-${requests.length}`, object: 'chat.completion', created: 1, model: 'gpt-5.6-luna',
        choices: [{ index: 0, message: { role: 'assistant', content: reply.text, refusal: reply.refusal ?? null }, finish_reason: reply.finishReason ?? 'stop' }],
        usage: { prompt_tokens: reply.inputTokens ?? 100, completion_tokens: 20, total_tokens: (reply.inputTokens ?? 100) + 20,
            prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: reply.cacheWriteTokens ?? 0 }, completion_tokens_details: { reasoning_tokens: 15 } },
    });
} });
const context: AgentContext = { connectorInstructions: [], observationContent: [{ role: 'user', cacheControl: false, content: ['A button is visible at x=12.'] }] };
const vocabulary = [createAction({ name: 'click', schema: z.object({ x: z.number() }), resolver: async () => {} })];

async function fixture(sequence: Reply[], options: Partial<OpenAIClient['options']> = {}) {
    replies = [...sequence]; requests = [];
    const { agentOptions } = buildDefaultBrowserAgentOptions({ agentOptions: { llm: { provider: 'openai', options: {
        model: 'gpt-5.6-luna', apiKey: 'loopback-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, ...options,
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
        const { act, usage } = await fixture([{ text: valid }], { reasoningEffort: 'medium', maxCompletionTokens: 8192 });
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].model, 'gpt-5.6-luna');
        assert.equal(requests[0].reasoning_effort, 'medium');
        assert.equal(requests[0].max_completion_tokens, 8192);
        for (const key of ['temperature', 'max_tokens', 'output_config']) assert.ok(!(key in requests[0]), key);
        assert.deepEqual([usage[0].inputTokens, usage[0].outputTokens, usage[0].cacheReadInputTokens], [60, 20, 40]);
        assert.ok(Math.abs(usage[0].inputCost! - 0.0000128) < 1e-12);
        assert.ok(Math.abs(usage[0].outputCost! - 0.000024) < 1e-12);
        console.log('PASS: OpenAI actor options, strict plan and non-duplicated cached/reasoning usage');
    }
    {
        const { act, usage } = await fixture([{ text: valid, cacheWriteTokens: 30 }]);
        await act();
        assert.deepEqual([usage[0].inputTokens, usage[0].cacheWriteInputTokens, usage[0].cacheReadInputTokens], [30, 30, 40]);
        assert.ok(Math.abs(usage[0].inputCost! - (30 * 0.20 + 30 * 0.25 + 40 * 0.02) / 1e6) < 1e-12);
        console.log('PASS: cache writes use their own rate without double counting input');
    }
    for (const model of ['gpt-4.1', 'gpt-5.6-luna-custom']) {
        const { act, usage } = await fixture([{ text: valid }], { model });
        await act();
        assert.equal(usage[0].inputCost, undefined);
        console.log('PASS: unknown model or cache pricing is not silently estimated as free');
    }
    {
        const { act } = await fixture([{ text: valid }]);
        await act();
        for (const key of ['temperature', 'reasoning_effort', 'max_completion_tokens', 'max_tokens']) assert.ok(!(key in requests[0]), key);
        console.log('PASS: unspecified OpenAI options use API defaults');
    }
    {
        const { act } = await fixture([{ text: valid }], { reasoningEffort: 'none', temperature: 0.3 });
        await act();
        assert.equal(requests[0].temperature, 0.3);
        assert.equal(requests[0].reasoning_effort, 'none');
        console.log('PASS: explicit supported sampling options are preserved');
    }
    for (const inputTokens of [272_000, 272_001]) {
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
            const image = requests.at(-1).messages.flatMap((message: any) => message.content).find((part: any) => part.type === 'image_url');
            assert.ok(image.image_url.url.startsWith(`data:image/${format};base64,`));
            assert.equal((await sharp(Buffer.from(image.image_url.url.split(',')[1], 'base64')).metadata()).format, format);
        }
        console.log('PASS: screenshots reach OpenAI as valid image data URLs');
    }
    for (const rejected of [`Here is the plan: ${valid}`, '{"reasoning":"bad","actions":[]}']) {
        const { act, usage } = await fixture([{ text: rejected }, { text: valid }]);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        assert.match(JSON.stringify(requests[1]), /No actions were executed/);
        console.log('PASS: OpenAI format retry is bounded and both completions are counted');
    }
    {
        const { act, usage } = await fixture([{ text: 'invalid' }, { text: 'invalid' }]);
        await assert.rejects(act(), PlannerResponseError);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        console.log('PASS: invalid OpenAI plans exhaust after two attempts');
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
    {
        const { act, usage } = await fixture([{ text: valid }, { status: 400 }]);
        await act();
        await assert.rejects(act());
        assert.equal(usage.length, 1);
        console.log('PASS: OpenAI HTTP failure does not reuse previous usage');
    }
    {
        const { harness, usage } = await fixture([{ text: '{"score":99}' }]);
        await assert.rejects(harness.query(context, 'Return a score.', z.object({ score: z.number().max(5) })));
        assert.equal(usage.length, 1);
        console.log('PASS: OpenAI query keeps local schema validation and failed-call accounting');
    }
} finally { server.stop(true); }
