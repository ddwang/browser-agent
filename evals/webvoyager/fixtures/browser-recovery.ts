import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'patchright';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { BrowserConnector } from '../../../packages/magnitude-core/src/connectors/browserConnector';
import { BrowserBlockedError } from '../../../packages/magnitude-core/src/web/recovery';
import { ActionLimitError } from '../../../packages/magnitude-core/src/agent/errors';
import { createAction } from '../../../packages/magnitude-core/src/actions';
import { ActionVisualizer } from '../../../packages/magnitude-core/src/web/visualizer';

// Real browser interactions against loopback fixtures; no websites or model calls.
let browser: Browser;
const cases: { name: string; check: () => Promise<void> }[] = [];
function test(name: string, check: () => Promise<void>) { cases.push({ name, check }); }
let cooldownRequests = 0;
const root = `/${crypto.randomUUID()}`;
const corridor = `/${crypto.randomUUID()}`;
const exit = `/${crypto.randomUUID()}`;
const leaves = Array.from({ length: 9 }, () => `/${crypto.randomUUID()}`);
const cycle = Array.from({ length: 2 }, () => `/${crypto.randomUUID()}`);
const link = (path: string, label: string) => `<a style="display:block;font:20px sans-serif;margin:8px" href="${path}">${label}</a>`;
const graph = new Map([
    [root, `<h1>Directory</h1>${leaves.map((path, i) => link(path, `Entry ${i}`)).join('')}${link(exit, 'Finish')}`],
    [corridor, `<h1>Return route</h1>${link(root, 'Directory')}`],
    [exit, '<h1>Finished</h1>'],
    ...leaves.map((path, i): [string, string] => [path, `<h1>Record ${i}</h1>${link(corridor, 'Return')}`]),
    ...cycle.map((path, i): [string, string] => [path, `<h1>Cycle ${i}</h1>${link(cycle[1 - i], 'Continue')}`]),
]);
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname;
    if (graph.has(path)) return new Response(graph.get(path), { headers: { 'content-type': 'text/html' } });
    if (path.startsWith('/scroll') || path === '/controls') {
        const horizontal = path === '/scroll-horizontal';
        const rows = Array.from({ length: 80 }, () => `<span style="display:${horizontal ? 'inline-block' : 'block'};width:180px;height:100px">${crypto.randomUUID()}</span>`).join('');
        const panel = `<div class="panel" style="width:400px;height:220px;overflow:auto;overscroll-behavior:contain;white-space:${horizontal ? 'nowrap' : 'normal'}">${rows}</div>`;
        const panels = path === '/scroll-hidden'
            ? `<div style="visibility:hidden">${panel}</div><div style="position:absolute;left:5000px;top:0">${panel}</div>` : panel;
        return new Response(`<h1>Local progress fixture</h1>${path === '/controls'
            ? `<textarea></textarea><select>${Array.from({ length: 12 }, (_, i) => `<option value="${i}">Choice ${i}</option>`).join('')}</select>${Array.from({ length: 8 }, () => '<input>').join('')}`
            : panels}<button style="position:fixed;left:10px;top:650px">Unchanged button</button>`, { headers: { 'content-type': 'text/html' } });
    }
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
    const connector = new BrowserConnector({ browser: { context }, url: `http://127.0.0.1:${server.port}${path}`, recovery: { maxRateLimitWaitMs, noProgress: true } });
    await connector.onStart();
    const agent = new Agent({ connectors: [connector], telemetry: false, llm: { provider: 'anthropic', options: { model: 'fixture', apiKey: 'unused-no-model-calls' } } });
    await connector.collectObservations();
    return { connector, agent, page: connector.getHarness().page };
}

