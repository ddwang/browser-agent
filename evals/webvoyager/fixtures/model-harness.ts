import assert from 'node:assert/strict';
import { ClientRegistry } from '@boundaryml/baml';
import { z } from 'zod';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import { b, type AgentContext } from '../../../packages/magnitude-core/src/ai/baml_client';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { Image } from '../../../packages/magnitude-core/src/memory/image';
import type { ModelUsage } from '../../../packages/magnitude-core/src/ai/types';
import { PlannerResponseError } from '../../../packages/magnitude-core/src/ai/plannerResponse';

// Exercise the actual BAML parser and collector without external model calls.
const plan = { reasoning: 'Click the visible button.', actions: [{ variant: 'click', x: 12 }] };
const valid = JSON.stringify(plan);
const xml = '<function_calls><invoke name="web_action"><parameter name="reasoning">Click</parameter><parameter name="actions">[{"variant":"click","x":12}]</parameter></invoke></function_calls>';
type Reply = { text?: string; status?: number; outputTokens?: number };
let replies: Reply[] = [];
let requests: any[] = [];
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    requests.push(await request.json());
    const reply = replies.shift();
    if (!reply) return new Response('Unexpected fixture request', { status: 400 });
    if (reply.status) return new Response('Fixture HTTP error', { status: reply.status });
    return Response.json({
        id: `fixture-${requests.length}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: reply.text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: reply.outputTokens ?? 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
    });
} });
const context: AgentContext = { connectorInstructions: [], observationContent: [{ role: 'user', cacheControl: false, content: ['A button is visible at x=12.'] }] };
const vocabulary = [createAction({ name: 'click', schema: z.object({ x: z.number() }), resolver: async () => {} })];

async function fixture(sequence: Reply[], providerRetry = false) {
    replies = [...sequence]; requests = [];
    const harness = new ModelHarness({ llm: { provider: 'anthropic', options: { model: 'claude-haiku-4-5-20251001', apiKey: 'loopback-fixture' } } });
    await harness.setup();
    const registry = new ClientRegistry();
    registry.addLlmClient('Fixture', 'anthropic', {
        model: 'claude-haiku-4-5-20251001', api_key: 'loopback-fixture', base_url: `http://127.0.0.1:${server.port}`,
    }, providerRetry ? 'DefaultRetryPolicy' : undefined);
    registry.setPrimary('Fixture');
    // Override only the transport; production option conversion is unchanged.
    (harness as unknown as { baml: typeof b }).baml = b.withOptions({ clientRegistry: registry });
    const usage: ModelUsage[] = [];
    harness.events.on('tokensUsed', entry => { usage.push(entry); return {}; });
    const act = () => harness.partialAct(context, 'Click the button.', [], vocabulary);
    return { harness, usage, act };
}

try {
    {
        const { act, usage } = await fixture([{ text: valid }]);
        assert.deepEqual(await act(), plan);
        assert.equal(requests.length, 1);
        assert.match(JSON.stringify(requests[0]), /Return exactly one complete JSON object/);
        assert.equal(usage.length, 1);
        assert.deepEqual([usage[0].inputTokens, usage[0].outputTokens, usage[0].cacheWriteInputTokens, usage[0].cacheReadInputTokens], [10, 20, 30, 40]);
        assert.ok(Math.abs(usage[0].inputCost! - 0.0000515) < 1e-12);
        assert.equal(usage[0].outputCost, 0.0001);
        console.log('PASS: valid plan and exact cached usage');
    }
    for (const rejected of [xml, `Here is the plan: ${valid}`]) {
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
        await assert.rejects(act(), PlannerResponseError);
        assert.equal(requests.length, 2);
        assert.equal(usage.length, 2);
        console.log('PASS: invalid plans fail after two attempts');
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
} finally { server.stop(true); }
