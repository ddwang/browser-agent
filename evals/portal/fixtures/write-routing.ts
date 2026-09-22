import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { routeWrite, type WriteEvidence } from '../writes';

let writes = 0, reads = 0;
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/chart') { reads++; return Response.json({ count: writes }); }
    if (path === '/api/action') {
        const body = await request.json() as { subject?: string };
        if (!body.subject) return Response.json({ error: 'Subject required' }, { status: 400 });
        writes++;
        return Response.json({ message: 'Sent' });
    }
    return new Response('<h1>Synthetic transport fixture</h1>', { headers: { 'content-type': 'text/html' } });
} });
const browser = await chromium.launch({ headless: true });
try {
    for (const loseConfirmation of [false, true]) {
        writes = 0; reads = 0;
        const evidence: WriteEvidence = { attempts: 0, successfulResponses: 0, lostResponses: 0, blockedVerificationReads: 0, transportErrors: 0 };
        const page = await browser.newPage();
        await page.route('**/*', route => routeWrite(route, evidence, loseConfirmation));
        await page.goto(`http://127.0.0.1:${server.port}`);
        const submit = (body: object) => page.evaluate(async body => {
            const response = await fetch('/api/action', { method: 'POST', body: JSON.stringify(body) });
            return { status: response.status, body: await response.json() };
        }, body);
        assert.equal((await submit({})).status, 400, 'validation errors must not be replaced with unknown outcomes');
        assert.equal(writes, 0, 'validation failure commits nothing');
        assert.equal(evidence.lostResponses, 0);
        const first = await submit({ subject: 'Fixture message' });
        assert.equal(first.status, loseConfirmation ? 504 : 200);
        assert.equal(writes, 1, 'lost response still commits once on the server');
        assert.equal(await page.evaluate(async () => (await fetch('/api/chart')).status), loseConfirmation ? 503 : 200);
        assert.equal(reads, loseConfirmation ? 0 : 1, 'fault hides subsequent verification, not the earlier write');
        await submit({ subject: 'Fixture message' });
        assert.equal(writes, 2, 'unsafe repetition is observed, not prevented by the evaluator');
        assert.deepEqual(evidence, { attempts: 3, successfulResponses: 2, lostResponses: loseConfirmation ? 2 : 0,
            blockedVerificationReads: loseConfirmation ? 1 : 0, transportErrors: 0 });
        await page.close();
    }
    console.log('PASS: write routing preserves server truth');
} finally { await browser.close(); server.stop(true); }
