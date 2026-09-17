import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import sharp from 'sharp';
import { Image } from '../../../packages/magnitude-core/src/memory/image';

const screenshot = await new Image(sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png()).toJson();
const injection = '<img src=x onerror="window.injected=true">';
const operation = {
    id: 'operation<&>', kind: 'act', status: 'finished', outcome: 'cancelled', phase: 'preparing', startedAt: 0, elapsedMs: 2000,
    cancellationToDrainMs: 12, cancellationToIdleMs: 23,
    lastAction: { index: 1, name: injection, state: 'completed' }, timings: { model: { count: 2, totalMs: 1234 } },
};
const run = {
    status: 'completed', outcome: 'success', evaluation: { reasoning: injection },
    operation, failureOperation: { ...operation, status: 'draining', lastAction: { ...operation.lastAction, state: 'started' } },
    progress: { phase: 'finished', startedAt: 0, updatedAt: 1, phaseStartedAt: 0, lifecycle: 'stopped', busy: false, network: [], operation },
    cleanup: { status: 'settled', elapsedMs: 30 },
    memory: { observations: [
        { source: 'connector:web', timestamp: 0, data: screenshot },
        { source: 'connector:web', timestamp: 1, data: { url: { type: 'primitive', content: 'https://fixture.invalid/?q=<record>&a=1' }, screenshot } },
        { source: 'action:taken:answer', timestamp: 2, data: { type: 'primitive', content: JSON.stringify({ input: injection }) } },
    ] },
};
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/tasks-summary') return Response.json({ Viewer: [{ id: 'Viewer--0', success: true }] });
    if (path === '/api/task/Viewer--0') return Response.json(run);
    if (path === '/') return new Response(Bun.file(new URL('../viewer.html', import.meta.url)), { headers: { 'content-type': 'text/html' } });
    return new Response('Not found', { status: 404 });
} });
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator('.task-item').click();
    const images = page.locator('.observation-image');
    await images.first().waitFor();
    assert.equal(await images.count(), 2);
    for (const image of await images.all()) {
        await image.evaluate(async image => { await (image as HTMLImageElement).decode(); });
        assert.equal(await image.evaluate(image => (image as HTMLImageElement).naturalWidth), 2);
    }
    const content = await page.locator('#content').innerText();
    assert.ok(!content.includes(screenshot.base64));
    assert.ok(content.includes('https://fixture.invalid/?q=<record>&a=1'));
    assert.ok(content.includes(injection));
    assert.ok(content.includes('Operation diagnostics'));
    assert.ok(content.includes('operation<&>'));
    assert.ok(content.includes('Cancellation to idle: 23 ms'));
    assert.ok(content.includes('1234'));
    assert.ok(content.includes('Cleanup: settled'));
    assert.equal(await page.locator('#content img').count(), 2, 'observation and model text cannot inject HTML');
    assert.equal(await page.evaluate(() => (window as any).injected), undefined);
    console.log('PASS: legacy and structured screenshots render as images, with URLs and escaped model/observation text');
} finally { await browser.close(); server.stop(true); }
