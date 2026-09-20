import assert from 'node:assert/strict';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { AgentMemory } from '../../../packages/magnitude-core/src/memory/agentMemory';
import { Observation } from '../../../packages/magnitude-core/src/memory/observation';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { ActionLimitError, OperationCancelledError } from '../../../packages/magnitude-core/src/agent/errors';
import type { LLMClient } from '../../../packages/magnitude-core/src/ai/types';
import { BrowserRecovery } from '../../../packages/magnitude-core/src/web/recovery';
import { taskActions } from '../../../packages/magnitude-core/src/actions/taskActions';
import z from 'zod';

const llm = { provider: 'anthropic' as const, options: { model: 'fixture', apiKey: 'unused-no-model-calls' } };
const note = { variant: 'memory:note', key: 'record', text: 'Observed value: 437.', sources: [0], operation: 'add' as const, expected_text: null };
const { variant, ...update } = note;
let observations = 0;
let hooks = 0;
const recovery = new BrowserRecovery({ noProgress: true });
for (let i = 0; i < 6; i++) recovery.observe('unchanged', { variant: 'mouse:click' }, undefined);
const connector = {
    id: 'fixture',
    beforeAction: async () => { hooks++; throw new Error('Browser hook must not run for notebook actions'); },
    collectObservations: async () => {
        observations++;
        return [Observation.fromConnector('fixture', { url: 'https://fixture.invalid/item?q=unique', value: 437 })];
    },
};

