import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'patchright';
import { Agent } from '../../../packages/magnitude-core/src/agent';
import { BrowserConnector, type BrowserConnectorOptions } from '../../../packages/magnitude-core/src/connectors/browserConnector';
import { ActionLimitError, OperationCancelledError, OperationDeadlineError } from '../../../packages/magnitude-core/src/agent/errors';
import { BrowserBlockedError } from '../../../packages/magnitude-core/src/web/recovery';
import type { AgentContext } from '../../../packages/magnitude-core/src/ai/baml_client';
import type { OperationDiagnostics } from '../../../packages/magnitude-core/src/common/operation';
import { AgentMemory } from '../../../packages/magnitude-core/src/memory/agentMemory';
import { createAction } from '../../../packages/magnitude-core/src/actions';

const cases: { name: string; check: () => Promise<void> }[] = [];
function test(name: string, check: () => Promise<void>) { cases.push({ name, check }); }
let browser: Browser;
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    if (new URL(request.url).pathname === '/download') return new Response('fixture bytes', {
        headers: { 'content-disposition': 'attachment; filename="fixture.txt"', 'content-type': 'text/plain' },
    });
    return new Response('<h1>Destination</h1>', { headers: { 'content-type': 'text/html' } });
} });
const base = `http://127.0.0.1:${server.port}`;
const body = '<section><h2>Record one</h2><button id="target">Open</button></section><input id="input">';
const plan = (...actions: { variant: string; [key: string]: unknown }[]) => ({ reasoning: 'Deterministic fixture', memory_updates: [], actions });
const done = () => plan({ variant: 'task:done', evidence: 'Fixture verified independently' });
type Controls = { scope: string; truncated: boolean; controls: { ref: string; label: string; context: string; role: string; enabled: boolean; ambiguous: boolean }[] };
function controls(context: AgentContext): Controls {
    const messages = context.observationContent.map(message => message.content.filter(part => typeof part === 'string').join(''))
        .filter(text => text.includes('"scope": "viewport-native-links-and-buttons"'));
    assert.equal(messages.length, 1, 'only the latest control snapshot reaches the planner, including cached contexts');
    return JSON.parse(messages[0].slice(messages[0].indexOf('{')));
}
async function fixture(html = body, options: Partial<BrowserConnectorOptions> = {}, maxActions = 20) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, acceptDownloads: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const connector = new BrowserConnector({ browser: { context }, url: base, groundedControls: true,
        visuals: { animateCursor: false }, ...options });
    const agent = new Agent({ connectors: [connector], telemetry: false, maxActions,
        llm: { provider: 'anthropic', options: { model: 'claude-fixture', apiKey: 'unused' } } });
    agent.models.setup = async () => {};
    await agent.start();
    const page = connector.getHarness().page;
    await page.setContent(`<style>button,a {display:inline-block;min-width:100px;min-height:35px}</style>${html}
        <script>document.body.dataset.clicked='[]';document.addEventListener('click',e=>document.body.dataset.clicked=JSON.stringify([...JSON.parse(document.body.dataset.clicked),e.target.id]));</script>`);
    return { agent, connector, page, context };
}
const clicks = (page: Page) => page.evaluate(() => JSON.parse(document.body.dataset.clicked!) as string[]);

test('CSS-hidden controls never enter model-facing controls or saved memory', async () => {
    const { agent } = await fixture(`<section><h2>CSS_HIDDEN_CONTEXT</h2>
        <button aria-label="CSS_HIDDEN_LABEL" style="visibility:hidden">Hidden</button></section>
        <button aria-label="CSS_COLLAPSED_LABEL" style="visibility:collapse">Collapsed</button>
        <button aria-label="CSS_TRANSPARENT_LABEL" style="opacity:0">Transparent</button><button>Visible</button>`);
    try {
        agent.models.partialAct = async context => {
            assert.deepEqual(controls(context).controls.map(item => item.label), ['Visible']);
            assert.ok(!JSON.stringify(context.observationContent).includes('CSS_HIDDEN'));
            return done();
        };
        await agent.act('Observe visible controls only');
        assert.ok(!JSON.stringify(await agent.memory.toJSON()).includes('CSS_HIDDEN'));
    } finally { await agent.stop(); }
});

