/** Opt-in paid synthetic check: bun evals/webvoyager/fixtures/notebook-live.ts --live */
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJson } from '../results';
import { notebookCoverage, type NotebookRecord } from '../notebook-metrics';

if (!process.argv.includes('--live')) throw new Error('Pass --live to make paid Luna and Sonnet calls. No public websites are used.');
if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) throw new Error('Both actor and judge API keys are required.');
const directory = resolve('.context', `notebook-live-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(directory, { recursive: true });
// A short control, an image-window challenge, and a task longer than the default
// 20-thought window, plus corrections. Draw lengths before any model call;
// preserve every attempt.
type Collection = { id: string; records: NotebookRecord[]; end: string; notice?: string; correction?: { units: number; code: string } };
const collections: Collection[] = [1, randomInt(6, 11), randomInt(22, 29), randomInt(6, 11)].map((count, index) => ({
    id: index === 3 ? `Local Notebook Correction--${count}` : `Local Notebook--${count}`,
    records: Array.from({ length: count }, () => ({
        path: `/${randomUUID()}`, label: `Lot-${randomUUID().slice(0, 8)}`,
        units: randomInt(10, 900), code: randomUUID().slice(0, 13),
    })),
    end: `/${randomUUID()}`,
    ...(index === 3 ? { notice: `/${randomUUID()}`, correction: { units: randomInt(901, 999), code: randomUUID().slice(0, 13) } } : {}),
}));
const visits = new Map<string, number>();
const correctionsPublished = new Set<string>();
const correctionsRead = new Set<string>();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    visits.set(path, (visits.get(path) ?? 0) + 1);
    for (const collection of collections) {
        const index = collection.records.findIndex(record => record.path === path);
        const initial = collection.records[index];
        if (!initial && path !== collection.end && path !== collection.notice) continue;
        if (path === collection.end && collection.correction) correctionsPublished.add(collection.id);
        if (index === 0 && correctionsPublished.has(collection.id)) correctionsRead.add(collection.id);
        const record = initial && index === 0 && correctionsPublished.has(collection.id) ? { ...initial, ...collection.correction } : initial;
        const next = index === Math.floor(collection.records.length / 2) - 1 && collection.notice
            ? collection.notice : collection.records[index + 1]?.path ?? collection.end;
        const body = record ? `<h1>Collection entry ${index + 1} of ${collection.records.length}</h1>
            <p>Label: ${record.label}</p><p>Units: ${record.units}</p><p>Confirmation code: ${record.code}</p>
            <a href="${next}"><button style="font:26px sans-serif;padding:16px">Next entry</button></a>`
            : path === collection.notice ? `<h1>Navigation notice</h1><p>This page contains no collection record.</p><a href="${collection.records[Math.floor(collection.records.length / 2)].path}">Continue to next entry</a>`
            : `<h1>End of collection</h1><p>There are no more entries.</p>${collection.correction ? `<p>A correction has now been published for the first entry. Reopen it and use its updated values.</p><a href="${collection.records[0].path}">Read corrected first entry</a>` : ''}`;
        return new Response(`<html><body style="font:26px sans-serif;padding:45px">${body}</body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }
    return new Response('Not found', { status: 404 });
} });
const suite = join(directory, 'suite.json');
const runDir = join(directory, 'run');
writeJson(join(directory, 'expected.json'), collections);
writeJson(suite, { tasks: collections.map(collection => ({
    id: collection.id, web_name: 'Local Notebook', web: `http://127.0.0.1:${server.port}${collection.records[0].path}`,
    ques: 'Visit every entry in this collection and the End of collection page. Check the end page for corrections; if any are announced, revisit the affected entry and use its latest values. Ignore navigation notices that contain no record. Return a JSON object with an entries array in collection order, each containing label, units, and code (the confirmation code), plus totalUnits for the sum. Use the exact displayed values.',
    criteria: ['Every collection entry and the End of collection page were visited.',
        'The answer gives every entry in collection order with its exact label, units, and confirmation code, and the correct total units.',
        'Any announced correction was checked by revisiting the affected entry; the answer uses the corrected values and contains no record for a navigation notice.'],
})) });
console.log(JSON.stringify({ directory, runDir }));
const child = Bun.spawn([process.execPath, 'evals/webvoyager/wv.ts', 'run', '--suite', suite, '--run-dir', runDir,
    '--provider', 'openai', '--model', 'gpt-5.6-luna', '--eval', '--workers', '1'], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BAML_LOG: 'off' },
});
const clean = (value: string) => [process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY]
    .filter((key): key is string => Boolean(key))
    .reduce((text, key) => text.replaceAll(key, '[REDACTED]'), value);
const deadline = setTimeout(() => child.kill(), 6_100_000);
try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    writeJson(join(directory, 'process.json'), { code, stdout: clean(stdout), stderr: clean(stderr) });
    const checks = collections.map(collection => {
        const result = JSON.parse(readFileSync(join(runDir, `${collection.id}.json`), 'utf8'));
        const evaluation = JSON.parse(readFileSync(join(runDir, `${collection.id}.eval.json`), 'utf8'));
        const answerObservation = result.memory?.observations?.findLast((o: any) => o.source === 'action:taken:answer');
        let answer: any;
        try { answer = JSON.parse(JSON.parse(answerObservation.data.content).input); } catch { /* The exact check fails; preserve the attempt. */ }
        const latest = collection.records.map((record, index) => index === 0 && collection.correction ? { ...record, ...collection.correction } : record);
        const expected = latest.map(({ label, units, code }) => ({ label, units, code }));
        const exact = Array.isArray(answer?.entries) && answer.entries.length === expected.length
            && expected.every((record, i) => ['label', 'units', 'code'].every(key => answer.entries[i]?.[key] === record[key as keyof typeof record]))
            && answer.totalUnits === expected.reduce((sum, record) => sum + record.units, 0);
        const allVisited = [...collection.records.map(record => record.path), collection.end].every(path => visits.has(path));
        const notebookActions = result.memory?.observations?.filter((o: any) => o.source === 'action:taken:memory:note').length ?? 0;
        const renderedNotes = result.memory?.notes?.length ?? 0;
        const coverage = notebookCoverage(result, collection.records);
        return { id: collection.id, status: result.status, exact, allVisited, notebookActions, renderedNotes,
            sourceLinkedCaptureBeforeDeparture: { captured: coverage.filter(row => row.capturedBeforeFirstDeparture).length,
                total: collection.records.length, records: coverage },
            latestTokensInFinalNotes: notebookCoverage(result, latest),
            correctionRevisited: collection.correction ? correctionsRead.has(collection.id) : undefined,
            // A historical mention is not automatically a stale claim; preserve it for review.
            oldCodeMentionedInFinalNotes: collection.correction ? JSON.stringify(result.memory?.notes ?? []).includes(collection.records[0].code) : undefined,
            actions: result.actionCount, actorCalls: result.modelCalls, judgeResult: evaluation.result,
            // Expose repeated visits without discarding or rerunning a failed attempt.
            visits: collection.records.map(record => visits.get(record.path) ?? 0),
            error: clean(result.error ?? evaluation.error ?? '') };
    });
    writeJson(join(directory, 'verification.json'), { code, checks });
    console.log(JSON.stringify({ code, checks }, null, 2));
    if (code !== 0 || checks.some((check, i) => !check.exact || !check.allVisited
        || check.correctionRevisited === false || (collections[i].records.length > 3 && !check.notebookActions) || check.judgeResult !== 'SUCCESS')) process.exitCode = 1;
} finally { clearTimeout(deadline); server.stop(true); }
