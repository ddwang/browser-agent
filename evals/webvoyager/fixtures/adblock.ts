import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { enableFilterLists } from '../adblock';

const requested: string[] = [];
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const { pathname } = new URL(request.url);
    requested.push(pathname);
    if (pathname.endsWith('.js')) return new Response('document.body.dataset.tracked = "yes";', { headers: { 'content-type': 'text/javascript' } });
    if (pathname.startsWith('/ads/')) return new Response('', { headers: { 'content-type': 'image/gif' } });
    return new Response(`<div class="ad-banner">Advertisement</div><p id="content">Article</p>
        <img src="/ads/pixel.gif"><script src="/tracker.js"></script>`, { headers: { 'content-type': 'text/html' } });
} });
const base = `http://127.0.0.1:${server.port}`;
const runDir = mkdtempSync(join(tmpdir(), 'magnitude-adblock-'));
mkdirSync(join(runDir, 'filter-lists'));
writeFileSync(join(runDir, 'filter-lists', 'fixture.txt'), '##.ad-banner\n/tracker.js$script\n/ads/*\n');
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext();
    const stats = await enableFilterLists(context, runDir, [{ name: 'fixture.txt', sha256: 'unused' }]);
    for (const path of ['/first', '/second']) {
        const page = await context.newPage(); // Each tab needs blocking, not only the first page.
        await page.goto(base + path);
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.ad-banner')!).display === 'none', undefined, { timeout: 5_000 });
        assert.equal(await page.isVisible('#content'), true, 'unmatched content stays visible');
        assert.equal(await page.evaluate(() => document.body.dataset.tracked), undefined, 'blocked script did not run');
        console.log(`PASS: ${path} hides matching elements and blocks matching requests`);
    }
    assert.deepEqual(requested, ['/first', '/second'], 'blocked requests never reach the server');
    assert.equal(stats.blockedRequests, 4);
    console.log('PASS: blocked requests are counted');
} finally {
    await browser.close();
    server.stop(true);
    rmSync(runDir, { recursive: true, force: true });
}
