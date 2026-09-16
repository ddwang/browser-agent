import { expect, test } from 'bun:test';
import { notebookCoverage } from './notebook-metrics';
import { emptyUsage, type TaskResult } from './results';

test('coverage requires exact values, linked evidence, successful writes, and correct timing', () => {
    const record = { path: '/a', label: 'Random-record', units: 731, code: 'nonce-abc' };
    const screen = (path: string) => ({ source: 'connector:web', data: { url: { type: 'primitive', content: `http://localhost${path}` } } });
    const write = (text: string, saved: string | boolean = 'a', sources = [0]) => [
        { source: 'action:taken:memory:note', data: { content: JSON.stringify({ key: 'a', text, sources }) } },
        { source: 'action:result:memory:note', data: { saved: { content: saved } } },
    ];
    const exact = `${record.label}: ${record.units}, ${record.code}`;
    const run = (observations: any[], notes: any[] = []): TaskResult => ({ ...emptyUsage(), status: 'completed', time: 1, actionCount: 0,
        memory: { observations, notes } as any });
    const result = (observations: any[]) => notebookCoverage(run(observations), [record])[0];
    expect(result([screen('/a'), ...write(exact), screen('/b')]).capturedBeforeFirstDeparture).toBe(true);
    for (const observations of [
        [screen('/a'), ...write(exact, false), screen('/b')],
        [screen('/a'), screen('/b'), ...write(exact)],
        [screen('/a'), ...write(exact.replace('731', '1731')), screen('/b')],
        [screen('/a'), ...write(exact, 'a', [3]), screen('/b')],
        [screen('/a'), ...write('Inspected record.'), screen('/b')],
        [screen('/a'), ...write(exact)],
    ]) expect(result(observations).capturedBeforeFirstDeparture).toBe(false);
    const changed = { ...record, code: 'nonce-corrected' };
    const corrected = run([screen('/a'), screen('/b')], [{ key: 'a', text: `${record.label} 731 nonce-corrected`, sources: [0] }]);
    expect(notebookCoverage(corrected, [record])[0].exactTokensInFinalNotes).toBe(false);
    expect(notebookCoverage(corrected, [changed])[0].exactTokensInFinalNotes).toBe(true);
    expect(notebookCoverage(run([]), [record])[0].seen).toBe(false);
});
