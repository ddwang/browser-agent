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
let crossBase = '';
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request): Response {
    if (new URL(request.url).pathname === '/download') return new Response('fixture bytes', {
        headers: { 'content-disposition': 'attachment; filename="fixture.txt"', 'content-type': 'text/plain' },
    });
    const path = new URL(request.url).pathname;
    if (path === '/frame-content') return new Response(`<button id="inner" style="width:160px;height:40px" onclick="document.body.dataset.clicked='yes'">Inner action</button>
        <label>Visit type <select id="kind"><option value="">Choose</option><option value="video">Video visit</option><option value="office">Office visit</option></select></label>
        <label>Start date <input id="start" type="date"></label>`, { headers: { 'content-type': 'text/html' } });
    if (path === '/framed') return new Response(`<iframe id="same" src="/frame-content" style="width:600px;height:200px;border:0"></iframe>
        <iframe id="cross" src="${crossBase}/frame-content" style="width:600px;height:200px;border:0"></iframe>`, { headers: { 'content-type': 'text/html' } });
    if (path === '/two-buttons') return new Response(`<button onclick="document.body.dataset.clicked='target'">Target</button><button onclick="document.body.dataset.clicked='wrong'">Wrong</button>`, { headers: { 'content-type': 'text/html' } });
    if (path === '/scaled-frame') return new Response(`<iframe id="scaled" src="/two-buttons" style="transform:scale(0.5);transform-origin:0 0;width:800px;height:300px;border:0"></iframe>`, { headers: { 'content-type': 'text/html' } });
    if (path === '/invisible-frames') return new Response(`<iframe id="clear" src="/frame-content" style="opacity:0;width:600px;height:150px;border:0"></iframe>
        <div style="opacity:0"><iframe id="nested" src="/frame-content" style="width:600px;height:150px;border:0"></iframe></div>
        <iframe id="shown" src="/frame-content" style="width:600px;height:150px;border:0"></iframe>`, { headers: { 'content-type': 'text/html' } });
    if (path === '/hidden-options') return new Response(`<style>.gone{display:none}.faded{visibility:hidden}</style>
        <label>Pick <select id="pick"><option value="shown">Shown</option><optgroup hidden label="Secret"><option value="secret">Secret</option></optgroup>
        <option class="gone" value="gone">Gone</option><option class="faded" value="faded">Faded</option></select></label>`, { headers: { 'content-type': 'text/html' } });
    if (path === '/form-content') return new Response(`<form onsubmit="event.preventDefault();document.body.dataset.submitted=JSON.stringify([kind.value,start.value,end.value])">
        <label>Visit type <select id="kind"><option value="">Choose</option><option value="video">Video visit</option></select></label>
        <label>Start date <input id="start" type="date"></label><label>End date <input id="end" type="date"></label>
        <button id="find">Find visits</button><input type="submit" value="Search again"><button type="reset">Clear</button></form>`, { headers: { 'content-type': 'text/html' } });
    if (path === '/framed-form') return new Response(`<iframe id="form" src="/form-content" style="width:900px;height:200px;border:0"></iframe>`, { headers: { 'content-type': 'text/html' } });
    if (path === '/done') return new Response('<h1>Done</h1>', { headers: { 'content-type': 'text/html' } });
    if (path === '/fields') return new Response(`<label>Due <input id="due" type="date" value="2026-09-29"></label>
        <label>Letter <select id="letter"><option value="a">A</option><option value="b-disabled" disabled>B</option><option value="b-enabled">B</option>
        <optgroup label="Closed" disabled><option value="c">C</option></optgroup><option value="shown" label="Displayed label">Internal text</option></select></label>
        <label>Go <select id="go" onchange="location.href='/done'"><option value="">Stay</option><option value="done">Done page</option></select></label>
        <label>Notes <input id="notes"></label>
        ${new URL(request.url).searchParams.has('covered') ? '<div style="position:fixed;inset:0;background:rgba(0,0,0,.01)"></div>' : ''}`, { headers: { 'content-type': 'text/html' } });
    if (path === '/covered-frame') return new Response(`<iframe id="same" src="/frame-content" style="width:600px;height:200px;border:0"></iframe>
        <div style="position:absolute;left:0;top:0;width:600px;height:200px;background:rgba(0,0,0,.01)"></div>`, { headers: { 'content-type': 'text/html' } });
    if (new URL(request.url).pathname === '/dialog-select') return new Response(`<button id="open">Compose</button><dialog id="compose">
        <label>To <select id="to" style="width:400px;height:40px"><option value="">Choose a recipient</option><option value="ellis">Dr. Noah Ellis</option>
        <option value="brooks">Dr. Elena Brooks</option><option value="closed" disabled>Dr. Closed Clinic</option></select></label></dialog>
        <script>document.getElementById('open').onclick = () => compose.showModal()</script>`, { headers: { 'content-type': 'text/html' } });
    return new Response('<h1>Destination</h1>', { headers: { 'content-type': 'text/html' } });
} });
const base = `http://127.0.0.1:${server.port}`;
// A different port is a different origin, so this frame runs out of process from the page.
const crossServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request: Request): Response | Promise<Response> => server.fetch(request) });
crossBase = `http://127.0.0.1:${crossServer.port}`;
const body = '<section><h2>Record one</h2><button id="target">Open</button></section><input id="input">';
const plan = (...actions: { variant: string; [key: string]: unknown }[]) => ({ reasoning: 'Deterministic fixture', memory_updates: [], actions });
const done = () => plan({ variant: 'task:done', evidence: 'Fixture verified independently' });
type Controls = { scope: string; truncated: boolean; controls: { ref: string; label: string; context: string; role: string; enabled: boolean; ambiguous: boolean }[] };
function controls(context: AgentContext): Controls {
    const messages = context.observationContent.map(message => message.content.filter(part => typeof part === 'string').join(''))
        .filter(text => text.includes('"scope": "viewport-links-buttons-and-native-fields"'));
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

test('controls inside same-origin and cross-origin frames are listed in page coordinates and clicked by ref', async () => {
    const { agent, connector, page, context } = await fixture();
    await context.unroute('**/*');
    try {
        await connector.getHarness().navigate(`${base}/framed`);
        let calls = 0;
        agent.models.partialAct = async ctx => {
            const inner = controls(ctx).controls.filter(item => item.label === 'Inner action');
            if (++calls === 1) {
                assert.equal(inner.length, 2, 'one button per frame');
                assert.ok(inner.every(item => item.ambiguous), 'identical controls in two frames are ambiguous');
                return plan({ variant: 'browser:click', ref: inner[0].ref });
            }
            assert.ok(JSON.stringify(ctx.observationContent).includes('target_unavailable'), 'an ambiguous ref is rejected');
            return done();
        };
        await agent.act('Click the inner action');
        for (const id of ['same', 'cross']) assert.equal(await page.frameLocator(`#${id}`).locator('body').getAttribute('data-clicked'), null);
        // Remove the duplicate, then click the cross-origin frame's button by reference.
        await page.frameLocator('#same').locator('#inner').evaluate(node => node.remove());
        calls = 0;
        agent.models.partialAct = async ctx => {
            if (++calls === 1) return plan({ variant: 'browser:click', ref: controls(ctx).controls.find(item => item.label === 'Inner action')!.ref });
            return done();
        };
        await agent.act('Click the inner action');
        assert.equal(await page.frameLocator('#cross').locator('body').getAttribute('data-clicked'), 'yes');
    } finally { await agent.stop(); }
});

test('a frame covered by another element rejects its references before clicking', async () => {
    const { agent, connector, page } = await fixture();
    try {
        await connector.getHarness().navigate(`${base}/covered-frame`);
        let calls = 0;
        agent.models.partialAct = async ctx => {
            if (++calls === 1) return plan({ variant: 'browser:click', ref: controls(ctx).controls.find(item => item.label === 'Inner action')!.ref });
            assert.ok(JSON.stringify(ctx.observationContent).includes('target_unavailable'));
            return done();
        };
        await agent.act('Click the inner action');
        assert.equal(await page.frameLocator('#same').locator('body').getAttribute('data-clicked'), null);
    } finally { await agent.stop(); }
});

test('native selects and date inputs inside frames are set by reference, and invalid values change nothing', async () => {
    const { agent, connector, page, context } = await fixture();
    await context.unroute('**/*');
    try {
        await connector.getHarness().navigate(`${base}/framed`);
        await page.frameLocator('#same').locator('body').evaluate(body => body.remove());
        const frame = page.frameLocator('#cross');
        type Field = Controls['controls'][number] & { value?: string; options?: string[] };
        const find = (snapshot: Controls, label: string) => snapshot.controls.find(item => item.label === label) as Field;
        const steps: ((snapshot: Controls) => ReturnType<typeof plan>)[] = [
            snapshot => {
                const kind = find(snapshot, 'Visit type');
                assert.deepEqual([kind.role, kind.value, kind.options], ['select', 'Choose', ['Choose', 'Video visit', 'Office visit']]);
                return plan({ variant: 'browser:select', ref: kind.ref, option: 'Telehealth' });
            },
            snapshot => plan({ variant: 'browser:select', ref: find(snapshot, 'Visit type').ref, option: 'Office visit' }),
            snapshot => {
                const start = find(snapshot, 'Start date');
                assert.deepEqual([start.role, start.value], ['date', '']);
                return plan({ variant: 'browser:fill', ref: start.ref, value: '09/30/2026' });
            },
            snapshot => plan({ variant: 'browser:fill', ref: find(snapshot, 'Start date').ref, value: '2026-09-30' }),
        ];
        let calls = 0;
        const observed: string[] = [];
        agent.models.partialAct = async ctx => {
            const text = JSON.stringify(ctx.observationContent);
            if (calls === 1) observed.push(await frame.locator('#kind').inputValue(), String(text.includes('option_unavailable')));
            if (calls === 3) observed.push(await frame.locator('#start').inputValue(), String(text.includes('invalid_value')));
            const step = steps[calls++];
            return step ? step(controls(ctx)) : done();
        };
        await agent.act('Choose an office visit starting September 30, 2026');
        assert.deepEqual(observed, ['', 'true', '', 'true'], 'rejected values change nothing and say why');
        assert.equal(await frame.locator('#kind').inputValue(), 'office');
        assert.equal(await frame.locator('#start').inputValue(), '2026-09-30');
    } finally { await agent.stop(); }
});


test('controls inside a transformed frame are not grounded, so a scaled mapping cannot click the wrong button', async () => {
    const { agent, connector, page } = await fixture();
    try {
        await connector.getHarness().navigate(`${base}/scaled-frame`);
        agent.models.partialAct = async ctx => {
            const labels = controls(ctx).controls.map(item => item.label);
            assert.ok(!labels.includes('Target') && !labels.includes('Wrong'), 'the transformed frame is excluded');
            return done();
        };
        await agent.act('Observe the scaled frame');
        assert.equal(await page.frameLocator('#scaled').locator('body').getAttribute('data-clicked'), null);
    } finally { await agent.stop(); }
});

test('field actions validate before changing anything, choose eligible options by effective label, and report changes that navigate', async () => {
    const { agent, connector, page } = await fixture();
    try {
        await connector.getHarness().navigate(`${base}/fields`);
        type Field = Controls['controls'][number] & { value?: string; options?: string[] };
        const find = (snapshot: Controls, label: string) => snapshot.controls.find(item => item.label === label) as Field;
        const observed: unknown[] = [];
        const steps: ((snapshot: Controls) => ReturnType<typeof plan>)[] = [
            snapshot => {
                assert.deepEqual(find(snapshot, 'Letter').options, ['A', 'B', 'Displayed label'], 'disabled options and disabled groups are omitted; labels are effective labels');
                return plan({ variant: 'browser:fill', ref: find(snapshot, 'Due').ref, value: '09/30/2026' });
            },
            snapshot => plan({ variant: 'browser:select', ref: find(snapshot, 'Letter').ref, option: 'B' }),
            snapshot => plan({ variant: 'browser:select', ref: find(snapshot, 'Letter').ref, option: 'Displayed label' }),
            snapshot => plan({ variant: 'browser:select', ref: find(snapshot, 'Go').ref, option: 'Done page' }),
        ];
        let calls = 0;
        agent.models.partialAct = async ctx => {
            if (calls === 1) observed.push(await page.locator('#due').inputValue());
            if (calls === 2) observed.push(await page.locator('#letter').inputValue());
            if (calls === 3) observed.push(await page.locator('#letter').inputValue());
            if (calls === 4) observed.push(new URL(page.url()).pathname, ctx.observationContent.flatMap(message => message.content)
                .some(part => typeof part === 'string' && part.includes('"changed": true') && part.includes('Done page')));
            const step = steps[calls++];
            return step ? step(controls(ctx)) : done();
        };
        await agent.act('Set the fields');
        assert.deepEqual(observed, ['2026-09-29', 'b-enabled', 'shown', '/done', true],
            'a malformed date leaves the old value; the enabled B and the displayed label are chosen; a navigating change reports success');
    } finally { await agent.stop(); }
});

test('a rejected field action stops the batch, and a covered field is not changed', async () => {
    const { agent, connector, page } = await fixture();
    try {
        await connector.getHarness().navigate(`${base}/fields?covered`);
        await page.locator('#notes').focus();
        let calls = 0;
        agent.models.partialAct = async ctx => {
            const due = controls(ctx).controls.find(item => item.label === 'Due');
            if (++calls === 1) return plan({ variant: 'browser:fill', ref: due!.ref, value: '2026-10-01' }, { variant: 'keyboard:type', content: 'TYPED' });
            return done();
        };
        await agent.act('Change the due date');
        assert.equal(await page.locator('#due').inputValue(), '2026-09-29', 'the covered field is unchanged');
        assert.equal(await page.locator('#notes').inputValue(), '', 'typing after the rejection did not run');
    } finally { await agent.stop(); }
});

test('controls inside an invisible iframe, or one that becomes invisible, are not grounded', async () => {
    const { agent, connector, page } = await fixture();
    try {
        await connector.getHarness().navigate(`${base}/invisible-frames`);
        let calls = 0;
        agent.models.partialAct = async ctx => {
            const inner = controls(ctx).controls.filter(item => item.label === 'Inner action');
            if (++calls === 1) {
                assert.equal(inner.length, 1, 'only the visible frame lists its button');
                // Hide the remaining frame after observation; its reference must now be rejected.
                await page.locator('#shown').evaluate(frame => { (frame as HTMLElement).style.opacity = '0'; });
                return plan({ variant: 'browser:click', ref: inner[0].ref });
            }
            assert.ok(JSON.stringify(ctx.observationContent).includes('target_unavailable'));
            return done();
        };
        await agent.act('Click the inner action');
        for (const id of ['clear', 'nested', 'shown']) assert.equal(await page.frameLocator(`#${id}`).locator('body').getAttribute('data-clicked'), null);
    } finally { await agent.stop(); }
});

test('options hidden directly, by their group, or by CSS are not offered or selectable', async () => {
    const { agent, connector, page } = await fixture();
    try {
        await connector.getHarness().navigate(`${base}/hidden-options`);
        let calls = 0;
        const rejected: boolean[] = [];
        agent.models.partialAct = async ctx => {
            const pick = controls(ctx).controls.find(item => item.label === 'Pick') as Controls['controls'][number] & { options?: string[] };
            if (calls === 0) assert.deepEqual(pick.options, ['Shown']);
            else rejected.push(JSON.stringify(ctx.observationContent).includes('option_unavailable'));
            const option = ['Secret', 'Gone', 'Faded'][calls++];
            return option ? plan({ variant: 'browser:select', ref: pick.ref, option }) : done();
        };
        await agent.act('Pick hidden options');
        assert.deepEqual(rejected, [true, true, true]);
        assert.equal(await page.locator('#pick').inputValue(), 'shown');
    } finally { await agent.stop(); }
});

test('ambiguity counts every eligible control, including ones beyond the list limit', async () => {
    const buttons = ['<button>Duplicate</button>', ...Array.from({ length: 63 }, (_, i) => `<button>Unique ${i}</button>`), '<button>Duplicate</button>'];
    const { agent } = await fixture(`<style>button{min-width:60px!important;min-height:20px!important;margin:0}</style>${buttons.join('')}`);
    try {
        agent.models.partialAct = async ctx => {
            const snapshot = controls(ctx);
            assert.equal(snapshot.truncated, true);
            assert.equal(snapshot.controls[0].label, 'Duplicate');
            assert.equal(snapshot.controls[0].ambiguous, true, 'the duplicate beyond the limit still makes the first ambiguous');
            return done();
        };
        await agent.act('Observe the buttons');
    } finally { await agent.stop(); }
});

test('a select inside a modal dialog is listed with its options and set by reference', async () => {
    const { agent, connector, page } = await fixture();
    try {
        const harness = connector.getHarness();
        await harness.navigate(`${base}/dialog-select`);
        const box = (await page.locator('#open').boundingBox())!;
        await harness.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, { transform: false });
        let calls = 0;
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            if (++calls === 1) {
                const select = snapshot.controls.find(item => item.role === 'select') as Controls['controls'][number] & { options?: string[] };
                assert.deepEqual(select.options, ['Choose a recipient', 'Dr. Noah Ellis', 'Dr. Elena Brooks'], 'disabled options are omitted');
                return plan({ variant: 'browser:select', ref: select.ref, option: 'Dr. Elena Brooks' });
            }
            assert.equal(await page.locator('#to').inputValue(), 'brooks');
            return done();
        };
        await agent.act('Choose Dr. Elena Brooks as the recipient');
        assert.equal(calls, 2);
    } finally { await agent.stop(); }
});

