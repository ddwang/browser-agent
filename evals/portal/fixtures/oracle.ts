import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { readOracle } from '../oracle';

const browser = await chromium.launch({ headless: true });
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<h1>Fixture</h1>', { headers: { 'content-type': 'text/html' } }) });
try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.goto(`http://127.0.0.1:${server.port}/?id=result-1`);
    const cases = [
        ['login', '<input type="password">'],
        ['verification', '<input name="code">'],
        ['loading', '<p role="status">Loading your information…</p>'],
        ['load_error', '<button data-action="retry">Try again</button>'],
        ['results', '<a class="result-row">Result</a>'],
        ['result_detail', '<section class="lab-component">Value: 10</section>'],
        ['empty_results', '<h1>Test Results</h1><div role="status">No results found</div>'],
        ['empty_results', '<h1>Test Results</h1><div class="empty-state">You currently have no test results available to view.</div>'],
        ['other', '<h1>Welcome, fixture</h1>'],
        [null, '<h1>Test Results</h1>'],
        [null, '<input type="password" style="visibility:hidden">'],
        [null, '<a class="result-row" style="position:absolute;top:2000px">Offscreen</a>'],
    ] as const;
    for (const [expected, html] of cases) {
        await page.setContent(html);
        assert.equal((await readOracle(page)).label, expected, html);
    }
    await page.setContent('<h1>Test Results</h1><iframe id="datatilesframe" style="width:900px;height:500px" srcdoc="<p role=\'status\'>Loading your information…</p>"></iframe>');
    await page.frameLocator('#datatilesframe').locator('[role="status"]').waitFor();
    assert.equal((await readOracle(page)).label, 'loading', 'iframe content outranks outer heading');
    await page.locator('#datatilesframe').evaluate(frame => (frame as HTMLElement).style.visibility = 'hidden');
    assert.equal((await readOracle(page)).label, null, 'hidden iframe has no visible evidence');
    await page.locator('#datatilesframe').evaluate(frame => (frame as HTMLElement).style.visibility = 'visible');
    await page.evaluate(() => {
        const overlay = document.createElement('div');
        overlay.id = 'overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:white';
        document.body.append(overlay);
    });
    assert.equal((await readOracle(page)).label, null, 'outer overlay obscures iframe content');
    await page.locator('#overlay').evaluate(node => node.remove());
    await page.locator('#datatilesframe').evaluate(frame => (frame as HTMLElement).style.marginTop = '2000px');
    assert.equal((await readOracle(page)).label, null, 'offscreen iframe has no visible evidence');
    console.log('PASS: 16 browser oracle cases; no model requests');
} finally { await browser.close(); server.stop(true); }
