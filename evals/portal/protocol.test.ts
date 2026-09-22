import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { askDjev, checkHoldout, djevEndpoint, labels, parseDecision, protocol, protocolRecord } from './protocol';
import { localOrigin } from './portal';
import { stableOracle } from './oracle';
import { replay, summarizeReplay, type Prediction } from './replay';

const endpoint = 'https://model-fixture.api.baseten.co/deployment/pinned/predict';
const response = (choice = 'results') => ({ model: 'fixture-model', answers: { page_state: { type: 'choice', choice,
    probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? 1 : 0])), confidence: 1 } },
    usage: { input_tokens: 10, output_tokens: 1 } });
const fake = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as typeof fetch;

test('only a pinned Baseten endpoint can receive the key', () => {
    expect(djevEndpoint(endpoint)).toBe(endpoint);
    for (const url of ['http://model-fixture.api.baseten.co/deployment/pinned/predict', 'https://evil.example/predict',
        'https://model-fixture.api.baseten.co/environments/production/predict', 'https://inference.baseten.co/v1/chat/completions',
        endpoint + '?secret=x', endpoint.replace('https://', 'https://key@')]) expect(() => djevEndpoint(url)).toThrow();
});

test('browser and control origins must remain loopback-only', () => {
    expect(localOrigin('http://127.0.0.1:4312')).toBe('http://127.0.0.1:4312');
    for (const url of ['https://real-portal.example', 'http://127.0.0.1:4312/path', 'http://user@localhost:4312', 'file:///tmp/mock']) {
        expect(() => localOrigin(url)).toThrow();
    }
});

test('probabilities must cover the exact choice set, sum to one, and agree with the selected label', () => {
    expect(parseDecision(response()).choice).toBe('results');
    for (const raw of [response('invented'), { ...response(), model: '' }, response()]) {
        if (raw.answers.page_state.choice === 'results' && raw.model) raw.answers.page_state.probabilities.results = 0.5;
        expect(() => parseDecision(raw)).toThrow();
    }
    const invalid = response(); invalid.answers.page_state.choice = 'loading';
    expect(() => parseDecision(invalid)).toThrow();
    const missing = response(); delete missing.answers.page_state.probabilities.login;
    expect(() => parseDecision(missing)).toThrow();
});

test('payload contains screenshot and fixed protocol, never evaluator metadata', async () => {
    let calls = 0;
    const result = await askDjev(Buffer.from('synthetic png fixture'), endpoint, 'test-key', new AbortController().signal, fake(async (url, init) => {
        calls++;
        expect(url).toBe(endpoint);
        expect(init.redirect).toBe('error');
        expect(init.headers).toEqual({ Authorization: 'Api-Key test-key', 'Content-Type': 'application/json' });
        expect(JSON.parse(init.body as string)).toEqual({ ...protocol, images: ['data:image/png;base64,' + Buffer.from('synthetic png fixture').toString('base64')] });
        return Response.json(response());
    }));
    expect(result.model).toBe('fixture-model'); expect(calls).toBe(1);
});

test('HTTP errors are one attempt, do not echo provider bodies, and late cancellation discards a decision', async () => {
    let calls = 0;
    await expect(askDjev(Buffer.from('x'), endpoint, 'key', new AbortController().signal, fake(async () => {
        calls++; return new Response('SENTINEL_SECRET', { status: 503 });
    }))).rejects.toThrow('Djev HTTP 503');
    expect(calls).toBe(1);
    const controller = new AbortController();
    await expect(askDjev(Buffer.from('x'), endpoint, 'key', controller.signal, fake(async () => {
        controller.abort(new Error('cancelled')); return Response.json(response());
    }))).rejects.toThrow('cancelled');
    calls = 0;
    await expect(askDjev(Buffer.alloc(5 * 1024 * 1024 + 1), endpoint, 'key', new AbortController().signal, fake(async () => {
        calls++; return Response.json(response());
    }))).rejects.toThrow('image limit');
    expect(calls).toBe(0);
});

test('request deadline reaches the transport without retry', async () => {
    let calls = 0;
    await expect(askDjev(Buffer.from('x'), endpoint, 'key', AbortSignal.timeout(10), fake(async (_url, init) => {
        calls++;
        return new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
    }))).rejects.toThrow();
    expect(calls).toBe(1);
});

