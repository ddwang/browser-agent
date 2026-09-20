import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'patchright';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { BrowserConnector } from '../../../packages/magnitude-core/src/connectors/browserConnector';
import { BrowserBlockedError } from '../../../packages/magnitude-core/src/web/recovery';
import { OperationCancelledError, OperationDeadlineError } from '../../../packages/magnitude-core/src/agent/errors';
import type { AgentContext } from '../../../packages/magnitude-core/src/ai/baml_client';

// Browser events and deterministic plans only: no portal, filesystem polling, or model API.
const cases: { name: string; check: () => Promise<void> }[] = [];
function test(name: string, check: () => Promise<void>) { cases.push({ name, check }); }
let browser: Browser;
const transfers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
const attachment = { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="private-fixture.bin"' };
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/download') return new Response('fixture bytes', { headers: attachment });
    if (url.pathname === '/slow') {
        const id = url.searchParams.get('id')!;
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) { transfers.set(id, controller); controller.enqueue(new Uint8Array(4096).fill(1)); },
            cancel() { transfers.delete(id); },
        }), { headers: { ...attachment, 'content-length': '8192' } });
    }
    if (url.pathname === '/popup') return new Response('<h1>Attachment</h1><a id="attachment" download href="/download">Download</a><script>attachment.click()</script>', { headers: { 'content-type': 'text/html' } });
    const pagination = url.pathname === '/pagination';
    const href = url.pathname === '/pending' ? `/slow?id=${url.searchParams.get('id')}`
        : url.pathname === '/newtab' ? '/popup' : '/download';
    return new Response(`<style>button,a{display:block;margin:20px;width:220px;height:50px}#more{position:fixed;top:0;left:0}</style>
        ${pagination ? `<button id="more">More</button><p>${'existing record '.repeat(2000)}</p><div id="records"></div>
            <script>let count=0; more.onclick=()=>{records.append('new record '+(++count)); if(count===8)more.remove()}</script>`
        : `<h1>Local evidence fixture</h1><button id="target">Inert target</button><a id="download" href="${href}" ${url.pathname === '/newtab' ? 'target="_blank"' : ''}>Download</a>
            <script>target.dataset.events='[]'; for(const name of ['mousedown','click','dblclick','contextmenu']) target.addEventListener(name,e=>{
                const events=JSON.parse(target.dataset.events); events.push({type:e.type,button:e.button}); target.dataset.events=JSON.stringify(events);
                if(e.type==='contextmenu')e.preventDefault();
            });</script>`}`, { headers: { 'content-type': 'text/html' } });
} });
const base = `http://127.0.0.1:${server.port}`;

async function fixture(path = '/', contextOptions: BrowserContextOptions = {}) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, ...contextOptions });
    // Ensure pages created before the connector starts are observed as well.
    await context.newPage();
    const connector = new BrowserConnector({ browser: { context }, url: `${base}${path}`,
        visuals: { animateCursor: false }, recovery: { noProgress: true } });
    await connector.onStart();
    const agent = new Agent({ connectors: [connector], telemetry: false, maxActions: 30,
        llm: { provider: 'anthropic', options: { model: 'fixture', apiKey: 'unused-no-model-calls' } } });
    return { agent, connector, context, page: connector.getHarness().page };
}

async function point(page: Page, selector: string) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box);
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

function evidence(context: AgentContext) {
    // Read precisely what the deterministic planner receives, including retention.
    const parts = context.observationContent.flatMap(message => message.content).filter(part => typeof part === 'string');
    const content = parts.findLast(part => part.includes('"downloads"') && part.includes('"operationId"'));
    assert.ok(content, 'planner must receive download evidence, including an empty replacement');
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    return JSON.parse(content.slice(start, end + 1)) as {
        operationId: string; downloads: { status: 'started' | 'completed' | 'failed'; actionIndex: number }[]; truncated: boolean;
    };
}

const plan = (...actions: { variant: string; [key: string]: unknown }[]) => ({ reasoning: 'Deterministic fixture plan', memory_updates: [], actions });
const done = () => plan({ variant: 'task:done', evidence: 'Verified browser fixture evidence' });
function finishTransfer(id: string) {
    const controller = transfers.get(id);
    assert.ok(controller, 'stream must have started');
    controller.enqueue(new Uint8Array(4096).fill(2));
    controller.close();
    transfers.delete(id);
}