test('open shadow-host and custom-element hit paths reject before click', async () => {
    for (const variant of ['open-custom', 'open-native', 'closed-custom', 'slotted', 'hover-created'] as const) {
        const { agent, page } = await fixture(`<a id="target" href="${base}/record" aria-label="View record" style="width:240px;height:80px"><span id="container"></span></a><input id="input">`);
        try {
            await page.evaluate(variant => {
                const host = document.createElement(variant === 'open-native' || variant === 'slotted' || variant === 'hover-created' ? 'div' : 'record-widget');
                host.id = 'host';
                host.style.cssText = 'display:block;width:240px;height:80px';
                document.querySelector('#container')!.replaceWith(host);
                const attach = () => {
                    const shadow = host.attachShadow({ mode: variant === 'closed-custom' ? 'closed' : 'open' });
                    if (variant === 'slotted') {
                        host.innerHTML = '<span id="label" style="display:block;width:240px;height:80px">View</span>';
                        shadow.innerHTML = '<slot></slot>';
                    } else {
                        shadow.innerHTML = '<form style="margin:0"><button style="width:240px;height:80px">Delete record</button></form>';
                        shadow.querySelector('form')!.addEventListener('submit', event => {
                            event.preventDefault();
                            document.body.dataset.submitted = 'yes';
                        });
                    }
                };
                if (variant === 'hover-created') {
                    host.textContent = 'View';
                    host.addEventListener('pointerenter', attach, { once: true });
                } else attach();
            }, variant);
            let calls = 0;
            agent.models.partialAct = async context => {
                const snapshot = controls(context);
                if (++calls === 1) {
                    assert.deepEqual(snapshot.controls.map(item => item.label), ['View record']);
                    return plan({ variant: 'browser:click', ref: snapshot.controls[0].ref },
                        { variant: 'keyboard:type', content: 'MUST_NOT_TYPE' });
                }
                assert.equal(calls, 2);
                assert.deepEqual(await clicks(page), []);
                assert.equal(await page.locator('body').getAttribute('data-submitted'), null);
                assert.equal(await page.locator('#input').inputValue(), '');
                assert.equal(agent.operation?.lastClick, undefined);
                assert.ok(JSON.stringify(context.observationContent).includes('target_unavailable'));
                if (variant === 'hover-created') assert.equal(await page.locator('#host').evaluate(node => !!node.shadowRoot), true);
                return done();
            };
            await agent.act('Open the observed record without activating a shadow control');
            if (variant === 'open-custom' || variant === 'open-native' || variant === 'closed-custom') {
                const box = (await page.locator('#host').boundingBox())!;
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                assert.equal(await page.locator('body').getAttribute('data-submitted'), 'yes', 'native input really activates the shadow form');
            }
        } finally { await agent.stop(); }
    }
});

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
                // A nested submit button is listed as its own control; the link's ref must not activate it.
                const links = snapshot.controls.filter(item => item.role === 'link');
                if (++calls === 1) {
                    assert.deepEqual(links.map(item => item.label), ['View record']);
                    return plan({ variant: 'browser:click', ref: links[0].ref });
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

test('field actions on refs from one observation share a batch, and a submit button click can end it', async () => {
    const { agent, connector, page } = await fixture();
    try {
        await connector.getHarness().navigate(`${base}/framed-form`);
        const frame = page.frameLocator('#form');
        let calls = 0;
        agent.models.partialAct = async ctx => {
            const snapshot = controls(ctx);
            const ref = (label: string) => snapshot.controls.find(item => item.label === label)!.ref;
            if (++calls === 1) {
                assert.deepEqual(snapshot.controls.filter(item => item.role === 'button').map(item => item.label), ['Find visits', 'Search again'],
                    'submit buttons are listed; reset buttons are not');
                return plan({ variant: 'browser:select', ref: ref('Visit type'), option: 'Video visit' },
                    { variant: 'browser:fill', ref: ref('Start date'), value: '2026-01-01' },
                    { variant: 'browser:fill', ref: ref('End date'), value: '2026-09-30' },
                    { variant: 'browser:click', ref: ref('Find visits') });
            }
            assert.ok(!JSON.stringify(ctx.observationContent).includes('target_unavailable'));
            return done();
        };
        await agent.act('Find video visits from January 1 through September 30, 2026');
        assert.equal(calls, 2, 'the whole form took one plan');
        assert.equal(await frame.locator('body').getAttribute('data-submitted'), JSON.stringify(['video', '2026-01-01', '2026-09-30']));
    } finally { await agent.stop(); }
});

test('a click, another browser action, or a new plan expires refs kept across field actions', async () => {
    const { agent, page } = await fixture('<label>Due <input id="due" type="date" value="2026-09-29"></label><button id="target">Open</button>');
    try {
        const values: string[] = [];
        let calls = 0, earlier = '';
        agent.models.partialAct = async ctx => {
            const snapshot = controls(ctx);
            const ref = (label: string) => snapshot.controls.find(item => item.label === label)!.ref;
            if (calls > 0) values.push(await page.locator('#due').inputValue());
            switch (++calls) {
                case 1: return plan({ variant: 'browser:click', ref: ref('Open') }, { variant: 'browser:fill', ref: ref('Due'), value: '2026-10-01' });
                case 2: return plan({ variant: 'browser:fill', ref: ref('Due'), value: '2026-10-02' }, { variant: 'wait', seconds: 0 },
                    { variant: 'browser:fill', ref: ref('Due'), value: '2026-10-03' });
                case 3: earlier = ref('Due'); return plan({ variant: 'browser:fill', ref: earlier, value: '2026-10-04' });
                case 4: return plan({ variant: 'browser:fill', ref: earlier, value: '2026-10-05' });
                default: return done();
            }
        };
        await agent.act('Change the due date');
        // Each later fill is rejected: after the click, after the wait, and in the plan after the fill's own batch.
        assert.deepEqual(values, ['2026-09-29', '2026-10-02', '2026-10-04', '2026-10-04']);
        assert.deepEqual(await clicks(page), ['target']);
    } finally { await agent.stop(); }
});

test('grounded clicks follow preparatory actions in a new plan and can follow memory writes', async () => {
    const { agent, connector, page } = await fixture();
    try {
        assert.match(connector.getActionSpace().find(action => action.name === 'browser:click')!.description!, /expires references/);
        assert.match((await connector.getInstructions())!, /expires references/);
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
            assert.ok(!JSON.stringify(context.observationContent).includes('viewport-links-buttons-and-native-fields'));
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

test('unsupported surfaces and sensitive inputs do not enter control payloads; frame controls do', async () => {
    const { agent } = await fixture(`<input type="password" value="SECRET_PASSWORD"><input value="SECRET_VALUE">
        <form><button type="reset">Reset</button></form><div role="button">Custom</div><iframe srcdoc="<button>Frame</button>"></iframe>
        <div id="shadow"></div><script>shadow.attachShadow({mode:'open'}).innerHTML='<button>Shadow</button>'</script>
        <button hidden>Hidden</button><button style="position:absolute;top:3000px">Offscreen</button><button id="normal">Visible</button>`);
    try {
        agent.models.partialAct = async context => {
            const snapshot = controls(context);
            assert.deepEqual(snapshot.controls.map(item => item.label), ['Visible', 'Frame']);
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
    for (const entry of cases.filter(test => test.name.includes(process.argv[2] ?? ''))) { await entry.check(); console.log(`PASS: ${entry.name}`); }
} finally { await browser!?.close(); server.stop(true); crossServer.stop(true); }