async function followLink(agent: Agent, page: Page, path: string) {
    const box = await page.locator(`a[href="${path}"]`).boundingBox();
    assert.ok(box, 'the next link must be visible');
    await agent.exec({ variant: 'mouse:click', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }, agent.memory);
    assert.equal(new URL(page.url()).pathname, path);
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
        for (const phase of ['cooldown', 'action', 'observations', 'screenshot', 'stability'] as const) {
            assert.ok(agent.operation?.timings[phase]?.count! > 0, `${phase} timing must be recorded`);
            assert.ok(agent.operation?.timings[phase]?.totalMs! >= 0);
        }
    } finally { await connector.onStop(); }
});

test('cursor configuration controls its real DOM transition and visibility', async () => {
    const context = await browser.newContext();
    try {
        for (const options of [{}, { animateCursor: false }, { showCursor: false }]) {
            const page = await context.newPage();
            await page.setContent('<html><body>Cursor fixture</body></html>');
            const visualizer = new ActionVisualizer(context, options);
            await visualizer.setActivePage(page);
            await visualizer.moveVirtualCursor(40, 50);
            const cursor = page.locator('#action-visual-indicator');
            if (options.showCursor === false) {
                assert.equal(await cursor.count(), 0);
            } else {
                assert.equal(await cursor.isVisible(), true);
                const style = await cursor.evaluate(element => ({
                    left: (element as HTMLElement).style.left,
                    top: (element as HTMLElement).style.top,
                    transition: (element as HTMLElement).style.transition,
                }));
                assert.equal(style.left, '40px'); assert.equal(style.top, '50px');
                if (options.animateCursor === false) assert.equal(style.transition, 'none');
                else assert.ok(style.transition.includes('0.3s'));
                await visualizer.hideAll(); assert.equal(await cursor.isVisible(), false);
                await visualizer.showAll(); assert.equal(await cursor.isVisible(), true);
            }
            await page.close();
        }
    } finally { await context.close(); }
});

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
        await agent.memory.render();
        const beforeNotes = await agent.memory.toJSON();
        const source = beforeNotes.observations.findLastIndex(observation => observation.options?.type === 'screenshot');
        await agent.exec({ variant: 'memory:note', key: 'barrier', text: 'Repeated clicks did not change the page.', sources: [source], operation: 'add', expected_text: null }, agent.memory);
        assert.equal((await agent.memory.toJSON()).observations.filter(o => o.options?.type === 'screenshot').length,
            beforeNotes.observations.filter(o => o.options?.type === 'screenshot').length);
        assert.ok((await agent.memory.toJSON()).notes?.length, 'notes remain available during a browser no-progress stop');
        await assert.rejects(agent.exec({ variant: 'mouse:click', x: 70, y: 85 }, agent.memory), BrowserBlockedError);
    } finally { await connector.onStop(); }
});

test('recovery observations explicitly clear an earlier warning after new evidence', async () => {
    const { connector, agent, page } = await fixture('/repeat');
    try {
        for (let i = 0; i < 3; i++) await agent.exec({ variant: 'mouse:click', x: 70, y: 85 }, agent.memory);
        assert.match(JSON.stringify(await agent.memory.render()), /different approach/);
        await page.goto(`http://127.0.0.1:${server.port}/cleared`);
        for (const observation of await connector.collectObservations()) agent.memory.recordObservation(observation);
        const rendered = JSON.stringify(await agent.memory.render());
        assert.ok(!rendered.includes('different approach'));
        assert.equal(connector.recovery.warning, undefined);
        const saved = await agent.memory.toJSON();
        const notices = saved.observations.filter(observation => observation.options?.type === 'browser-recovery');
        assert.ok(JSON.stringify(notices).includes('different approach'), 'audit retains the warning');
        assert.deepEqual(JSON.parse((notices.at(-1)!.data as { content: string }).content), { block: null, recovery: null });
    } finally { await connector.onStop(); }
});

