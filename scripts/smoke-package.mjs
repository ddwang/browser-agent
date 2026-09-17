import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const llm = { provider: 'anthropic', options: { model: 'fixture', apiKey: 'unused' } };

// Exercise the built public API in both formats, without model or browser requests.
for (const [format, load] of [
    ['CommonJS', () => require('../packages/magnitude-core/dist/index.cjs')],
    ['ESM', () => import('../packages/magnitude-core/dist/index.mjs')],
]) {
    const { Agent, createAction, AgentBusyError, OperationCancelledError } = await load();
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
