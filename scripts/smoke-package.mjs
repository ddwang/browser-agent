import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowserDependencies } from './verify-browser-dependencies.mjs';

const require = createRequire(import.meta.url);
const llm = { provider: 'anthropic', options: { model: 'fixture', apiKey: 'unused' } };

// Changesets publishes this Bun workspace with npm, which does not rewrite workspace: ranges.
const packed = await mkdtemp(join(tmpdir(), 'magnitude-npm-smoke-'));
try {
    for (const name of ['magnitude-core', 'magnitude-mcp', 'magnitude-test']) {
        execFileSync('npm', ['pack', '--pack-destination', packed], {
            cwd: fileURLToPath(new URL(`../packages/${name}/`, import.meta.url)), stdio: 'pipe',
        });
    }
    for (const filename of await readdir(packed)) {
        const manifest = JSON.parse(execFileSync('tar', ['-xOf', join(packed, filename), 'package/package.json'], { encoding: 'utf8' }));
        if (manifest.name !== '@ddwang/magnitude-core') assert.ok(manifest.dependencies['@ddwang/magnitude-core']);
        for (const range of Object.values(manifest.dependencies)) assert.ok(!range.startsWith('workspace:'), `${manifest.name}: ${range}`);
        const listing = execFileSync('tar', ['-tf', join(packed, filename)], { encoding: 'utf8' });
        assert.ok(listing.includes('package/node_modules/patchright-core/lib/utilsBundle.js'));
        console.log(`PASS: ${manifest.name} npm tarball has publishable dependency ranges`);
    }
    const consumer = await mkdtemp(join(tmpdir(), 'magnitude-browser-consumer-'));
    try {
        const tarballs = (await readdir(packed)).map(filename => join(packed, filename));
        execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', ...tarballs], {
            cwd: consumer, stdio: 'pipe', timeout: 180_000,
        });
        for (const name of ['@ddwang/magnitude-core', 'magnitude-mcp', 'magnitude-test']) {
            const directory = join(consumer, 'node_modules', name);
            verifyBrowserDependencies(directory);
            const installedRequire = createRequire(join(directory, 'package.json'));
            execFileSync(process.execPath, ['--max-old-space-size=128',
                fileURLToPath(new URL('./check-brace-expansion.cjs', import.meta.url)),
                installedRequire.resolve('patchright-core/lib/utilsBundle')], { stdio: 'inherit', timeout: 15_000 });
            const wrapper = name === 'magnitude-mcp' ? 'patchright' : 'playwright';
            await writeFile(join(directory, 'security-probe.test.mjs'),
                `import { test } from '${wrapper}/test';\ntest('patched loader', () => {});\n`);
            await writeFile(join(directory, 'security-probe.config.mjs'),
                "export default { testMatch: 'security-probe.test.mjs' };\n");
            const cli = join(installedRequire.resolve(`${wrapper}/package.json`), '..', 'cli.js');
            const listed = execFileSync(process.execPath, [cli, 'test', '--list', '--config', 'security-probe.config.mjs'], {
                cwd: directory, encoding: 'utf8', timeout: 30_000,
            });
            assert.ok(listed.includes('patched loader'));
            console.log(`PASS: ${name} patched ESM loader discovers tests`);
        }
        console.log('PASS: clean npm installation retains the patched driver with scripts disabled');
    } finally { await rm(consumer, { recursive: true, force: true }); }
} finally { await rm(packed, { recursive: true, force: true }); }

// Exercise the built public API in both formats, without model or browser requests.
for (const [format, load] of [
    ['CommonJS', () => require('../packages/magnitude-core/dist/index.cjs')],
    ['ESM', () => import('../packages/magnitude-core/dist/index.mjs')],
]) {
    const { Agent, AgentMemory, BrowserConnector, createAction, AgentBusyError, OperationCancelledError, PlannerTimeoutError } = await load();
    assert.equal(new PlannerTimeoutError(100).options.variant, 'planner_timeout');
    assert.throws(() => new Agent({ llm, telemetry: false, planner: { timeoutMs: 0 } }), /planner.timeoutMs/);
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
