import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'patchright';
import { enableFilterLists, filteredContextOptions } from '../adblock';

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
const script = (body: string) => new Response(body, { headers: { 'content-type': 'text/javascript' } });
const adPage = `<div class="ad-banner">Advertisement</div><p id="content">Article</p>
    <img src="/ads/pixel.gif"><script src="/tracker.js"></script>`;
// A transparent worker that would route later requests around frame-based filtering.
const worker = `self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', event => event.waitUntil(clients.claim()));
    self.addEventListener('fetch', event => event.respondWith(fetch(event.request)));`;
const workerPage = `<p id="content">Article</p><script>
    const load = () => { const s = document.createElement('script'); s.src = '/tracker.js'; s.onload = s.onerror = () => document.body.dataset.done = '1'; document.head.append(s); };
    // A blocked worker registers but never takes control.
    const controlled = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    navigator.serviceWorker.register('/sw.js').then(() => Promise.race([controlled, new Promise(resolve => setTimeout(resolve, 2000))])).finally(load);
</script>`;

const requested: string[] = [];
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const { pathname } = new URL(request.url);
    requested.push(pathname);
    if (pathname === '/tracker.js') return script('document.body.dataset.tracked = "yes";');
    if (pathname === '/sw.js') return script(worker);
    if (pathname === '/worker') return html(workerPage);
    if (pathname.startsWith('/ads/')) return new Response('', { headers: { 'content-type': 'image/gif' } });
    if (pathname === '/late') return new Response(new ReadableStream({ async start(controller) {
        // The ad arrives after the navigation's initial cosmetic scan.
        controller.enqueue(new TextEncoder().encode('<html><head></head>'));
        await Bun.sleep(1_200);
        controller.enqueue(new TextEncoder().encode('<body><div class="ad-banner">Advertisement</div><p id="content">Article</p></body></html>'));
        controller.close();
    } }), { headers: { 'content-type': 'text/html' } });
    return html(adPage);
} });
const base = `http://127.0.0.1:${server.port}`;
const runDir = mkdtempSync(join(tmpdir(), 'magnitude-adblock-'));
mkdirSync(join(runDir, 'filter-lists'));
writeFileSync(join(runDir, 'filter-lists', 'fixture.txt'), '##.ad-banner\n/tracker.js$script\n/ads/*\n');

async function expectFiltered(page: Page, path: string) {
    await page.goto(base + path);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ad-banner')!).display === 'none', undefined, { timeout: 5_000 });
    assert.equal(await page.isVisible('#content'), true, 'unmatched content stays visible');
    assert.equal(await page.getAttribute('body', 'data-tracked'), null, 'blocked script did not run');
}

const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext(filteredContextOptions);
    const stats = await enableFilterLists(context, runDir, [{ name: 'fixture.txt', sha256: 'unused' }]);
    const page = await context.newPage();
    await expectFiltered(page, '/first');
    await expectFiltered(page, '/late');
    console.log('PASS: same-tab navigations hide elements that arrive after the initial scan');
    await expectFiltered(await context.newPage(), '/second');
    console.log('PASS: new tabs hide matching elements and block matching requests');
    await page.goto(`${base}/worker`);
    await page.waitForSelector('body[data-done]', { state: 'attached' });
    assert.equal(await page.getAttribute('body', 'data-tracked'), null, 'a service worker cannot bypass request filtering');
    console.log('PASS: service workers cannot bypass request filtering');
    assert.deepEqual(requested, ['/first', '/late', '/second', '/worker'], 'blocked requests never reach the server');
    assert.equal(stats.blockedRequests, 5);
    console.log('PASS: blocked requests are counted');
} finally {
    await browser.close();
    server.stop(true);
    rmSync(runDir, { recursive: true, force: true });
}
