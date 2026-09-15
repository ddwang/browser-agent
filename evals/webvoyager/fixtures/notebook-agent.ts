import assert from 'node:assert/strict';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { AgentMemory } from '../../../packages/magnitude-core/src/memory/agentMemory';
import { Observation } from '../../../packages/magnitude-core/src/memory/observation';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { ActionLimitError } from '../../../packages/magnitude-core/src/agent/errors';
import { BrowserRecovery } from '../../../packages/magnitude-core/src/web/recovery';

const llm = { provider: 'anthropic' as const, options: { model: 'fixture', apiKey: 'unused-no-model-calls' } };
const note = { variant: 'memory:note', key: 'record', text: 'Observed value: 437.', sources: [0] };
let observations = 0;
let hooks = 0;
const recovery = new BrowserRecovery();
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
    const agent = new Agent({ llm, connectors: [connector], actions: [], telemetry: false });
    for (const observation of await connector.collectObservations()) agent.memory.recordObservation(observation);
    await agent.memory.render();
    let checkpoints = 0;
    agent.events.on('observationsRecorded', () => { checkpoints++; });
    await agent.exec(note, agent.memory);
    assert.equal(observations, 1);
    assert.equal(hooks, 0);
    assert.equal(checkpoints, 1);
    assert.throws(() => recovery.check({ variant: 'mouse:click' }), /no_progress|repeated|previously/);
    assert.equal((await agent.memory.toJSON()).notes?.[0].text, note.text);
    await agent.exec({ ...note, sources: [900] }, agent.memory);
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
    agent.models.partialAct = async () => { calls++; return { reasoning: 'Record visible values.', actions: [note, note, note] }; };
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
        return { reasoning: 'Save and finish.', actions: [note, { variant: 'task:done', evidence: 'Synthetic fixture complete' }] };
    };
    await agent.act('First task');
    assert.equal((await agent.memory.toJSON()).notes?.length, 1);
    await agent.act('Second task');
    assert.equal(task, 2);
    console.log('PASS: notebook state is isolated between act calls');
}

{
    assert.throws(() => new Agent({ llm, telemetry: false, actions: [createAction({ name: 'memory:note', resolver: async () => {} })] }), /reserved/);
    console.log('PASS: reserved notebook action names cannot be shadowed');
}