test('a link reference cannot activate an independently interactive descendant', async () => {
    for (const nested of [
        '<button type="submit" id="nested"><span id="hit">Delete record</span></button>',
        '<input type="checkbox" id="nested">',
        '<label for="external" id="nested"><span id="hit">Toggle other field</span></label>',
        '<span role="button" id="nested"><span id="hit">Custom action</span></span>',
        '<span tabindex="0" id="nested"><span id="hit">Focusable action</span></span>',
        '<span contenteditable="true" id="nested"><span id="hit">Edit record</span></span>',
    ]) {
        const { agent, page } = await fixture(`<style>#target{position:relative;width:240px;height:80px}#nested{position:absolute;inset:0;width:100%;height:100%;margin:0}#hit{display:block;width:100%;height:100%}</style>
            <form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'">
            <a id="target" href="${base}/record" aria-label="View record" onclick="if(event.target===this)event.preventDefault()">${nested}</a>
            <input type="checkbox" id="external"></form>`);
        try {
            let calls = 0;
            agent.models.partialAct = async context => {
                const snapshot = controls(context);
                if (++calls === 1) {
                    assert.deepEqual(snapshot.controls.map(item => item.label), ['View record']);
                    return plan({ variant: 'browser:click', ref: snapshot.controls[0].ref });
                }
                assert.deepEqual(await clicks(page), []);
                assert.equal(await page.locator('#external').isChecked(), false);
                assert.equal(await page.locator('body').getAttribute('data-submitted'), null);
                assert.equal(agent.operation?.lastClick, undefined);
                assert.ok(JSON.stringify(context.observationContent).includes('target_unavailable'));
                return done();
            };
            await agent.act('Open the record, not a nested action');
            if (nested.startsWith('<button')) {
                await page.locator('#nested').click();
                assert.equal(await page.locator('body').getAttribute('data-submitted'), 'yes', 'the fixture must contain an active submit control');
            }
        } finally { await agent.stop(); }
    }
});

test('ordinary text and icon descendants still activate their observed control', async () => {
    for (const inner of ['<span id="hit">Open</span>', '<svg role="img" width="120" height="40"><rect id="hit" width="120" height="40" /></svg>']) {
        const { agent, page } = await fixture(`<button id="target" aria-label="Open record" style="padding:0;border:0">${inner}</button>`);
        try {
            let calls = 0;
            agent.models.partialAct = async context => {
                if (++calls === 1) return plan({ variant: 'browser:click', ref: controls(context).controls[0].ref });
                assert.deepEqual(await clicks(page), ['hit']);
                return done();
            };
            await agent.act('Click the text or icon belonging to the button');
        } finally { await agent.stop(); }
    }
});

test('grounded clicks follow preparatory actions in a new plan and can follow memory writes', async () => {
    const { agent, connector, page } = await fixture();
    try {
        assert.match(connector.getActionSpace().find(action => action.name === 'browser:click')!.description!, /sole non-memory action/);
        assert.match((await connector.getInstructions())!, /sole non-memory action/);
        let calls = 0;
        let previousRef = '';
        agent.models.partialAct = async context => {
            const ref = controls(context).controls[0].ref;
            if (++calls === 1) {
                previousRef = ref;
                return plan({ variant: 'wait', seconds: 0 });
            }
            if (calls === 2) {
                assert.notEqual(ref, previousRef);
                return { ...plan({ variant: 'browser:click', ref }), memory_updates: [{
                    operation: 'add', expected_text: null, key: 'record', text: 'Record one is visible.', sources: [0],
                }] };
            }
            assert.equal(calls, 3);
            assert.deepEqual(await clicks(page), ['target']);
            assert.ok(JSON.stringify(await agent.memory.toJSON()).includes('Record one is visible.'));
            assert.ok(!JSON.stringify(context.observationContent).includes('target_unavailable'));
            return done();
        };
        await agent.act('Prepare, then select a fresh reference');
    } finally { await agent.stop(); }
});

test('disabled mode adds neither controls, action, instructions, nor DOM capture', async () => {
    const { agent, connector, page } = await fixture(body, { groundedControls: false });
    try {
        page.evaluateHandle = async () => { throw new Error('Disabled observer must not run'); };
        assert.ok(!connector.getActionSpace().some(action => action.name === 'browser:click'));
        assert.ok(!(await connector.getInstructions())?.includes('browser-controls'));
        agent.models.partialAct = async context => {
            assert.ok(!JSON.stringify(context.observationContent).includes('viewport-native-links-and-buttons'));
            return done();
        };
        await agent.act('No new observation path');
    } finally { await agent.stop(); }
});

