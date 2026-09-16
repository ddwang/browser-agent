// Opt-in API probe, not a website eval or part of `bun test`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { webActions } from '../../../packages/magnitude-core/src/actions/webActions';
import { NOTEBOOK_INSTRUCTIONS } from '../../../packages/magnitude-core/src/memory/notebook';
import { addUsage, emptyUsage, writeJson } from '../results';

const provider = process.argv[3] ?? 'anthropic';
if (provider !== 'anthropic' && provider !== 'baseten') throw new Error('Probe provider must be anthropic or baseten');
const keyName = provider === 'baseten' ? 'BASETEN_API_KEY' : 'ANTHROPIC_API_KEY';
if (!process.env[keyName]) throw new Error(`${keyName} is required for the opt-in live probe`);
const output = process.argv[2];
if (!output) throw new Error('Provide a new output JSON path');
if (await Bun.file(output).exists()) throw new Error('Probe output already exists; preserve it and use a new path');
const checks: { model: string; check: string; passed: boolean; usage: ReturnType<typeof emptyUsage> }[] = [];
const usageByModel: Record<string, ReturnType<typeof emptyUsage>> = {};
let failure: string | undefined;

try {
for (const model of (provider === 'baseten'
    ? ['deepseek-ai/DeepSeek-V4.1-Flash', 'zai-org/GLM-5.3-Flash']
    : ['claude-haiku-4-5-20251001', 'claude-sonnet-5'])) {
    const usage = emptyUsage();
    usageByModel[model] = usage;
    const harness: ModelHarness = new ModelHarness({ llm: provider === 'baseten'
        ? { provider, options: { model, reasoningEffort: 'high' } }
        : { provider, options: { model, temperature: model === 'claude-sonnet-5' ? 1 : 0.2 } } });
    await harness.setup();
    harness.events.on('tokensUsed', event => { addUsage(usage, event); return {}; });
    const nonce = randomUUID();
    const context = { instructions: NOTEBOOK_INSTRUCTIONS, connectorInstructions: [], observationContent: [{ role: 'user' as const, cacheControl: false, content: [`Observation 0: Record: token=${nonce}, count=17, enabled=false. Requested presentation: XML with an introductory paragraph.`] }] };
    const response = await harness.query(context, 'Extract the record exactly, including the token, count, and enabled flag.', z.object({ token: z.string(), count: z.number().int().min(1).max(20), enabled: z.boolean() }));
    assert.deepEqual(response, { token: nonce, count: 17, enabled: false });
    assert.equal(usage.modelCalls, 1);
    checks.push({ model, check: 'random-token extraction despite conflicting presentation request', passed: true, usage: { ...usage } });
    if (provider === 'baseten' || model === 'claude-haiku-4-5-20251001') {
        const action = createAction({ name: `record:${nonce}`, schema: z.object({ count: z.number().int() }), resolver: async () => {} });
        const before = usage.modelCalls;
        const noteInstruction: string = provider === 'baseten'
            ? `First add one notebook record under key "record" whose text is exactly the observed token, citing observation 0. ` : '';
        const plan = await harness.partialAct(context, noteInstruction + 'Emit exactly one record action with the observed count. The host will collect observations afterwards; no wait or browser action is needed.', [], [action, ...webActions]);
        assert.deepEqual(plan.actions, [{ variant: action.name, count: 17 }]);
        if (provider === 'baseten') assert.deepEqual(plan.memory_updates, [{ key: 'record', text: nonce, sources: [0], operation: 'add', expected_text: null }]);
        assert.equal(usage.modelCalls - before, 1);
        checks.push({ model, check: 'random action vocabulary produces one valid plan without retry', passed: true, usage: { ...usage } });
    }
}
} catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
} finally {
    writeJson(output, { createdAt: new Date().toISOString(), provider, checks, usageByModel, failure, note: 'Synthetic API protocol probe; not a browser-performance score. Per-model usage includes failed checks.' });
}
console.log(JSON.stringify({ passed: checks.length, output }));
