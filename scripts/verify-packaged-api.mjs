import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

export async function verifyPackagedAPI(directory) {
    const require = createRequire(join(directory, 'package.json'));
    const llm = { provider: 'anthropic', options: { model: 'fixture', apiKey: 'unused' } };

    for (const [format, load] of [
        ['CommonJS', () => require('./dist/index.cjs')],
        ['ESM', () => import(pathToFileURL(join(directory, 'dist/index.mjs')).href)],
    ]) {
        const sdk = await load();
        const { Agent, AgentMemory, BrowserConnector, createAction, AgentBusyError, OperationCancelledError, PlannerTimeoutError } = sdk;
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
        const { z, posthog, startBrowserAgent } = sdk;
        let captures = 0;
        const originalCapture = posthog.capture;
        posthog.capture = () => { captures++; };
        try {
            const schema = z.object({ name: z.string(), count: z.number().int().min(1) });
            assert.equal(z.toJSONSchema(schema).properties.count.type, 'integer');
            let requests = 0;
            const executed = [];
            const server = createServer(async (request, response) => {
                let raw = '';
                for await (const chunk of request) raw += chunk;
                const body = JSON.parse(raw);
                assert.ok(JSON.stringify(body).includes('fixture'));
                if (++requests === 2) assert.ok(JSON.stringify(body).includes('previous response was rejected'));
                const plan = requests === 1
                    ? { reasoning: 'Invalid fixture', memory_updates: [], actions: [{ variant: 'fixture', name: 'invalid' }, { variant: 'unknown' }] }
                    : { reasoning: 'Repaired fixture', memory_updates: [], actions: [{ variant: 'fixture', name: 'valid' }] };
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture',
                    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            const repaired = new Agent({ telemetry: false,
                llm: { provider: 'openai-generic', options: { model: 'fixture', apiKey: 'unused',
                    baseUrl: `http://127.0.0.1:${server.address().port}/v1` } },
                actions: [createAction({ name: 'fixture', schema: z.object({ name: z.string() }),
                    resolver: async ({ input, agent }) => { executed.push(input.name); agent.queueDone(); } })] });
            try {
                await repaired.start();
                await repaired.act('Run the fixture and finish');
                assert.equal(requests, 2);
                assert.deepEqual(executed, ['valid']);
            } finally {
                await repaired.stop();
                await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            }
            console.log(`PASS: ${format} Zod 4 schema and invalid-plan repair through local HTTP on ${process.version}`);

            const { chromium } = require('playwright');
            const serverBrowser = await chromium.launchServer({ headless: true, channel: 'chrome' });
            let browser;
            let browserAgent;
            try {
                browser = await chromium.connect(serverBrowser.wsEndpoint());
                const sibling = await browser.newContext();
                const untouched = await sibling.newPage();
                await untouched.setContent('<title>host-owned sibling</title>');
                const dedicated = await browser.newContext({ viewport: { width: 1024, height: 768 } });
                let dedicatedClosed = false;
                dedicated.on('close', () => { dedicatedClosed = true; });
                browserAgent = await startBrowserAgent({ llm, telemetry: false,
                    browser: { context: dedicated }, visuals: { cursor: false, click: false } });
                assert.equal(browserAgent.context, dedicated);
                await browserAgent.page.setContent('<input id="text"><button id="button" onclick="this.textContent=\'clicked\'">click</button><select><option>a</option><option>b</option></select>');
                const input = await browserAgent.page.locator('#text').boundingBox();
                await browserAgent.exec({ variant: 'mouse:click', x: Math.round(input.x + input.width / 2), y: Math.round(input.y + input.height / 2) });
                await browserAgent.exec({ variant: 'keyboard:type', content: 'native input' });
                assert.equal(await browserAgent.page.locator('#text').inputValue(), 'native input');
                const button = await browserAgent.page.locator('#button').boundingBox();
                await browserAgent.exec({ variant: 'mouse:click', x: Math.round(button.x + button.width / 2), y: Math.round(button.y + button.height / 2) });
                assert.equal(await browserAgent.page.locator('#button').textContent(), 'clicked');
                await browserAgent.page.locator('select').selectOption({ label: 'b' });
                assert.equal(await browserAgent.page.locator('select').inputValue(), 'b');
                await browserAgent.stop();
                assert.equal(dedicatedClosed, true, 'Agent stop closes its supplied dedicated context');
                assert.equal(browser.isConnected(), true, 'Host browser stays connected');
                assert.equal(await untouched.title(), 'host-owned sibling');
                await sibling.close();
                console.log(`PASS: ${format} browser connection, native actions, dedicated-context cleanup and sibling isolation (${browser.version()})`);
            } finally {
                await browserAgent?.stop();
                await browser?.close();
                await serverBrowser.close();
            }
            assert.equal(captures, 0, 'telemetry:false must suppress PostHog captures');
            console.log(`PASS: ${format} telemetry:false`);
        } finally { posthog.capture = originalCapture; }

    }

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    assert(process.argv[2], 'Usage: node scripts/verify-packaged-api.mjs <installed-sdk-directory>');
    await verifyPackagedAPI(resolve(process.argv[2]));
}