test('caller-defined browser:click results do not stop the action batch', async () => {
    let markers = 0;
    let calls = 0;
    const agent = new Agent({ telemetry: false, actions: [
        createAction({ name: 'browser:click', resolver: async () => ({ clicked: false }) }),
        createAction({ name: 'marker', resolver: async () => { markers++; } }),
        createAction({ name: 'finish', resolver: async ({ agent }) => { agent.queueDone(); } }),
    ] });
    agent.models.setup = async () => {};
    agent.models.partialAct = async () => {
        assert.equal(++calls, 1, 'custom results must not force replanning');
        return plan({ variant: 'browser:click' }, { variant: 'marker' }, { variant: 'finish' });
    };
    try {
        await agent.act('Keep custom action semantics');
        assert.equal(markers, 1);
    } finally { await agent.stop(); }
});

for (const mutation of ['moved', 'unrelated']) test(`observed target remains usable after ${mutation} changes`, async () => {
    const { agent, page } = await fixture(body, { virtualScreenDimensions: { width: 512, height: 384 } });
    try {
        let calls = 0;
        const diagnostics: OperationDiagnostics[] = [];
        agent.events.on('operation', event => diagnostics.push(event));
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            if (++calls === 1) {
                assert.equal(snapshot.controls.length, 1);
                if (mutation === 'moved') await page.locator('#target').evaluate(node => (node as HTMLElement).style.transform = 'translateY(24px)');
                else await page.evaluate(() => document.body.append(document.createElement('aside')));
                return plan({ variant: 'browser:click', ref: snapshot.controls[0].ref });
            }
            assert.deepEqual(await clicks(page), ['target']);
            assert.equal(agent.operation?.lastClick?.hit?.tag, 'button');
            assert.deepEqual(agent.operation?.lastClick?.screenshot, { width: 512, height: 384 });
            return done();
        };
        await agent.act('Open the observed record');
        assert.equal(calls, 2);
        assert.ok(!JSON.stringify(diagnostics).includes('Record one'));
    } finally { await agent.stop(); }
});

const mutations: Record<string, (page: Page) => Promise<unknown>> = {
    replaced: page => page.locator('#target').evaluate(node => node.replaceWith(node.cloneNode(true))),
    detached: page => page.locator('#target').evaluate(node => node.remove()),
    hidden: page => page.locator('#target').evaluate(node => (node as HTMLElement).style.display = 'none'),
    disabled: page => page.locator('#target').evaluate(node => (node as HTMLButtonElement).disabled = true),
    covered: page => page.evaluate(() => { const overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;inset:0;z-index:9999'; document.body.append(overlay); }),
    renamed: page => page.locator('#target').evaluate(node => node.setAttribute('aria-label', 'Different action')),
    context_changed: page => page.locator('h2').evaluate(node => node.textContent = 'Different record'),
    context_replaced: page => page.locator('section').evaluate(node => { const copy = node.cloneNode(false) as Element; node.replaceWith(copy); copy.append(...node.childNodes); }),
    hover_replaced: page => page.locator('#target').evaluate(node => node.addEventListener('pointerenter', () => node.replaceWith(node.cloneNode(true)), { once: true })),
};
for (const [name, mutate] of Object.entries(mutations)) test(`${name} targets reject before click and stop the remaining batch`, async () => {
    const { agent, page } = await fixture();
    try {
        let calls = 0;
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            if (++calls === 1) {
                const ref = snapshot.controls[0].ref;
                await mutate(page);
                return plan({ variant: 'browser:click', ref }, { variant: 'keyboard:type', content: 'MUST_NOT_TYPE' });
            }
            assert.deepEqual(await clicks(page), []);
            assert.ok(JSON.stringify(context.observationContent).includes('target_unavailable'));
            assert.equal(await page.locator('#input').inputValue(), '');
            assert.equal(agent.operation?.lastClick, undefined);
            return done();
        };
        await agent.act('Reject stale control', { deadline: Date.now() + 10_000 });
        assert.equal(calls, 2);
    } finally { await agent.stop(); }
});

test('duplicate labels require distinguishing context, independent of DOM order', async () => {
    for (const reverse of [false, true]) {
        const sections = ['Alpha', 'Beta'].map(name => `<section><h2>${name}</h2><button id="${name}">Open</button></section>`);
        const { agent, page } = await fixture((reverse ? sections.reverse() : sections).join(''));
        try {
            let calls = 0;
            agent.models.partialAct = async context => {
                const snapshot = controls(context);
                if (++calls === 1) return plan({ variant: 'browser:click', ref: snapshot.controls.find(item => item.context === 'Beta')!.ref });
                assert.deepEqual(await clicks(page), ['Beta']);
                return done();
            };
            await agent.act('Open Beta');
        } finally { await agent.stop(); }
    }
});

test('indistinguishable controls and invented refs cannot trigger input', async () => {
    const { agent, page } = await fixture('<button>Open</button><button>Open</button>');
    try {
        let calls = 0;
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            assert.ok(snapshot.controls.every(item => item.ambiguous));
            if (++calls === 1) return plan({ variant: 'browser:click', ref: snapshot.controls[0].ref });
            if (calls === 2) return plan({ variant: 'browser:click', ref: 'invented:0' });
            assert.deepEqual(await clicks(page), []);
            return done();
        };
        await agent.act('No guessed targets');
    } finally { await agent.stop(); }
});

