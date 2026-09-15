import assert from 'node:assert/strict';
import { chromium, type Browser } from 'patchright';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { BrowserConnector } from '../../../packages/magnitude-core/src/connectors/browserConnector';
import { BrowserBlockedError } from '../../../packages/magnitude-core/src/web/recovery';
import { ActionLimitError } from '../../../packages/magnitude-core/src/agent/errors';
import { createAction } from '../../../packages/magnitude-core/src/actions';

// Real browser interactions against loopback fixtures; no websites or model calls.
let browser: Browser;
const cases: { name: string; check: () => Promise<void> }[] = [];
function test(name: string, check: () => Promise<void>, _timeout?: number) { cases.push({ name, check }); }
let cooldownRequests = 0;
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname;
    const limited = path === '/limited' || (path === '/cooldown' && cooldownRequests++ === 0);
    const html = limited ? '<h1>Too many requests</h1>'
        : path === '/subscription' ? '<h1>Subscribe to Example to continue</h1>'
        : path === '/dialog' ? '<h1>Ready</h1><dialog id="notice">Dismiss me</dialog><script>notice.showModal()</script>'
        : '<h1>Ready</h1><button>Unchanged search</button>';
    return new Response(html, { status: limited ? 429 : 200, headers: {
        'content-type': 'text/html', ...(limited ? { 'retry-after': path === '/limited' ? '3600' : '1' } : {}),
    } });
} });

async function fixture(path: string, maxRateLimitWaitMs = 120_000) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const connector = new BrowserConnector({ browser: { context }, url: `http://127.0.0.1:${server.port}${path}`, recovery: { maxRateLimitWaitMs } });
    await connector.onStart();
    const agent = new Agent({ connectors: [connector], telemetry: false, llm: { provider: 'anthropic', options: { model: 'fixture', apiKey: 'unused-no-model-calls' } } });
    await connector.collectObservations();
    return { connector, agent, page: connector.getHarness().page };
}

test('actual 429 headers produce a redacted diagnostic and an explicit blocked outcome', async () => {
    const { connector } = await fixture('/limited?token=secret', 20);
    try {
        assert.equal(connector.network.at(-1)?.status, 429);
        assert.equal(connector.network.at(-1)?.url, `http://127.0.0.1:${server.port}/limited`);
        assert.ok(!JSON.stringify(connector.network).includes('secret'));
        await assert.rejects(connector.beforeAction({ variant: 'mouse:click', x: 10, y: 10 }), BrowserBlockedError);
    } finally { await connector.onStop(); }
});

test('cooldown exposes its deadline and a successful retry clears the site barrier', async () => {
    const { connector, agent } = await fixture('/cooldown');
    try {
        const action = agent.exec({ variant: 'browser:nav', url: `http://127.0.0.1:${server.port}/cooldown` }, agent.memory);
        // The connector enters its wait before emitting actionStarted.
        assert.ok(connector.recovery.waitUntil! > Date.now());
        await action;
        assert.equal(connector.recovery.block, undefined);
        assert.equal(connector.network.at(-1)?.status, 200);
        assert.equal(connector.recovery.waitUntil, undefined);
    } finally { await connector.onStop(); }
}, 15_000);

test('Escape dismisses a native dialog through the exposed agent action', async () => {
    const { connector, agent, page } = await fixture('/dialog');
    try {
        const events: string[] = [];
        agent.events.on('actionDone', () => events.push('actionDone'));
        agent.events.on('observationsRecorded', () => events.push('observationsRecorded'));
        assert.equal(await page.locator('dialog').isVisible(), true);
        await agent.exec({ variant: 'keyboard:escape' }, agent.memory);
        assert.equal(await page.locator('dialog').isVisible(), false);
        assert.deepEqual(events, ['actionDone', 'observationsRecorded']);
        assert.ok((await agent.memory.toJSON()).observations.some(observation => observation.source === 'action:taken:keyboard:escape'));
    } finally { await connector.onStop(); }
});

test('subscription headings are distinct from rate limits', async () => {
    const { connector } = await fixture('/subscription');
    try { assert.equal(connector.recovery.block?.reason, 'subscription'); }
    finally { await connector.onStop(); }
});

test('repeated unsuccessful clicks warn before the real agent stops', async () => {
    const { connector, agent } = await fixture('/repeat');
    try {
        for (let i = 0; i < 6; i++) {
            await agent.exec({ variant: 'mouse:click', x: 70 + i, y: 85 }, agent.memory);
            if (i === 2) assert.ok(connector.recovery.warning?.includes('different approach'));
        }
        await assert.rejects(agent.exec({ variant: 'mouse:click', x: 70, y: 85 }, agent.memory), BrowserBlockedError);
    } finally { await connector.onStop(); }
}, 20_000);

for (const oversizedBatch of [false, true]) test(`action cap prevents ${oversizedBatch ? 'an oversized batch' : 'an extra planning call'}`, async () => {
    let performed = 0;
    let planned = 0;
    const agent = new Agent({
        maxActions: 2, telemetry: false,
        llm: { provider: 'anthropic', options: { model: 'fixture', apiKey: 'unused-no-model-calls' } },
        actions: [createAction({ name: 'tick', resolver: async () => { performed++; } })],
    });
    agent.models.partialAct = async () => {
        planned++;
        return { reasoning: 'Fixture plan', actions: Array.from({ length: oversizedBatch ? 3 : 1 }, () => ({ variant: 'tick' })) };
    };
    await assert.rejects(agent.act('Continue indefinitely'), ActionLimitError);
    assert.equal(performed, 2);
    assert.equal(planned, oversizedBatch ? 1 : 2);
});

test('completion on the final allowed action succeeds', async () => {
    const agent = new Agent({
        maxActions: 1, telemetry: false,
        llm: { provider: 'anthropic', options: { model: 'fixture', apiKey: 'unused-no-model-calls' } },
    });
    agent.models.partialAct = async () => ({ reasoning: 'Fixture complete', actions: [{ variant: 'task:done', evidence: 'Verified by fixture' }] });
    await agent.act('Finish');
});

try {
    browser = await chromium.launch({ headless: true });
    for (const { name, check } of cases) { await check(); console.log(`PASS: ${name}`); }
} finally {
    await browser!?.close();
    server.stop(true);
}
