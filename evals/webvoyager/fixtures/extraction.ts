import assert from 'node:assert/strict';
import { startBrowserAgent, logger, z } from '../../../packages/magnitude-core/src';

logger.level = 'silent';
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
    return new Response('<h2>Cross-origin records</h2><div hidden>Hidden frame error</div>', {
        headers: { 'content-type': 'text/html' },
    });
} });
const agent = await startBrowserAgent({
    browser: { launchOptions: { headless: true } },
    llm: { provider: 'baseten', options: { model: 'fixture', apiKey: 'unused' } },
    telemetry: false,
});
const cases: { name: string; check: () => Promise<void> }[] = [];
function test(name: string, check: () => Promise<void>) { cases.push({ name, check }); }
let observed = '';
agent.models.extract = async (_instructions, schema, _screenshot, dom) => {
    observed = dom;
    return schema.parse({ text: 'observed' });
};
async function extract() {
    await agent.extract('Describe the page', z.object({ text: z.string() }));
    return observed;
}

test('preserves iframe identity, listeners, input state, and document order', async () => {
    await agent.page.setContent(`<main><p>Before frame</p><iframe srcdoc="<button>Read records</button><input value='initial'>"></iframe><p>After frame</p></main>`);
    const frame = agent.page.frames()[1];
    await frame.locator('input').fill('current');
    await frame.locator('button').evaluate(button => {
        button.addEventListener('click', () => { button.textContent = 'Records opened'; });
    });
    const before = await agent.page.locator('main').innerHTML();
    const content = await extract();
    assert.equal(await agent.page.locator('main').innerHTML(), before);
    assert.equal(agent.page.frames()[1], frame);
    assert.equal(await frame.locator('input').inputValue(), 'current');
    assert.ok(content.includes('current'), content);
    assert.ok(content.indexOf('Before frame') < content.indexOf('Read records'));
    assert.ok(content.indexOf('Read records') < content.indexOf('After frame'));
    await frame.locator('button').click();
    assert.equal(await frame.locator('button').textContent(), 'Records opened');
});

test('keeps bare iframe body text outside the viewport in model input', async () => {
    await agent.page.setContent(`<h1>Account page</h1>
        <iframe style="margin-top:2000px" srcdoc="Payment confirmed: receipt 12345"></iframe>
        <p>After receipt</p>`);
    const frame = agent.page.frames()[1];
    const before = await frame.content();
    assert.ok(await agent.page.locator('iframe').evaluate(element => element.getBoundingClientRect().top > innerHeight));
    const content = await extract();
    assert.ok(content.includes('Payment confirmed: receipt 12345'), content);
    assert.ok(content.indexOf('Account page') < content.indexOf('Payment confirmed'));
    assert.ok(content.indexOf('Payment confirmed') < content.indexOf('After receipt'));
    assert.equal(await frame.content(), before);
    assert.equal(agent.page.frames()[1], frame);
});

test('omits hidden rejection messages and non-rendered content', async () => {
    await agent.page.setContent(`<h1>Dashboard ready</h1>
        <style>.old-error { display: none; }</style>
        <div class="old-error">Class-hidden rejection</div>
        <div hidden>Attribute-hidden rejection</div>
        <div style="visibility:hidden">Invisible rejection</div>
        <div style="opacity:0"><span>Transparent rejection</span></div>
        <div style="content-visibility:hidden">Skipped rejection</div>
        <script type="application/json">{"error":"Script rejection"}</script>
        <template>Template rejection</template>
        <input type="hidden" value="Hidden token">
        <input type="password" value="Password secret">
        <details><summary>More information</summary><p>Collapsed rejection</p></details>`);
    const content = await extract();
    assert.ok(content.includes('Dashboard ready'));
    assert.ok(content.includes('More information'));
    for (const word of ['rejection', 'Hidden token', 'Password secret']) assert.ok(!content.includes(word), content);
});

test('keeps off-screen text, display-contents text, and visibility overrides', async () => {
    await agent.page.setContent(`<div style="display:contents">Unboxed information</div>
        <div style="visibility:hidden">Hidden ancestor text<span style="visibility:visible">Visible child information</span></div>
        <div style="margin-top:2000px">Below the viewport</div>`);
    const content = await extract();
    for (const text of ['Unboxed information', 'Visible child information', 'Below the viewport']) {
        assert.ok(content.includes(text), content);
    }
    assert.ok(!content.includes('Hidden ancestor text'));
});

test('keeps available select choices and table structure', async () => {
    await agent.page.setContent(`<form><label for="category">Category</label>
        <select id="category"><option>Laboratory records</option><option>Visit records</option></select></form>
        <table><tr><th>Test name</th><th>Result</th></tr><tr><td>Example test</td><td>42 units</td></tr></table>`);
    const content = await extract();
    for (const text of ['Laboratory records', 'Visit records', 'Example test', '42 units']) {
        assert.ok(content.includes(text), content);
    }
});

test('reads nested and cross-origin frames without detaching them', async () => {
    await agent.page.setContent(`<iframe srcdoc="<h2>Outer records</h2><iframe src='http://127.0.0.1:${server.port}'></iframe>"></iframe>`);
    const frames = agent.page.frames();
    assert.equal(frames.length, 3);
    const content = await extract();
    assert.ok(content.includes('Outer records'));
    assert.ok(content.includes('Cross-origin records'));
    assert.ok(!content.includes('Hidden frame error'));
    assert.deepEqual(agent.page.frames(), frames);
});

test('omits hidden frames and their descendants', async () => {
    await agent.page.setContent(`<h1>Current page</h1>
        <iframe style="display:none" srcdoc="Hidden frame rejection"></iframe>
        <div style="opacity:0"><iframe srcdoc="Transparent frame rejection"></iframe></div>`);
    const content = await extract();
    assert.ok(!content.includes('rejection'), content);
    assert.equal(await agent.page.locator('iframe').count(), 2);
});

test('repeated reads reflect current visibility without changing the page', async () => {
    await agent.page.setContent('<div id="error" hidden>Current rejection</div>');
    assert.ok(!(await extract()).includes('Current rejection'));
    await agent.page.locator('#error').evaluate(element => { element.removeAttribute('hidden'); });
    assert.ok((await extract()).includes('Current rejection'));
    await agent.page.locator('#error').evaluate(element => { element.setAttribute('hidden', ''); });
    assert.ok(!(await extract()).includes('Current rejection'));
});

test('a failed model call leaves the live frame usable', async () => {
    await agent.page.setContent('<iframe srcdoc="<button>Continue</button>"></iframe>');
    const frame = agent.page.frames()[1];
    agent.models.extract = async () => { throw new Error('fixture failure'); };
    await assert.rejects(extract(), /fixture failure/);
    assert.equal(agent.page.frames()[1], frame);
    await frame.locator('button').click();
});

try {
    let failed = false;
    for (const { name, check } of cases) {
        try { await check(); console.log(`PASS: ${name}`); }
        catch (error) { failed = true; console.error(`FAIL: ${name}`, error); }
    }
    if (failed) process.exitCode = 1;
} finally {
    await agent.stop();
    server.stop(true);
}
