import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const llm = { provider: 'anthropic', options: { model: 'fixture', apiKey: 'unused' } };

// Exercise the built public API in both formats, without model or browser requests.
for (const [format, load] of [
    ['CommonJS', () => require('../packages/magnitude-core/dist/index.cjs')],
    ['ESM', () => import('../packages/magnitude-core/dist/index.mjs')],
]) {
    const { Agent, AgentMemory, BrowserConnector, createAction, AgentBusyError, OperationCancelledError } = await load();
    const disabled = new BrowserConnector();
    const enabled = new BrowserConnector({ groundedControls: true });
    assert.ok(!disabled.getActionSpace().some(action => action.name === 'browser:click'));
    const grounded = enabled.getActionSpace().find(action => action.name === 'browser:click');
    assert.ok(grounded);
    assert.equal(grounded.schema.safeParse({ ref: 'observed-ref' }).success, true);
    assert.equal(grounded.schema.safeParse({ ref: '' }).success, false);
    assert.ok((await enabled.getInstructions()).includes('browser-controls'));
    const memory = new AgentMemory({ promptCaching: true });
    await memory.loadJSON({ instructions: 'Saved constraint', observations: [{
        source: 'connector:fixture', role: 'user', timestamp: 0, data: { type: 'primitive', content: 'Saved evidence' },
    }] });
    assert.equal(memory.instructions, 'Saved constraint');
    assert.ok((await memory.render()).some(message => message.cacheControl));
    const resumed = new Agent({ llm, telemetry: false });
    resumed.models.partialAct = async context => {
        assert.equal(context.instructions, 'Current constraint');
        assert.ok(context.observationContent.every(message => !message.cacheControl));
        return { reasoning: 'Fixture complete', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Complete' }] };
    };
    await resumed.act('Continue', { memory, prompt: 'Current constraint' });
    assert.equal((await memory.toJSON()).instructions, 'Current constraint');
    await resumed.stop();
    console.log(`PASS: ${format} checkpoint restoration and prompt replacement on ${process.version}`);

    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const agent = new Agent({ llm, telemetry: false, actions: [createAction({
        name: 'work', resolver: async () => { entered(); await gate; return 'complete'; },
    })] });
    agent.models.setup = async () => {};
    await Promise.all([agent.start(), agent.start()]);
    const controller = new AbortController();
    const result = agent.exec({ variant: 'work' }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(result, error => error instanceof OperationCancelledError
        && error.operation?.lastAction?.state === 'started' && error.operation?.status === 'draining');
    await started; controller.abort(); await rejected;
    assert.equal(agent.busy, true);
    await assert.rejects(agent.exec({ variant: 'work' }), AgentBusyError);
    release(); await agent.whenIdle();
    assert.equal(agent.busy, false);
    assert.equal(agent.operation?.outcome, 'cancelled');
    assert.equal(agent.operation?.timings.action?.count, 1);
    assert.ok(agent.operation.cancellationToIdleMs >= 0);
    await Promise.all([agent.stop(), agent.stop()]);
    assert.equal(agent.lifecycle, 'stopped');
    console.log(`PASS: ${format} lifecycle, cancellation, and diagnostics on ${process.version}`);
}
