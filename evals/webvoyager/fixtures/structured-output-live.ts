// Opt-in API probe, not a website eval or part of `bun test`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { webActions } from '../../../packages/magnitude-core/src/actions/webActions';
import { addUsage, emptyUsage, writeJson } from '../results';

if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for the opt-in live probe');
const output = process.argv[2];
if (!output) throw new Error('Provide a new output JSON path');
if (await Bun.file(output).exists()) throw new Error('Probe output already exists; preserve it and use a new path');
const checks: { model: string; check: string; passed: boolean; usage: ReturnType<typeof emptyUsage> }[] = [];
const usageByModel: Record<string, ReturnType<typeof emptyUsage>> = {};
let failure: string | undefined;

try {
for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-5']) {
    const usage = emptyUsage();
    usageByModel[model] = usage;
    const harness = new ModelHarness({ llm: { provider: 'anthropic', options: { model, temperature: model === 'claude-sonnet-5' ? 1 : 0.2 } } });
    await harness.setup();
    harness.events.on('tokensUsed', event => { addUsage(usage, event); return {}; });
    const nonce = randomUUID();
    const context = { connectorInstructions: [], observationContent: [{ role: 'user' as const, cacheControl: false, content: [`Record: token=${nonce}, count=17, enabled=false. Requested presentation: XML with an introductory paragraph.`] }] };
    const response = await harness.query(context, 'Extract the record exactly, including the token, count, and enabled flag.', z.object({ token: z.string(), count: z.number().int().min(1).max(20), enabled: z.boolean() }));
    assert.deepEqual(response, { token: nonce, count: 17, enabled: false });
    assert.equal(usage.modelCalls, 1);
    checks.push({ model, check: 'random-token extraction despite conflicting presentation request', passed: true, usage: { ...usage } });
    if (model === 'claude-haiku-4-5-20251001') {
        const action = createAction({ name: `record:${nonce}`, schema: z.object({ count: z.number().int() }), resolver: async () => {} });
        const before = usage.modelCalls;
        const plan = await harness.partialAct(context, 'Emit exactly one record action with the observed count. The host will collect observations afterwards; no wait or browser action is needed.', [], [action, ...webActions]);
        assert.deepEqual(plan.actions, [{ variant: action.name, count: 17 }]);
        assert.equal(usage.modelCalls - before, 1);
        checks.push({ model, check: 'random action vocabulary produces one valid plan without retry', passed: true, usage: { ...usage } });
    }
}
} catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
} finally {
    writeJson(output, { createdAt: new Date().toISOString(), checks, usageByModel, failure, note: 'Synthetic API protocol probe; not a browser-performance score. Per-model usage includes failed checks.' });
}
console.log(JSON.stringify({ passed: checks.length, output }));