test('late redirects retry the complete capture; permanent evaluation errors are not hidden', async () => {
    const { connector, page } = await fixture('/repeat');
    const evaluate = page.evaluate.bind(page);
    const capture = connector.getHarness().screenshot.bind(connector.getHarness());
    let captures = 0;
    connector.getHarness().screenshot = async () => { captures++; return capture(); };
    let mode = 'navigation';
    let fingerprintCalls = 0;
    page.evaluate = (async (fn: any, arg: any) => {
        if (String(fn).includes('scrollers')) {
            fingerprintCalls++;
            if (mode === 'navigation') {
                mode = 'ready';
                await page.goto(`http://127.0.0.1:${server.port}/redirected`);
                throw new Error('Execution context was destroyed, most likely because of a navigation');
            }
            if (mode === 'permanent') throw new Error('Synthetic permanent evaluation failure');
        }
        return evaluate(fn, arg);
    }) as typeof page.evaluate;
    try {
        const observations = await connector.collectObservations();
        assert.equal(captures, 2);
        assert.equal(fingerprintCalls, 2);
        assert.equal((observations[0].content as { url: string }).url, page.url());
        mode = 'permanent';
        await assert.rejects(connector.collectObservations(), /Synthetic permanent evaluation failure/);
        assert.equal(fingerprintCalls, 3);
    } finally { await connector.onStop(); }
});

test('productive record visits can reuse a directory and a shared return corridor', async () => {
    const { connector, agent, page } = await fixture(root);
    try {
        for (const leaf of leaves) for (const path of [leaf, corridor, root]) {
            await followLink(agent, page, path);
            assert.equal(connector.recovery.warning, undefined);
        }
        await followLink(agent, page, exit);
        assert.equal(connector.recovery.block, undefined);
    } finally { await connector.onStop(); }
});

test('real navigation cycles still warn and stop with a no-progress outcome', async () => {
    const { connector, agent, page } = await fixture(cycle[0]);
    try {
        await assert.rejects(async () => {
            for (let step = 1; step <= cycle.length * connector.recovery.repeatedActionLimit + 1; step++) {
                await followLink(agent, page, cycle[step % cycle.length]);
            }
        }, (error: unknown) => error instanceof BrowserBlockedError && error.block.reason === 'no_progress');
        assert.ok(connector.recovery.warning);
    } finally { await connector.onStop(); }
});

for (const horizontal of [false, true]) test(`nested ${horizontal ? 'horizontal' : 'vertical'} scroll progress is not a stall, but its endpoint is`, async () => {
    const { connector, agent, page } = await fixture(horizontal ? '/scroll-horizontal' : '/scroll-vertical');
    const action = { variant: 'mouse:scroll', x: 100, y: 140, deltaX: horizontal ? 300 : 0, deltaY: horizontal ? 0 : 300 };
    try {
        const text = await page.locator('body').innerText();
        let previous = 0;
        for (let i = 0; i < 8; i++) {
            await agent.exec(action, agent.memory);
            const offset = await page.locator('.panel').evaluate((panel, horizontal) => horizontal ? panel.scrollLeft : panel.scrollTop, horizontal);
            assert.ok(offset > previous, 'the panel must actually move');
            previous = offset;
            assert.equal(connector.recovery.warning, undefined, 'new panel content is progress');
        }
        assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), [0, 0]);
        assert.equal(await page.locator('body').innerText(), text, 'DOM text is unchanged despite visible progress');
        await page.locator('.panel').evaluate((panel, horizontal) => {
            if (horizontal) panel.scrollLeft = panel.scrollWidth;
            else panel.scrollTop = panel.scrollHeight;
        }, horizontal);
        await connector.collectObservations();
        for (let i = 0; i < 6; i++) await agent.exec(action, agent.memory);
        await assert.rejects(agent.exec(action, agent.memory), BrowserBlockedError);
    } finally { await connector.onStop(); }
});