{
    for (const { agentPrompt, callPrompt, expected } of [
        { agentPrompt: undefined, callPrompt: undefined, expected: 'Saved constraint' },
        { agentPrompt: null, callPrompt: undefined, expected: 'Saved constraint' },
        { agentPrompt: 'Current policy', callPrompt: undefined, expected: 'Current policy' },
        { agentPrompt: undefined, callPrompt: 'Current task constraint', expected: 'Current task constraint' },
        { agentPrompt: 'Current policy', callPrompt: 'Current task constraint', expected: 'Current policy\nCurrent task constraint' },
        { agentPrompt: undefined, callPrompt: '', expected: null },
        { agentPrompt: '', callPrompt: undefined, expected: null },
    ]) {
        const original = new AgentMemory({ instructions: 'Saved constraint' });
        original.recordObservation(Observation.fromConnector('fixture', 'Checkpoint evidence'));
        await original.render();
        original.remember({ key: 'checkpoint', text: 'A recorded fact', sources: [0] });
        const restored = new AgentMemory();
        await restored.loadJSON(JSON.parse(JSON.stringify(await original.toJSON())));
        const agent = new Agent({ llm, telemetry: false, prompt: agentPrompt });
        let plans = 0;
        agent.models.partialAct = async context => {
            plans++;
            assert.equal(context.instructions, expected);
            assert.match(JSON.stringify(context.observationContent), /Checkpoint evidence/);
            assert.match(JSON.stringify(context.observationContent), /A recorded fact/);
            return { reasoning: 'Read saved context.', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Fixture complete' }] };
        };
        await agent.act(['Resume', 'Continue'], { memory: restored, prompt: callPrompt });
        await agent.act('Continue again', { memory: restored, prompt: callPrompt });
        assert.equal(plans, 3);
        assert.equal(agent.memory, restored);
        assert.equal((await restored.toJSON()).instructions, expected ?? undefined);
        agent.models.query = async context => {
            assert.equal(context.instructions, expected);
            return 'verified';
        };
        assert.equal(await agent.query('Inspect effective instructions', z.string()), 'verified');
        await agent.stop();
    }
    console.log('PASS: restored instructions survive resume unless current prompts replace them, without repeated accumulation');
}

{
    const memory = new AgentMemory({ instructions: 'Saved constraint', promptCaching: true });
    memory.recordObservation(Observation.fromConnector('fixture', 'Old state', { type: 'state', limit: 1 }));
    await memory.render();
    memory.recordObservation(Observation.fromConnector('fixture', 'New state', { type: 'state', limit: 1 }));
    const agent = new Agent({ telemetry: false, prompt: 'Current constraint',
        llm: { provider: 'anthropic', options: { model: 'claude-fixture', apiKey: 'unused' } },
    });
    agent.models.partialAct = async context => {
        assert.equal(context.instructions, 'Current constraint');
        assert.ok(!JSON.stringify(context.observationContent).includes('Old state'));
        assert.ok(JSON.stringify(context.observationContent).includes('New state'));
        assert.ok(context.observationContent.some(message => message.cacheControl));
        return { reasoning: 'Read current context.', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Fixture complete' }] };
    };
    await agent.act('Continue', { memory });
    await agent.stop();
    console.log('PASS: changing the receiving agent prompt rebuilds frozen retention without disabling caching');
}

{
    const memory = new AgentMemory({ instructions: 'Saved constraint', promptCaching: true });
    memory.recordObservation(Observation.fromConnector('fixture', 'Saved evidence'));
    await memory.render();
    const configurations: { client: LLMClient; caching: boolean }[] = [
        { client: { provider: 'openai', options: { model: 'fixture', apiKey: 'unused' } }, caching: false },
        { client: { provider: 'anthropic', options: { model: 'claude-fixture', apiKey: 'unused' } }, caching: true },
        { client: { provider: 'anthropic', options: { model: 'claude-fixture', apiKey: 'unused', promptCaching: false } }, caching: false },
        { client: { provider: 'claude-code', options: { model: 'claude-fixture' } }, caching: true },
        { client: { provider: 'baseten', options: { model: 'fixture', apiKey: 'unused' } }, caching: false },
    ];
    for (const { client, caching } of configurations) {
        const agent = new Agent({ llm: client, telemetry: false });
        agent.models.partialAct = async context => {
            assert.equal(context.instructions, 'Saved constraint');
            assert.equal(context.observationContent.some(message => message.cacheControl), caching);
            return { reasoning: 'Read saved context.', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Fixture complete' }] };
        };
        await agent.act('Continue', { memory });
        await agent.stop();
    }
    console.log('PASS: supplied memory adopts each receiving agent runtime caching policy, including explicit opt-out');
}

{
    const memory = new AgentMemory({ instructions: 'Saved constraint', promptCaching: true });
    memory.recordObservation(Observation.fromConnector('fixture', 'Saved evidence'));
    const saved = await memory.toJSON();
    const controller = new AbortController();
    controller.abort();
    const agent = new Agent({ llm, telemetry: false, prompt: 'Must not be applied' });
    await assert.rejects(agent.act('Cancelled before adoption', { memory, signal: controller.signal }), OperationCancelledError);
    assert.deepEqual(await memory.toJSON(), saved);
    assert.ok((await memory.render()).some(message => message.cacheControl));
    await agent.stop();
    console.log('PASS: pre-cancelled operations do not reconfigure supplied memory');
}

{
    const agent = new Agent({ llm, connectors: [connector], actions: [], telemetry: false });
    for (const observation of await connector.collectObservations()) agent.memory.recordObservation(observation);
    await agent.memory.render();
    let checkpoints = 0;
    agent.events.on('observationsRecorded', () => { checkpoints++; });
    await agent.exec(note, agent.memory);
    assert.equal(observations, 1);
    assert.equal(hooks, 0);
    assert.equal(checkpoints, 1);
    assert.throws(() => recovery.check(), /no_progress|repeated|previously/);
    assert.equal((await agent.memory.toJSON()).notes?.[0].text, note.text);
    for (const invalid of [
        { ...note, text: 'A different record' },
        { ...note, expected_text: note.text },
        { ...note, operation: 'correct', expected_text: null },
        { ...note, operation: 'correct', expected_text: 'Stale text' },
        { ...note, operation: 'correct', expected_text: note.text, sources: [900] },
    ]) {
        const result = await agent.exec(invalid, agent.memory) as { saved: unknown };
        assert.equal(result.saved, false);
        assert.equal((await agent.memory.toJSON()).notes?.[0].text, note.text);
    }
    const saved = await agent.memory.toJSON();
    assert.equal(saved.notes?.[0].text, note.text);
    assert.match(JSON.stringify(saved.observations.at(-1)), /No notes changed/);
    await agent.exec({ variant: 'memory:forget', key: 'record' }, agent.memory);
    assert.equal((await agent.memory.toJSON()).notes, undefined);
    const rendered = JSON.stringify(await agent.memory.render());
    assert.ok(!rendered.includes(note.text), 'obsolete note action payloads must not leak into actor context');
    assert.ok((await agent.memory.simpleRender()).join('').includes(note.text), 'full audit history remains available');
    console.log('PASS: custom action vocabularies retain notebook actions, checkpoints, bounded failures, and audit history without browser hooks');
}

{
    const agent = new Agent({ llm, connectors: [connector], telemetry: false });
    const separate = new AgentMemory();
    separate.recordObservation(Observation.fromConnector('fixture', 'Observed value: 437.'));
    await separate.render();
    await agent.exec(note, separate);
    assert.equal((await separate.toJSON()).notes?.length, 1);
    assert.equal((await agent.memory.toJSON()).notes, undefined);
    console.log('PASS: exec writes to the explicitly supplied task memory');
}

{
    let calls = 0;
    const agent = new Agent({ llm, connectors: [connector], maxActions: 2, telemetry: false });
    agent.models.partialAct = async () => { calls++; return { reasoning: 'Record visible values.', memory_updates: [update, update, update], actions: [{ variant: 'task:done', evidence: 'Not reached' }] }; };
    await assert.rejects(agent.act('Synthetic bounded notes'), ActionLimitError);
    assert.equal(calls, 1);
    assert.equal((await agent.memory.toJSON()).observations.filter(o => o.source === 'action:taken:memory:note').length, 2);
    assert.equal(hooks, 0);
    console.log('PASS: notebook actions consume the existing action budget');
}

{
    const agent = new Agent({ llm, telemetry: false, connectors: [{ id: 'fixture', collectObservations: connector.collectObservations }] });
    let task = 0;
    agent.models.partialAct = async context => {
        assert.match(JSON.stringify(context.connectorInstructions), /memory:note/);
        assert.ok(!JSON.stringify(context.observationContent).includes('Observed value: 437.'), 'fresh task must not inherit previous task notes');
        task++;
        return { reasoning: 'Save and finish.', memory_updates: [update], actions: [{ variant: 'task:done', evidence: 'Synthetic fixture complete' }] };
    };
    await agent.act('First task');
    assert.equal((await agent.memory.toJSON()).notes?.length, 1);
    await agent.act('Second task');
    assert.equal(task, 2);
    console.log('PASS: notebook state is isolated between act calls');
}

{
    const agent = new Agent({ llm, telemetry: false, connectors: [{ id: 'fixture',
        getInstructions: async () => 'Fixture instructions', collectObservations: connector.collectObservations }] });
    agent.models.partialAct = async context => {
        assert.match(JSON.stringify(context.connectorInstructions), /memory_updates/);
        return { reasoning: 'Save and finish.', memory_updates: [update], actions: [{ variant: 'task:done', evidence: 'Complete' }] };
    };
    await agent.act('Retain evidence');
    agent.models.query = async context => {
        assert.deepEqual(context.connectorInstructions, [{ connectorId: 'fixture', instructions: 'Fixture instructions' }]);
        assert.match(JSON.stringify(context.observationContent), /Observed value: 437/);
        return 'observed';
    };
    assert.equal(await agent.query('Read saved data', z.string()), 'observed');
    assert.equal(await agent.query('Read full audit', z.string(), { history: 'full' }), 'observed');
    console.log('PASS: query contexts retain notebook data and connector instructions without planner-only commands');
}

{
    assert.throws(() => new Agent({ llm, telemetry: false, actions: [createAction({ name: 'memory:note', resolver: async () => {} })] }), /reserved/);
    console.log('PASS: reserved notebook action names cannot be shadowed');
}

{
    let captures = 0;
    const order: string[] = [];
    const agent = new Agent({ llm, telemetry: false, maxActions: 3,
        connectors: [{ id: 'fixture', collectObservations: async () => {
            captures++;
            return [Observation.fromConnector('fixture', 'Observed value: 437.')];
        } }],
        actions: [...taskActions, createAction({ name: 'leave', resolver: async ({ memory }) => {
            assert.equal((await memory!.toJSON()).notes?.[0].text, update.text);
            assert.equal(captures, 1, 'notes must not capture a new observation');
        } })],
    });
    agent.events.on('actionDone', action => { order.push(action.variant); });
    agent.models.partialAct = async () => ({ reasoning: 'Retain evidence first.', memory_updates: [update],
        actions: [{ variant: 'leave' }, { variant: 'task:done', evidence: 'Complete' }] });
    await agent.act('Save before leaving');
    assert.deepEqual(order, ['memory:note', 'leave', 'task:done']);
    console.log('PASS: required updates are saved before navigation and count once on the final allowed batch');
}

{
    let plans = 0;
    let leaves = 0;
    const agent = new Agent({ llm, telemetry: false, maxActions: 4,
        connectors: [{ id: 'fixture', collectObservations: connector.collectObservations }],
        actions: [...taskActions, createAction({ name: 'leave', resolver: async () => { leaves++; } })],
    });
    agent.models.partialAct = async context => {
        plans++;
        if (plans === 1) return { reasoning: 'One bad reference.', memory_updates: [update, { ...update, key: 'bad', sources: [999] }], actions: [{ variant: 'leave' }] };
        assert.match(JSON.stringify(context.observationContent), /No notes changed/);
        assert.equal((await agent.memory.toJSON()).notes?.[0].text, update.text);
        return { reasoning: 'Correct the reference.', memory_updates: [{ ...update, key: 'bad' }], actions: [{ variant: 'task:done', evidence: 'Complete' }] };
    };
    await agent.act('Correct before leaving');
    assert.equal(plans, 2);
    assert.equal(leaves, 0, 'failed update must skip remaining browser actions');
    assert.equal((await agent.memory.toJSON()).notes?.length, 2);
    console.log('PASS: bad references preserve prior successful writes and force replanning without navigation');
}

{
    let plans = 0;
    const agent = new Agent({ llm, telemetry: false, connectors: [connector], maxActions: 2 });
    agent.models.partialAct = async () => {
        plans++;
        return { reasoning: 'Invalid reference.', memory_updates: [{ ...update, sources: [999] }], actions: [{ variant: 'task:done', evidence: 'Must not run' }] };
    };
    await assert.rejects(agent.act('Repeated failures'), ActionLimitError);
    assert.equal(plans, 2);
    assert.equal((await agent.memory.toJSON()).notes, undefined);
    console.log('PASS: rejected updates cannot loop outside the action budget');
}

{
    const agent = new Agent({ llm, telemetry: false, maxActions: 1 });
    agent.models.partialAct = async () => ({ reasoning: 'No facts need retaining.', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Complete' }] });
    await agent.act('Finish immediately');
    assert.equal((await agent.memory.toJSON()).notes, undefined);
    console.log('PASS: empty reviews require no fake notes or additional actions');
}

{
    let plans = 0;
    let leaves = 0;
    const other = { ...update, key: 'independent-record', text: 'Another observed fact.' };
    const agent = new Agent({ llm, telemetry: false, maxActions: 6,
        connectors: [{ id: 'fixture', collectObservations: connector.collectObservations }],
        actions: [...taskActions, createAction({ name: 'leave', resolver: async ({ memory }) => {
            leaves++;
            const notes = (await memory!.toJSON()).notes!;
            assert.equal(notes[0].text, 'Corrected observed value: 731.');
            assert.equal(notes[1].text, other.text);
        } })],
    });
    agent.models.partialAct = async context => {
        plans++;
        if (plans === 1) return { reasoning: 'Attempt a new record under an existing key.',
            memory_updates: [update, { ...other, key: update.key }], actions: [{ variant: 'leave' }] };
        assert.equal(leaves, 0);
        assert.match(JSON.stringify(context.observationContent), /already exists/);
        assert.equal((await agent.memory.toJSON()).notes?.[0].text, update.text);
        return { reasoning: 'Use a separate key and explicitly correct the original record.',
            memory_updates: [other, { ...update, operation: 'correct', expected_text: update.text, text: 'Corrected observed value: 731.' }],
            actions: [{ variant: 'leave' }, { variant: 'task:done', evidence: 'Complete' }] };
    };
    await agent.act('Preserve unrelated records');
    assert.equal(plans, 2);
    assert.equal(leaves, 1);
    console.log('PASS: key collisions block navigation; new keys and targeted corrections recover within the action budget');
}

{
    let plans = 0;
    let leaves = 0;
    const agent = new Agent({ llm, telemetry: false, maxActions: 5,
        connectors: [{ id: 'fixture', collectObservations: connector.collectObservations }],
        actions: [...taskActions, createAction({ name: 'leave', resolver: async () => { leaves++; } })],
    });
    agent.models.partialAct = async context => {
        plans++;
        if (plans === 1) return { reasoning: 'One correction followed by a stale correction.', memory_updates: [
            update, { ...update, key: 'unrelated' },
            { ...update, operation: 'correct', expected_text: update.text, text: 'Latest fact' },
            { ...update, operation: 'correct', expected_text: update.text, text: 'Stale replacement' },
        ], actions: [{ variant: 'leave' }] };
        assert.match(JSON.stringify(context.observationContent), /exactly match/);
        const notes = (await agent.memory.toJSON()).notes!;
        assert.equal(notes[0].text, 'Latest fact');
        assert.equal(notes[1].text, update.text);
        return { reasoning: 'No new facts.', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Complete' }] };
    };
    await agent.act('Reject stale corrections');
    assert.equal(plans, 2);
    assert.equal(leaves, 0);
    console.log('PASS: stale corrections preserve the latest state and unrelated records before replanning');
}