test('changed link destination and document invalidate references', async () => {
    for (const change of ['href', 'document']) {
        const { agent, page } = await fixture(`<a id="target" href="${base}/one">Open</a>`);
        try {
            let calls = 0;
            agent.models.partialAct = async context => {
                const snapshot = controls(context);
                if (++calls === 1) {
                    const ref = snapshot.controls[0].ref;
                    if (change === 'href') await page.locator('#target').evaluate(node => node.setAttribute('href', '/other'));
                    else await page.goto(`${base}/new-document`);
                    return plan({ variant: 'browser:click', ref });
                }
                assert.equal(agent.operation?.lastClick, undefined);
                assert.equal(page.url(), change === 'href' ? base + '/' : `${base}/new-document`);
                return done();
            };
            await agent.act('Keep observed identity');
        } finally { await agent.stop(); }
    }
});

test('native button activation attribute changes invalidate references', async () => {
    for (const attribute of ['popovertarget', 'popovertargetaction', 'commandfor', 'command']) {
        const { agent, page } = await fixture('<button type="button" id="target" popovertarget="first" popovertargetaction="show" commandfor="first" command="show-popover">Open</button><div id="first" popover>First</div><div id="second" popover>Second</div>');
        try {
            let calls = 0;
            agent.models.partialAct = async context => {
                if (++calls === 1) {
                    const ref = controls(context).controls[0].ref;
                    await page.locator('#target').evaluate((node, attribute) => node.setAttribute(attribute,
                        attribute.endsWith('target') || attribute === 'commandfor' ? 'second' : 'toggle'), attribute);
                    return plan({ variant: 'browser:click', ref });
                }
                assert.deepEqual(await clicks(page), []);
                assert.equal(await page.locator(':popover-open').count(), 0);
                assert.equal(agent.operation?.lastClick, undefined);
                return done();
            };
            await agent.act('Reject changed activation');
        } finally { await agent.stop(); }
    }
});

test('malformed and non-HTTP links are omitted without hiding valid controls', async () => {
    const { agent } = await fixture('<a href="http://[">Malformed</a><a href="javascript:void(0)">Script</a><a href="mailto:test@example.com">Mail</a><button>Valid</button>');
    try {
        agent.models.partialAct = async context => {
            assert.deepEqual(controls(context).controls.map(item => item.label), ['Valid']);
            return done();
        };
        await agent.act('Observe despite invalid links');
    } finally { await agent.stop(); }
});

test('changing a button form owner invalidates refs even when nearby context is unchanged', async () => {
    for (const change of ['association', 'replacement']) {
        const { agent, page } = await fixture('<form id="first"></form><form id="second"></form><section><h2>Same context</h2><button type="button" id="target" form="first">Open</button></section>');
        try {
            let calls = 0;
            agent.models.partialAct = async context => {
                if (++calls === 1) {
                    const ref = controls(context).controls[0].ref;
                    if (change === 'association') await page.locator('#target').evaluate(node => node.setAttribute('form', 'second'));
                    else await page.locator('#first').evaluate(node => node.replaceWith(node.cloneNode(true)));
                    return plan({ variant: 'browser:click', ref });
                }
                assert.deepEqual(await clicks(page), []);
                assert.equal(agent.operation?.lastClick, undefined);
                return done();
            };
            await agent.act('Keep the original form context');
        } finally { await agent.stop(); }
    }
});