test('textarea edits count as progress without changes to body text', async () => {
    const { connector, agent, page } = await fixture('/controls');
    try {
        await page.locator('textarea').focus();
        const text = await page.locator('body').innerText();
        for (let i = 0; i < 8; i++) {
            await agent.exec({ variant: 'keyboard:type', content: `value-${i} ` }, agent.memory);
            assert.equal(connector.recovery.warning, undefined);
        }
        assert.equal(await page.locator('body').innerText(), text);
        assert.match(await page.locator('textarea').inputValue(), /value-7/);
    } finally { await connector.onStop(); }
});

test('changing a select value counts as progress', async () => {
    const { connector, page } = await fixture('/controls');
    try {
        await page.locator('select').focus();
        for (let i = 0; i < 8; i++) {
            await connector.beforeAction({ variant: 'mouse:click', x: 0, y: 0 });
            await page.locator('select').selectOption(String(i + 1));
            await connector.collectObservations();
            assert.equal(await page.locator('select').inputValue(), String(i + 1));
            assert.equal(connector.recovery.warning, undefined);
        }
    } finally { await connector.onStop(); }
});

test('browser guards leave custom and terminal actions available without eval-specific names', async () => {
    const custom = `finish-${crypto.randomUUID()}`;
    for (const reason of ['no_progress', 'subscription', 'rate_limit'] as const) {
        const connector = new BrowserConnector({ recovery: { noProgress: true, maxRateLimitWaitMs: 0 } });
        for (let i = 0; i < 6; i++) connector.recovery.observe('unchanged', { variant: 'mouse:click' },
            reason === 'no_progress' ? undefined : { reason, evidence: 'Fixture barrier', retryAt: Date.now() + 60_000 });
        for (const variant of [custom, 'answer', 'task:done', 'task:fail', 'browser:blocked']) {
            await connector.beforeAction({ variant });
            assert.equal(connector.recovery.waitUntil, undefined);
        }
        let finished = false;
        const agent = new Agent({ telemetry: false, connectors: [connector],
            actions: [createAction({ name: custom, resolver: async ({ agent }) => { finished = true; await agent.queueDone(); } })] });
        await agent.exec({ variant: custom });
        assert.equal(finished, true);
        await assert.rejects(connector.beforeAction({ variant: 'mouse:click', x: 0, y: 0 }), BrowserBlockedError);
    }
});

test('entering equal values into different input controls counts as progress', async () => {
    const { connector, agent, page } = await fixture('/controls');
    try {
        for (let i = 0; i < 8; i++) {
            await page.locator('input').nth(i).focus();
            await agent.exec({ variant: 'keyboard:type', content: 'same value' }, agent.memory);
            assert.equal(connector.recovery.warning, undefined);
        }
    } finally { await connector.onStop(); }
});

test('hidden and offscreen scrolling does not hide genuinely unsuccessful clicks', async () => {
    const { connector, agent, page } = await fixture('/scroll-hidden');
    const action = { variant: 'mouse:click', x: 50, y: 660 };
    try {
        for (let i = 0; i < 6; i++) {
            await page.locator('.panel').evaluateAll((panels, offset) => panels.forEach(panel => { panel.scrollTop = offset; }), (i + 1) * 200);
            await agent.exec(action, agent.memory);
        }
        await assert.rejects(agent.exec(action, agent.memory), BrowserBlockedError);
    } finally { await connector.onStop(); }
});

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
        return { reasoning: 'Fixture plan', memory_updates: [], actions: Array.from({ length: oversizedBatch ? 3 : 1 }, () => ({ variant: 'tick' })) };
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
    agent.models.partialAct = async () => ({ reasoning: 'Fixture complete', memory_updates: [], actions: [{ variant: 'task:done', evidence: 'Verified by fixture' }] });
    await agent.act('Finish');
});

try {
    browser = await chromium.launch({ headless: true });
    for (const { name, check } of cases) { await check(); console.log(`PASS: ${name}`); }
} finally {
    await browser!?.close();
    server.stop(true);
}