test('right-click reaches Chromium as button 2 and preserves left-click, double-click, and coordinate scaling', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const connector = new BrowserConnector({ browser: { context }, url: base, virtualScreenDimensions: { width: 512, height: 384 }, visuals: { animateCursor: false } });
    try {
        await connector.onStart();
        const harness = connector.getHarness();
        const pos = await point(harness.page, '#target');
        const target = { x: pos.x / 2, y: pos.y / 2 };
        await harness.rightClick(target);
        const events = async () => JSON.parse((await harness.page.locator('#target').getAttribute('data-events'))!) as { type: string; button: number }[];
        assert.deepEqual(await events(), [{ type: 'mousedown', button: 2 }, { type: 'contextmenu', button: 2 }]);
        await harness.click(target);
        await harness.doubleClick(target);
        const recorded = await events();
        assert.equal(recorded.filter(event => event.type === 'click' && event.button === 0).length, 3);
        assert.equal(recorded.filter(event => event.type === 'dblclick' && event.button === 0).length, 1);
    } finally { await connector.onStop(); }
});

for (const popup of [false, true]) test(`${popup ? 'popup' : 'unchanged page'} download completes a deterministic task after one click`, async () => {
    const { agent, connector, page, context } = await fixture(popup ? '/newtab' : '/');
    const target = await point(page, '#download');
    const original = await page.locator('body').innerText();
    let calls = 0;
    agent.models.partialAct = async context => {
        const observed = evidence(context);
        if (++calls === 1) {
            assert.deepEqual(observed.downloads, []);
            return plan({ variant: 'mouse:click', ...target });
        }
        assert.equal(calls, 2);
        assert.deepEqual(observed.downloads.map(download => download.status), ['completed']);
        assert.equal(observed.operationId, agent.operation?.id);
        assert.equal(observed.downloads[0].actionIndex, 1);
        assert.ok(!JSON.stringify(observed).includes('private-fixture'));
        return done();
    };
    try {
        await agent.act('Download the attachment', { deadline: Date.now() + 15_000 });
        assert.equal(calls, 2);
        assert.equal(agent.operation?.outcome, 'succeeded');
        assert.equal(await page.locator('body').innerText(), original);
        if (popup) assert.equal(context.pages().length, 2);
    } finally { await connector.onStop(); }
});

test('acceptDownloads false reports a browser failure, never a completed transfer', async () => {
    const { agent, connector, page } = await fixture('/', { acceptDownloads: false });
    const target = await point(page, '#download');
    let calls = 0;
    agent.models.partialAct = async context => {
        if (++calls === 1) return plan({ variant: 'mouse:click', ...target });
        assert.deepEqual(evidence(context).downloads.map(download => download.status), ['failed']);
        return done(); // Task is to observe a failure, not claim a successful download.
    };
    try { await agent.act('Observe the rejected transfer', { deadline: Date.now() + 15_000 }); }
    finally { await connector.onStop(); }
});

test('pending transfers permit waits after a no-progress bound and completion is new evidence', async () => {
    const id = crypto.randomUUID();
    const { agent, connector, page } = await fixture(`/pending?id=${id}`);
    const target = await point(page, '#download');
    let calls = 0;
    agent.models.partialAct = async context => {
        calls++;
        if (calls === 1) return plan({ variant: 'mouse:click', ...target });
        if (calls === 2) {
            assert.equal(evidence(context).downloads[0].status, 'started');
            connector.recovery.observe('inert', undefined, undefined);
            for (let i = 0; i < 6; i++) connector.recovery.observe('inert', { variant: 'mouse:click' }, undefined);
            assert.throws(() => connector.recovery.check(), BrowserBlockedError);
            finishTransfer(id);
            return plan({ variant: 'wait', seconds: 0.05 });
        }
        assert.equal(calls, 3);
        assert.equal(evidence(context).downloads[0].status, 'completed');
        assert.equal(connector.recovery.warning, undefined);
        assert.doesNotThrow(() => connector.recovery.check());
        return done();
    };
    try { await agent.act('Wait for the attachment', { deadline: Date.now() + 15_000 }); }
    finally { await connector.onStop(); }
});