test('unsupported surfaces and sensitive inputs do not enter control payloads', async () => {
    const { agent } = await fixture(`<input type="password" value="SECRET_PASSWORD"><input value="SECRET_VALUE">
        <form><button>Submit</button></form><div role="button">Custom</div><iframe srcdoc="<button>Frame</button>"></iframe>
        <div id="shadow"></div><script>shadow.attachShadow({mode:'open'}).innerHTML='<button>Shadow</button>'</script>
        <button hidden>Hidden</button><button style="position:absolute;top:3000px">Offscreen</button><button id="normal">Visible</button>`);
    try {
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            assert.deepEqual(snapshot.controls.map(item => item.label), ['Visible']);
            assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
            return done();
        };
        await agent.act('Observe supported controls');
    } finally { await agent.stop(); }
});

test('control count, scan count, and serialized payload are bounded', async () => {
    for (const count of [100, 513]) {
        const { agent } = await fixture(Array.from({ length: count }, (_, i) => `<button style="position:fixed;top:10px;left:10px">${i}-${'界'.repeat(70)}</button>`).join(''));
        try {
            agent.models.partialAct = async context => {
                const snapshot = controls(context);
                assert.equal(snapshot.truncated, true);
                assert.ok(snapshot.controls.length <= 64);
                assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 16_384);
                if (count === 513) assert.equal(snapshot.controls.length, 0);
                return done();
            };
            await agent.act('Bound observer');
        } finally { await agent.stop(); }
    }
});

test('references cannot cross observations, operations, or checkpoint restoration', async () => {
    const { agent, page } = await fixture();
    try {
        let ref = '';
        agent.models.partialAct = async context => { ref = controls(context).controls[0].ref; return done(); };
        await agent.act('Capture previous ref');
        const memory = new AgentMemory();
        await memory.loadJSON(JSON.parse(JSON.stringify(await agent.memory.toJSON())));
        let calls = 0;
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            assert.notEqual(snapshot.controls[0].ref, ref);
            if (++calls === 1) return plan({ variant: 'browser:click', ref });
            assert.deepEqual(await clicks(page), []);
            return done();
        };
        await agent.act('Reject previous operation', { memory });
    } finally { await agent.stop(); }
});

test('grounded clicks share recovery guards and action limits', async () => {
    for (const recovery of [false, { noProgress: true, repeatedActionLimit: 3 }] as const) {
        const { agent, page } = await fixture(body, { recovery }, recovery ? 20 : 2);
        try {
            agent.models.partialAct = async context => plan({ variant: 'browser:click', ref: controls(context).controls[0].ref });
            await assert.rejects(agent.act('Inert target', { deadline: Date.now() + 15_000 }), recovery ? BrowserBlockedError : ActionLimitError);
            assert.ok((await clicks(page)).length <= (recovery ? 3 : 2));
        } finally { await agent.stop(); }
    }
});

test('pagination removal produces fresh evidence without duplicate activation', async () => {
    const { agent, page } = await fixture('<button id="target" onclick="document.querySelector(\'p\').textContent=\'Records 4, 5, 6\';this.remove()">More</button><p>Records 1, 2, 3</p>');
    try {
        let calls = 0;
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            if (++calls === 1) return plan({ variant: 'browser:click', ref: snapshot.controls[0].ref });
            assert.equal(snapshot.controls.length, 0);
            assert.equal(await page.locator('p').innerText(), 'Records 4, 5, 6');
            assert.deepEqual(await clicks(page), ['target']);
            return done();
        };
        await agent.act('Load the next records');
    } finally { await agent.stop(); }
});

test('download evidence and click diagnostics survive the grounded path', async () => {
    const { agent, page } = await fixture(`<a id="target" href="${base}/download">Download</a>`);
    try {
        const downloaded = page.waitForEvent('download');
        let calls = 0;
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            if (++calls === 1) return plan({ variant: 'browser:click', ref: snapshot.controls[0].ref });
            const file = await downloaded;
            assert.equal(await file.failure(), null);
            if (calls === 2) return plan({ variant: 'wait', seconds: 0 });
            const evidence = context.observationContent.map(message => message.content.filter(part => typeof part === 'string').join(''))
                .findLast(text => text.includes('"downloads":'))!;
            assert.ok(evidence.includes('completed'), evidence);
            assert.equal(agent.operation?.lastClick?.hit?.tag, 'a');
            return done();
        };
        await agent.act('Download fixture');
    } finally { await agent.stop(); }
});

