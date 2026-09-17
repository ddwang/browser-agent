import { describe, expect, test } from 'bun:test';
import { addUsage, emptyUsage, isTaskResultFile, outcome, summarize, type Evaluation, type TaskRecord, type TaskResult } from './results';
import type { OperationDiagnostics } from '../../packages/magnitude-core/src/common/operation';

const task = { id: 'test--0', web_name: 'test', ques: 'Read the page', web: 'https://example.com' };
const run = (overrides: Partial<TaskResult> = {}): TaskResult => ({
    ...emptyUsage(), status: 'completed', time: 1000, actionCount: 2, memory: null, ...overrides,
});

test('operation summaries retain failures and report missing instrumentation as missing samples', () => {
    const operation: OperationDiagnostics = {
        id: 'fixture', kind: 'act', status: 'finished', outcome: 'succeeded', phase: 'preparing', startedAt: 0, elapsedMs: 100,
        timings: { model: { count: 2, totalMs: 30 }, action: { count: 1, totalMs: 20 }, screenshot: { count: 1, totalMs: 10 } },
    };
    const summary = summarize([
        { task, run: run({ operation }) },
        { task, run: run({ status: 'timeout', operation: { ...operation, id: 'deadline', outcome: 'deadline',
            timings: { model: { count: 1, totalMs: 50 } }, cancellationToDrainMs: 20, cancellationToIdleMs: 30 } }) },
        { task, run: run() }, // Legacy run: no invented zero-duration phases.
        { task },
    ]);
    expect(summary.operations).toEqual({
        measuredTasks: 2, finishedTasks: 2,
        timings: {
            model: { samples: 2, count: 3, totalMs: 80, medianMs: 30, p95Ms: 50 },
            action: { samples: 1, count: 1, totalMs: 20, medianMs: 20, p95Ms: 20 },
            screenshot: { samples: 1, count: 1, totalMs: 10, medianMs: 10, p95Ms: 10 },
        },
        cancellationToDrain: { samples: 1, totalMs: 20, medianMs: 20, p95Ms: 20 },
        cancellationToIdle: { samples: 1, totalMs: 30, medianMs: 30, p95Ms: 30 },
    });
    expect(summary.counts.timeout).toBe(1);
    expect(summarize([{ task, run: run() }]).operations).toMatchObject({ measuredTasks: 0, timings: {}, cancellationToIdle: { samples: 0, medianMs: null } });
});

test('cancelled tasks stay interrupted even with a stale successful verdict', () => {
    expect(outcome({ run: run({ status: 'cancelled' }), evaluation: evaluation('SUCCESS') })).toBe('interrupted');
    expect(summarize([{ task, run: run({ status: 'cancelled' }) }])).toMatchObject({ selected: 1, successRate: 0, counts: { interrupted: 1 } });
});
const evaluation = (result: Evaluation['result']): Evaluation => ({ result, time: 500, usage: emptyUsage() });

test('result-file filtering excludes sidecars while preserving legacy filenames', () => {
    expect([
        'Example--0.json', 'Example--0.eval.json', 'Example--0.status.json',
        'manifest.json', 'summary.json', 'Example--0.json.tmp-123',
        'legacy.json', '.json', 'Example--0.JSON', 'readme.txt',
    ].filter(isTaskResultFile)).toEqual(['Example--0.json', 'legacy.json', '.json']);
});

describe('evaluation metrics', () => {
    test('tracks output cost separately and preserves cached token counts', () => {
        const totals = emptyUsage();
        const usage = { llm: { provider: 'anthropic', model: 'test' }, inputTokens: 100, outputTokens: 10, inputCost: 0.01, outputCost: 0.07, cacheReadInputTokens: 200 };
        addUsage(totals, usage);
        addUsage(totals, usage);
        expect(totals.totalInputCost).toBe(0.02);
        expect(totals.totalOutputCost).toBe(0.14);
        expect(totals.cacheReadInputTokens).toBe(400);
        expect(totals.totalInputTokens).toBe(200);
        expect(totals.modelCalls).toBe(2);
    });

    test('does not turn unknown pricing into a zero-cost estimate', () => {
        const totals = emptyUsage();
        const usage = { llm: { provider: 'anthropic', model: 'unknown' }, inputTokens: 100, outputTokens: 10 };
        addUsage(totals, usage);
        addUsage(totals, { ...usage, inputCost: 1, outputCost: 2 });
        expect(totals.totalInputCost).toBeNull();
        expect(totals.totalOutputCost).toBeNull();
    });

    test('keeps every selected task in the success-rate denominator', () => {
        const records: TaskRecord[] = [
            { task, run: run(), evaluation: evaluation('SUCCESS') },
            { task, run: run(), evaluation: evaluation('NOT SUCCESS') },
            { task, run: run({ status: 'timeout', timedOut: true }) },
            { task, run: run({ status: 'error', error: 'Chrome crashed' }) },
            { task, run: run({ status: 'running' }) },
            { task, run: run(), evaluation: { ...evaluation(undefined), error: 'Judge unavailable' } },
            { task, run: run() },
            { task },
        ];
        expect(summarize(records)).toMatchObject({
            selected: 8, attempted: 7, successRate: 1 / 8,
            counts: { success: 1, failure: 1, timeout: 1, error: 1, interrupted: 1, judge_error: 1, unscored: 1, pending: 1 },
        });
    });

    test('a stale successful verdict cannot hide a timeout or crash', () => {
        expect(outcome({ run: run({ timedOut: true }), evaluation: evaluation('SUCCESS') })).toBe('timeout');
        expect(outcome({ run: run({ error: 'Crash' }), evaluation: evaluation('SUCCESS') })).toBe('error');
        expect(outcome({ run: run({ status: 'blocked', error: 'Rate limit' }), evaluation: evaluation('SUCCESS') })).toBe('blocked');
    });

    test('fresh heartbeats distinguish a live wait from an interrupted worker', () => {
        const progress = { startedAt: 0, updatedAt: Date.now(), phase: 'waiting' as const, phaseStartedAt: 0, waitUntil: Date.now() + 60_000, network: [] };
        expect(outcome({ run: run({ status: 'running', progress }) })).toBe('running');
        expect(outcome({ run: run({ status: 'running', progress: { ...progress, updatedAt: Date.now() - 20_000 } }) })).toBe('interrupted');
        expect(summarize([{ task, run: run({ status: 'blocked' }) }])).toMatchObject({ selected: 1, successRate: 0, counts: { blocked: 1 } });
    });

    test('includes failures in latency and reports actor and judge cost separately', () => {
        const records: TaskRecord[] = [
            { task, run: run({ time: 1000, totalInputCost: 1, totalOutputCost: 2 }), evaluation: { ...evaluation('SUCCESS'), usage: { ...emptyUsage(), totalInputCost: 0.1, totalOutputCost: 0.2 } } },
            { task, run: run({ time: 3000, status: 'error' }) },
            { task, run: run({ time: 2000 }) },
            { task },
        ];
        const summary = summarize(records);
        expect(summary.medianTimeMs).toBe(2000);
        expect(summary.p95TimeMs).toBe(3000);
        expect(summary.averageActions).toBe(2);
        expect(summary.estimatedActorCost).toBe(3);
        expect(summary.estimatedJudgeCost).toBeCloseTo(0.3);
    });

    test('empty runs do not report misleading rates or latencies', () => {
        expect(summarize([])).toMatchObject({ successRate: null, medianTimeMs: null, p95TimeMs: null, averageActions: null });
    });
});
