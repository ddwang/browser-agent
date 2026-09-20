import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'patchright';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { BrowserConnector } from '../../../packages/magnitude-core/src/connectors/browserConnector';
import { BrowserBlockedError } from '../../../packages/magnitude-core/src/web/recovery';
import { OperationCancelledError, OperationDeadlineError } from '../../../packages/magnitude-core/src/agent/errors';
import type { AgentContext } from '../../../packages/magnitude-core/src/ai/baml_client';
import { collectRecoveryState } from '../../../packages/magnitude-core/src/web/recoveryState';
import type { BrowserClickDiagnostics, OperationDiagnostics } from '../../../packages/magnitude-core/src/common/operation';

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
        llm: { provider: 'anthropic', options: { model: 'claude-fixture', apiKey: 'unused-no-model-calls' } } });
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

function clickEvidence(context: AgentContext) {
    assert.ok(context.observationContent.some(message => message.cacheControl), 'exercise Claude prompt caching');
    const parts = context.observationContent.flatMap(message => message.content)
        .filter(part => typeof part === 'string' && part.includes('"lastClick"'));
    assert.equal(parts.length, 1, 'only the latest click observation belongs in planner context');
    const content = parts[0] as string;
    return (JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) as {
        lastClick: BrowserClickDiagnostics | null;
    }).lastClick;
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
        const target = { x: Math.round(pos.x / 2), y: Math.round(pos.y / 2) };
        await harness.rightClick(target);
        const events = async () => JSON.parse((await harness.page.locator('#target').getAttribute('data-events'))!) as { type: string; button: number }[];
        assert.deepEqual(await events(), [{ type: 'mousedown', button: 2 }, { type: 'contextmenu', button: 2 }]);
        await harness.click(target);
        await harness.doubleClick(target);
        const recorded = await events();
        assert.equal(recorded.filter(event => event.type === 'click' && event.button === 0).length, 3);
        assert.equal(recorded.filter(event => event.type === 'dblclick' && event.button === 0).length, 1);
        const agent = new Agent({ connectors: [connector], telemetry: false,
            llm: { provider: 'anthropic', options: { model: 'claude-fixture', apiKey: 'unused' } } });
        const variants = ['mouse:right_click', 'mouse:double_click', 'mouse:click'];
        let calls = 0;
        agent.models.partialAct = async context => {
            const click = clickEvidence(context);
            if (calls === 0) assert.equal(click, null);
            else {
                assert.ok(click);
                assert.equal(click.x, target.x * 2); assert.equal(click.y, target.y * 2);
                assert.equal(click.button, calls === 1 ? 'right' : 'left');
                assert.equal(click.clickCount, calls === 2 ? 2 : 1);
                assert.deepEqual(click.screenshot, { width: 512, height: 384 });
                assert.deepEqual(click.viewport, { width: 1024, height: 768 });
                assert.deepEqual(click.hit, { tag: 'button', role: null });
            }
            return calls < variants.length ? plan({ variant: variants[calls++], ...target }) : done();
        };
        await agent.act('Inspect all click variants', { deadline: Date.now() + 15_000 });
    } finally { await connector.onStop(); }
});

test('missed clicks report the panel and a corrected click reports the pre-dispatch button', async () => {
    const { agent, connector, page } = await fixture();
    try {
        await page.setContent(`<div style="position:absolute;left:50px;top:50px;width:300px;height:200px">SECRET_PAGE_TEXT
            <button id="SECRET_SELECTOR" aria-label="SECRET_LABEL" style="position:absolute;left:50px;top:50px;width:100px;height:50px"
                onclick="this.outerHTML='<dialog open>Opened</dialog>'">SECRET_BUTTON</button></div>`);
        const snapshots: OperationDiagnostics[] = [];
        agent.events.on('operation', snapshot => { snapshots.push(snapshot); });
        let calls = 0;
        agent.models.partialAct = async context => {
            const click = clickEvidence(context);
            if (++calls === 1) {
                assert.equal(click, null);
                return plan({ variant: 'mouse:click', x: 75, y: 75 });
            }
            assert.ok(click);
            assert.equal(click.operationId, agent.operation!.id);
            assert.equal(click.actionIndex, calls - 1);
            assert.deepEqual(click.screenshot, { width: 1024, height: 768 });
            assert.deepEqual(click.viewport, { width: 1024, height: 768 });
            assert.deepEqual(click.hit, { tag: calls === 2 ? 'div' : 'button', role: null });
            assert.ok(!JSON.stringify(click).includes('SECRET'));
            if (calls === 2) {
                assert.equal(await page.locator('dialog').count(), 0, 'a miss must not be retargeted');
                return plan({ variant: 'mouse:click', x: 150, y: 125 });
            }
            assert.equal(await page.locator('button').count(), 0, 'hit evidence must precede click mutation');
            assert.equal(await page.locator('dialog').count(), 1);
            return done();
        };
        await agent.act('Open the dialog', { deadline: Date.now() + 15_000 });
        assert.equal(calls, 3);
        assert.ok(!JSON.stringify(snapshots).includes('SECRET'));
        assert.ok(!JSON.stringify(snapshots).includes('http://'));
        agent.models.partialAct = async context => { assert.equal(clickEvidence(context), null); return done(); };
        await agent.act('Inspect a new operation', { memory: agent.memory, deadline: Date.now() + 5000 });
        assert.equal(agent.operation!.lastClick, undefined);
    } finally { await connector.onStop(); }
});