test('cancelled transfer completion stays out of a subsequent task and the session remains usable', async () => {
    const id = crypto.randomUUID();
    const { agent, connector, page } = await fixture(`/pending?id=${id}`);
    const target = await point(page, '#download');
    const controller = new AbortController();
    const download = page.waitForEvent('download');
    let planned = 0;
    agent.models.partialAct = async context => {
        if (++planned === 1) return plan({ variant: 'mouse:click', ...target });
        assert.equal(evidence(context).downloads[0].status, 'started');
        return plan({ variant: 'wait', seconds: 30 });
    };
    const onOperation = (snapshot: { phase: string }) => {
        if (snapshot.phase === 'cooldown' && !controller.signal.aborted) queueMicrotask(() => controller.abort('fixture cancellation'));
    };
    agent.events.on('operation', onOperation);
    try {
        await assert.rejects(agent.act('Start a pending attachment', { signal: controller.signal, deadline: Date.now() + 15_000 }), OperationCancelledError);
        await agent.whenIdle();
        assert.equal(agent.busy, false);
        const cancelled = agent.operation;
        assert.equal(cancelled?.outcome, 'cancelled');
        agent.events.off('operation', onOperation);
        let next = 0;
        agent.models.partialAct = async context => {
            assert.deepEqual(evidence(context).downloads, []);
            if (++next === 1) {
                finishTransfer(id);
                assert.equal(await (await download).failure(), null);
                return plan({ variant: 'wait', seconds: 0.01 });
            }
            return done();
        };
        await agent.act('Inspect without downloading', { memory: agent.memory, deadline: Date.now() + 15_000 });
        assert.equal(next, 2);
        assert.equal(cancelled?.outcome, 'cancelled');
        assert.equal((page as any).listenerCount('download'), 1);
    } finally { await connector.onStop(); }
    assert.equal((page as any).listenerCount('download'), 0);
});

test('pending download waits still honor the operation deadline and can drain', async () => {
    const id = crypto.randomUUID();
    const { agent, connector, page } = await fixture(`/pending?id=${id}`);
    const target = await point(page, '#download');
    let calls = 0;
    agent.models.partialAct = async context => {
        if (++calls === 1) return plan({ variant: 'mouse:click', ...target });
        assert.equal(evidence(context).downloads[0].status, 'started');
        return plan({ variant: 'wait', seconds: 60 });
    };
    try {
        await assert.rejects(agent.act('Wait until the deadline', { deadline: Date.now() + 3000 }), OperationDeadlineError);
        await agent.whenIdle();
        assert.equal(agent.busy, false);
        assert.equal(agent.operation?.outcome, 'deadline');
        finishTransfer(id);
    } finally { await connector.onStop(); }
});

test('alternating inert input reaches no_progress without hover restarting its allowance', async () => {
    const { agent, connector, page } = await fixture();
    const target = await point(page, '#target');
    const variants = ['mouse:click', 'mouse:double_click', 'mouse:right_click', 'keyboard:enter'];
    let attempts = 0;
    agent.models.partialAct = async () => plan(
        { variant: 'mouse:hover', ...target },
        { variant: variants[attempts++ % variants.length], x: target.x + attempts % 2, y: target.y },
    );
    try {
        await assert.rejects(agent.act('Find an interaction', { deadline: Date.now() + 20_000 }),
            (error: unknown) => error instanceof BrowserBlockedError && error.block.reason === 'no_progress');
        assert.equal(attempts, connector.recovery.repeatedActionLimit + 1);
        // Terminal actions and inspection remain possible without another click.
        await agent.exec({ variant: 'mouse:hover', ...target }, agent.memory);
        await agent.exec({ variant: 'task:done', evidence: 'Fixture inspection finished' });
    } finally { await connector.onStop(); }
});

test('pagination beyond a long text prefix remains progress and a removed control is observed', async () => {
    const { agent, connector, page } = await fixture('/pagination');
    const target = await point(page, '#more');
    try {
        for (let i = 0; i < 8; i++) {
            await agent.exec({ variant: 'mouse:click', ...target }, agent.memory);
            assert.equal(connector.recovery.warning, undefined);
            assert.doesNotThrow(() => connector.recovery.check());
        }
        assert.equal(await page.locator('#more').count(), 0);
        assert.match(await page.locator('#records').innerText(), /new record 8/);
    } finally { await connector.onStop(); }
});

try {
    browser = await chromium.launch({ headless: true });
    for (const { name, check } of cases.filter(test => test.name.includes(process.argv[2] ?? ''))) {
        await check(); console.log(`PASS: ${name}`);
    }
} finally {
    await browser!?.close();
    server.stop(true);
}
