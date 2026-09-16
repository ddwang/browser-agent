// Preload only in an isolated test process; the real probe makes no API calls.
import assert from 'node:assert/strict';
import { ModelHarness } from '../../../packages/magnitude-core/src/ai/modelHarness';
import type { AgentContext } from '../../../packages/magnitude-core/src/ai/baml_client';
import { NOTEBOOK_INSTRUCTIONS } from '../../../packages/magnitude-core/src/memory/notebook';

const records = new WeakMap<ModelHarness, { context: AgentContext; token: string }>();
const usage = { llm: { provider: 'fixture', model: 'fixture' }, inputTokens: 1, outputTokens: 1 };
ModelHarness.prototype.setup = async () => {};
ModelHarness.prototype.query = async function (context, _query, schema) {
    assert.equal(context.instructions, undefined, 'Query must not receive the planner notebook contract');
    assert.deepEqual(context.connectorInstructions, []);
    const match = JSON.stringify(context.observationContent).match(/token=([^,]+)/);
    assert.ok(match);
    records.set(this, { context, token: match[1] });
    this.events.emit('tokensUsed', usage);
    return schema.parse({ token: match[1], count: 17, enabled: false });
};
ModelHarness.prototype.partialAct = async function (context, _task, _data, vocabulary) {
    const record = records.get(this);
    assert.ok(record);
    assert.notEqual(context, record.context, 'Planner must receive a separate context');
    assert.equal(record.context.instructions, undefined, 'Planner setup must not mutate the query context');
    assert.equal(context.instructions, NOTEBOOK_INSTRUCTIONS);
    assert.equal(context.observationContent, record.context.observationContent);
    assert.equal(context.connectorInstructions, record.context.connectorInstructions);
    this.events.emit('tokensUsed', usage);
    return {
        reasoning: 'Record the observed value.',
        actions: [{ variant: vocabulary[0].name, count: 17 }],
        memory_updates: process.argv[3] === 'baseten'
            ? [{ key: 'record', text: record.token, sources: [0], operation: 'add', expected_text: null }] : [],
    };
};
