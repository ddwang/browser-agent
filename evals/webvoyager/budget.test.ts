import { expect, test } from 'bun:test';
import { checkBudget, DEFAULT_LIMITS } from './budget';
import { emptyUsage, outcome, type TaskResult } from './results';

const run = (actionCount = 1): TaskResult => ({
    ...emptyUsage(), status: 'completed', actionCount, time: 1000, memory: { observations: [] },
});

test('a completed task at the action limit is allowed; exceeding it fails', () => {
    expect(checkBudget(run(DEFAULT_LIMITS.maxActions))).toBeUndefined();
    expect(checkBudget(run(DEFAULT_LIMITS.maxActions + 1))).toEqual({ kind: 'actions', actual: 101, limit: 100 });
});

test('payload cap is byte-based, with an inclusive boundary', () => {
    const task = run();
    const bytes = Buffer.byteLength(JSON.stringify(task.memory));
    expect(checkBudget(task, { maxActions: 100, maxJudgeBytes: bytes })).toBeUndefined();
    expect(checkBudget(task, { maxActions: 100, maxJudgeBytes: bytes - 1 })).toEqual({ kind: 'payload_bytes', actual: bytes, limit: bytes - 1 });
});

test('runtime action limits count as failure, not a browser or judge error', () => {
    expect(outcome({ run: { ...run(100), status: 'failed', error: 'Action limit reached' } })).toBe('failure');
});