test('custom controls, shadow roots, frames, and unavailable inspection preserve click dispatch', async () => {
    const { agent, connector, page } = await fixture();
    try {
        for (const kind of ['custom', 'shadow', 'frame', 'unavailable']) {
            await page.setContent('<div id="mount"></div><output id="count">0</output>');
            await page.evaluate(kind => {
                const mount = document.querySelector('#mount')!;
                const count = document.querySelector('#count')!;
                const target = document.createElement(kind === 'custom' ? 'secret-control' : 'button');
                target.style.cssText = 'position:fixed;left:50px;top:50px;width:100px;height:50px;display:block';
                target.textContent = 'SECRET_TEXT';
                target.setAttribute('role', kind === 'custom' ? 'SECRET_ROLE' : 'button');
                target.addEventListener('click', () => { count.textContent = '1'; });
                if (kind === 'shadow') mount.attachShadow({ mode: 'open' }).append(target);
                else if (kind === 'frame') {
                    const frame = document.createElement('iframe');
                    frame.style.cssText = 'position:fixed;inset:0;width:400px;height:300px;border:0';
                    mount.append(frame); frame.contentDocument!.body.append(target);
                } else mount.append(target);
                if (kind === 'unavailable') document.elementFromPoint = () => { throw new Error('SECRET_ERROR'); };
            }, kind);
            await agent.exec({ variant: 'mouse:click', x: 100, y: 75 }, undefined, { deadline: Date.now() + 5000 });
            const click = agent.operation!.lastClick!;
            assert.deepEqual(click.hit, kind === 'custom' ? { tag: null, role: null }
                : kind === 'shadow' ? { tag: 'button', role: 'button' } : null);
            assert.equal(click.screenshot, null, 'no screenshot from a prior operation can be attributed to this click');
            assert.equal(await page.locator('#count').innerText(), '1');
            assert.ok(!JSON.stringify(click).includes('SECRET'));
        }
    } finally { await connector.onStop(); }
});

for (const cause of ['signal', 'deadline'] as const) test(`${cause} during click inspection prevents dispatch and stale feedback`, async () => {
    const { agent, connector, page } = await fixture();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const evaluate = page.evaluate.bind(page);
    const controller = new AbortController();
    try {
        const target = await point(page, '#target');
        page.evaluate = (async (fn: any, arg: any) => {
            if (arg && Object.keys(arg).sort().join(',') === 'x,y') {
                entered.resolve(); await release.promise;
            }
            return evaluate(fn, arg);
        }) as typeof page.evaluate;
        const rejected = assert.rejects(agent.exec({ variant: 'mouse:click', ...target }, undefined,
            cause === 'signal' ? { signal: controller.signal } : { deadline: Date.now() + 1000 }),
        cause === 'signal' ? OperationCancelledError : OperationDeadlineError);
        await entered.promise;
        if (cause === 'signal') controller.abort();
        await rejected;
        assert.equal(agent.busy, true);
        release.resolve(); await agent.whenIdle();
        assert.equal(agent.operation!.lastClick, undefined);
        assert.equal(await page.locator('#target').getAttribute('data-events'), '[]');
        page.evaluate = evaluate;
        await agent.exec({ variant: 'mouse:click', ...target });
        assert.deepEqual(agent.operation!.lastClick!.hit, { tag: 'button', role: null });
    } finally { release.resolve(); await connector.onStop(); }
});

test('cancellation from a click diagnostic listener prevents subsequent actions', async () => {
    const { agent, connector, page } = await fixture();
    const controller = new AbortController();
    const onOperation = (snapshot: OperationDiagnostics) => { if (snapshot.lastClick) controller.abort(); };
    agent.events.on('operation', onOperation);
    try {
        const target = await point(page, '#target');
        agent.models.partialAct = async () => plan({ variant: 'mouse:click', ...target }, { variant: 'mouse:click', ...target });
        await assert.rejects(agent.act('Click twice', { signal: controller.signal, deadline: Date.now() + 5000 }), OperationCancelledError);
        await agent.whenIdle();
        const events = JSON.parse((await page.locator('#target').getAttribute('data-events'))!);
        assert.equal(events.filter((event: { type: string }) => event.type === 'click').length, 1);
        assert.equal(agent.operation!.lastClick!.actionIndex, 1);
    } finally { agent.events.off('operation', onOperation); await connector.onStop(); }
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

test('oversized text and headings return bounded evidence without copying the full text', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        for (const size of [16, 64]) {
            await page.evaluate(size => {
                const heading = document.createElement('h1');
                // Keep layout cost separate from the collector's work budget.
                heading.style.cssText = 'content-visibility:hidden;width:100px;height:30px';
                heading.append('Too many requests ' + 'x'.repeat(size * 1024 * 1024));
                document.body.replaceChildren(heading);
                const original = Text.prototype.substringData;
                Text.prototype.substringData = function (offset, count) {
                    if (count > 4096) throw new Error('Unbounded text read');
                    return original.call(this, offset, count);
                };
            }, size);
            const state = await page.evaluate(collectRecoveryState, true);
            assert.equal(state.fingerprint, null);
            assert.equal(state.headings.length, 1);
            assert.equal(state.headings[0].length, 500);
            assert.ok(JSON.stringify(state).length < 600);
            const lightweight = await page.evaluate(collectRecoveryState, false);
            assert.notEqual(lightweight.fingerprint, null, 'disabled loop detection must skip body text');
        }
    } finally { await context.close(); }
});