test('cancellation and deadline after planning cause no click or fallback', async () => {
    for (const deadline of [false, true]) {
        const { agent, page } = await fixture();
        try {
            const controller = new AbortController();
            let calls = 0;
            agent.models.partialAct = async context => {
                calls++;
                const ref = controls(context).controls[0].ref;
                if (deadline) await new Promise(resolve => setTimeout(resolve, 350));
                else controller.abort();
                return plan({ variant: 'browser:click', ref });
            };
            await assert.rejects(agent.act('Cancel selection', { signal: controller.signal,
                deadline: Date.now() + (deadline ? 250 : 10_000) }), deadline ? OperationDeadlineError : OperationCancelledError);
            await agent.whenIdle();
            assert.deepEqual(await clicks(page), []);
            assert.ok(calls <= 1);
            assert.equal(agent.busy, false);
        } finally { await agent.stop(); }
    }
});

test('post-dispatch observation failure is terminal and does not replay the click', async () => {
    const { agent, connector, page } = await fixture();
    try {
        let calls = 0;
        agent.models.partialAct = async context => { calls++; return plan({ variant: 'browser:click', ref: controls(context).controls[0].ref }); };
        agent.events.on('actionDone', action => {
            if (action.variant === 'browser:click') connector.collectObservations = async () => { throw new Error('fixture capture failed after input'); };
        });
        await assert.rejects(agent.act('Preserve uncertain outcome'), /fixture capture failed after input/);
        assert.equal(calls, 1);
        assert.deepEqual(await clicks(page), ['target']);
        assert.ok(agent.operation?.lastClick);
        assert.ok(JSON.stringify(await agent.memory.toJSON()).includes('browser:click'));
    } finally { await agent.stop(); }
});

test('cancelling during pointer movement prevents click dispatch and drains before reuse', async () => {
    const { agent, connector, page } = await fixture();
    try {
        const controller = new AbortController();
        connector.getHarness().visualizer.moveVirtualCursor = async () => { controller.abort(); };
        let calls = 0;
        agent.models.partialAct = async context => { calls++; return plan({ variant: 'browser:click', ref: controls(context).controls[0].ref }); };
        await assert.rejects(agent.act('Cancel before dispatch', { signal: controller.signal }), OperationCancelledError);
        await agent.whenIdle();
        assert.equal(calls, 1);
        assert.deepEqual(await clicks(page), []);
        assert.equal(agent.operation?.lastClick, undefined);
        assert.equal(agent.busy, false);
    } finally { await agent.stop(); }
});

test('an intervening observation invalidates remaining refs in a batch', async () => {
    const { agent, page } = await fixture();
    try {
        let calls = 0;
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            if (++calls === 1) return plan({ variant: 'wait', seconds: 0 },
                { variant: 'browser:click', ref: snapshot.controls[0].ref }, { variant: 'keyboard:type', content: 'MUST_NOT_TYPE' });
            assert.deepEqual(await clicks(page), []);
            assert.equal(await page.locator('#input').inputValue(), '');
            return done();
        };
        await agent.act('Reject expired batch ref');
    } finally { await agent.stop(); }
});

test('switching the active page cannot redirect an old reference into the new page', async () => {
    const { agent, connector, page, context: browserContext } = await fixture();
    try {
        let calls = 0;
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            if (++calls === 1) {
                const ref = snapshot.controls[0].ref;
                const second = await browserContext.newPage();
                await second.goto(base);
                await connector.getHarness().switchTab({ index: 1 });
                return plan({ variant: 'browser:click', ref });
            }
            assert.deepEqual(await clicks(page), []);
            assert.equal(agent.operation?.lastClick, undefined);
            return done();
        };
        await agent.act('Do not cross tabs');
    } finally { await agent.stop(); }
});

try {
    browser = await chromium.launch({ headless: true });
    for (const entry of cases) { await entry.check(); console.log(`PASS: ${entry.name}`); }
} finally { await browser!?.close(); server.stop(true); }