test('Kaiser requires explicit acknowledgement and a matching frozen protocol', () => {
    const directory = mkdtempSync(join(tmpdir(), 'portal-protocol-'));
    try {
        const path = join(directory, 'protocol.json');
        writeFileSync(path, JSON.stringify(protocolRecord));
        expect(() => checkHoldout('ucsd', false)).not.toThrow();
        expect(() => checkHoldout('kaiser-permanente', false, path)).toThrow();
        expect(() => checkHoldout('kaiser-permanente', true)).toThrow();
        expect(() => checkHoldout('kaiser-permanente', true, path)).not.toThrow();
        writeFileSync(path, JSON.stringify({ ...protocolRecord, request: {} }));
        expect(() => checkHoldout('kaiser-permanente', true, path)).toThrow('differs');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('transitions and unsupported oracle evidence are not guessed labels', () => {
    const before = { label: 'loading' as const, url: 'http://localhost', resultId: null, evidence: 'loading' };
    expect(stableOracle(before, before).label).toBe('loading');
    expect(stableOracle(before, { ...before, label: 'results' }).label).toBeNull();
    expect(stableOracle(before, { ...before, url: 'http://localhost/other' }).label).toBeNull();
});

test('report counts abstention and errors, rather than dropping unsuccessful predictions', () => {
    const rows: Prediction[] = [
        { episode: 'one', image: '0000.png', truth: 'results', elapsedMs: 5, decision: parseDecision(response()) },
        { episode: 'one', image: '0001.png', truth: 'loading', elapsedMs: 10, decision: parseDecision(response('empty_results')) },
        { episode: 'one', image: '0002.png', truth: 'results', elapsedMs: 15, decision: parseDecision(response('unclear')) },
        { episode: 'one', image: '0003.png', truth: 'load_error', elapsedMs: 20, error: 'timeout' },
        { episode: 'one', image: '0004.png', truth: null, elapsedMs: 25, decision: parseDecision(response()) },
    ];
    const report = summarizeReplay(rows);
    expect(report).toMatchObject({ attempted: 5, labelled: 4, unlabelled: 1, errors: 1, abstentions: 1,
        accuracyAllLabelled: 0.25, acceptedPrecision: 0.5, coverage: 0.5, falseEmpty: 1, falseReady: 1 });
    expect(report.confusion.load_error.error).toBe(1);
});

test('replay is sequential, preserves failed episodes, records invalid images, and refuses overwrites', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'portal-replay-'));
    try {
        const capture = join(directory, 'capture'), output = join(directory, 'replay');
        mkdirSync(join(capture, 'latest-result'), { recursive: true });
        writeFileSync(join(capture, 'manifest.json'), JSON.stringify({ synthetic: true, portal: 'ucsd' }));
        const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'white' } }).png().toBuffer();
        writeFileSync(join(capture, 'latest-result', '0000.png'), image);
        writeFileSync(join(capture, 'latest-result', '0001.png'), image);
        writeFileSync(join(capture, 'latest-result', '0002.png'), 'not a png');
        writeFileSync(join(capture, 'latest-result', 'episode.json'), JSON.stringify({ caseId: 'latest-result', status: 'timeout', passed: false,
            verification: { status: 'unavailable', reason: 'work_not_settled' },
            samples: [0, 1, 2].map(i => ({ image: `000${i}.png`, oracle: { label: 'results' } })) }));
        let active = 0, peak = 0, calls = 0;
        const request = fake(async () => {
            active++; peak = Math.max(peak, active); calls++;
            await new Promise(resolve => setTimeout(resolve, 5)); active--;
            return Response.json(response());
        });
        const summary = await replay(capture, output, ['latest-result', 'older-result'], endpoint, 'key', 1000, new AbortController().signal, request);
        expect(calls).toBe(2); expect(peak).toBe(1); expect(summary.errors).toBe(1);
        const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
        expect(report.baseline.map((row: { status: string }) => row.status)).toEqual(['timeout', 'interrupted']);
        expect(report.baseline[0].verification).toEqual({ status: 'unavailable', reason: 'work_not_settled' });
        expect(report.expectedEpisodes).toBe(2);
        expect(report.expectedScreenshots).toBe(3);
        const controller = new AbortController();
        calls = 0;
        const cancelled = await replay(capture, join(directory, 'cancelled'), ['latest-result'], endpoint, 'key', 1000, controller.signal,
            fake(async () => { calls++; controller.abort(); return Response.json(response()); }));
        expect(calls).toBe(1); expect(cancelled.attempted).toBe(1); expect(cancelled.errors).toBe(1);
        await expect(replay(capture, output, ['latest-result'], endpoint, 'key', 1000, new AbortController().signal, request)).rejects.toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