test('the recovery walk bounds rejected nodes and active form values', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.evaluate(() => {
            for (let i = 0; i < 12_000; i++) {
                const element = document.createElement('div');
                element.style.display = 'none';
                document.body.append(element);
            }
            const original = getComputedStyle;
            let reads = 0;
            window.getComputedStyle = (...args) => {
                if (++reads > 10_000) throw new Error('Unbounded node traversal');
                return original(...args);
            };
        });
        assert.equal((await page.evaluate(collectRecoveryState, true)).fingerprint, null);
        await page.goto('about:blank');
        await page.evaluate(() => {
            const input = document.createElement('textarea');
            input.value = 'x'.repeat(1024 * 1024);
            document.body.append(input);
            input.focus();
        });
        const state = await page.evaluate(collectRecoveryState, true);
        assert.equal(state.fingerprint, null);
        assert.ok(JSON.stringify(state).length < 100);
    } finally { await context.close(); }
});

test('disabled recovery skips the collector while default recovery still detects barriers', async () => {
    for (const recovery of [false, {}] as const) {
        const context = await browser.newContext();
        const connector = new BrowserConnector({ browser: { context }, recovery });
        try {
            await connector.onStart();
            const page = connector.getHarness().page;
            await page.setContent('<h1>Too many requests</h1>');
            const evaluate = page.evaluate.bind(page);
            let calls = 0;
            page.evaluate = (async (fn: any, arg: any) => {
                if (fn === collectRecoveryState) { calls++; assert.equal(arg, false); }
                return evaluate(fn, arg);
            }) as typeof page.evaluate;
            await connector.collectObservations();
            assert.equal(calls, recovery === false ? 0 : 1);
            assert.equal(connector.recovery.block?.reason, recovery === false ? undefined : 'rate_limit');
        } finally { await connector.onStop(); }
    }
});

for (const [reason, heading] of [
    ['subscription', 'Subscribe to Example to continue'],
    ['authentication', 'Sign in to continue'],
] as const) test(`oversized pages retain the ${reason} attempt limit`, async () => {
    const { agent, connector, page } = await fixture();
    try {
        await page.evaluate(heading => {
            document.querySelector('h1')!.textContent = heading;
            const text = document.createElement('p');
            text.style.contentVisibility = 'hidden'; // Isolate collection from layout cost.
            text.append('x'.repeat(300_000));
            document.body.append(text);
        }, heading);
        assert.equal((await page.evaluate(collectRecoveryState, true)).fingerprint, null);
        await connector.collectObservations();
        assert.equal(connector.recovery.block?.reason, reason);
        const click = { variant: 'mouse:click', ...await point(page, '#target') };
        for (let i = 0; i < 3; i++) await agent.exec(click, agent.memory);
        await assert.rejects(agent.exec(click, agent.memory),
            (error: unknown) => error instanceof BrowserBlockedError && error.block.reason === reason);
        assert.equal(connector.recovery.warning, undefined);
        const events = JSON.parse((await page.locator('#target').getAttribute('data-events'))!);
        assert.equal(events.filter((event: { type: string }) => event.type === 'click').length, 3);
        await page.locator('h1').evaluate(element => { element.textContent = 'Accessible content'; });
        await connector.collectObservations();
        assert.equal(connector.recovery.block, undefined);
        await agent.exec(click, agent.memory);
    } finally { await connector.onStop(); }
});

test('unavailable browser fingerprints leave deadlines and session drainage intact', async () => {
    const { agent, connector, page } = await fixture();
    try {
        await page.evaluate(() => {
            const text = document.createElement('p');
            text.style.contentVisibility = 'hidden';
            text.append('x'.repeat(300_000));
            document.body.append(text);
        });
        agent.models.partialAct = async () => plan({ variant: 'wait', seconds: 60 });
        await assert.rejects(agent.act('Wait with unavailable progress evidence', { deadline: Date.now() + 1500 }), OperationDeadlineError);
        await agent.whenIdle();
        assert.equal(agent.busy, false);
        assert.equal(connector.recovery.warning, undefined);
        agent.models.partialAct = async () => done();
        await agent.act('Finish the next operation', { deadline: Date.now() + 5000 });
        assert.equal(agent.operation?.outcome, 'succeeded');
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
