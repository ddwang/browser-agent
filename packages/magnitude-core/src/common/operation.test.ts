import { expect, test } from 'bun:test';
import { Operation, checkOperation, currentOperation, measureOperation, operationSleep } from './operation';
import { OperationCancelledError, OperationDeadlineError } from '@/agent/errors';

test('operation context is isolated across concurrent owners and cleared outside them', async () => {
    const first = new Operation({}, {}), second = new Operation({}, {});
    try {
        await Promise.all([first, second].map(operation => operation.run(async () => {
            await operationSleep(1);
            expect(currentOperation()).toBe(operation);
        })));
        expect(currentOperation()).toBeUndefined();
    } finally { first.dispose(); second.dispose(); }
});

test('deadline wakes waits and remains a typed cause', async () => {
    const deadline = Date.now() + 30;
    const operation = new Operation({}, { deadline });
    try {
        await expect(operation.run(() => operationSleep(10_000))).rejects.toBeInstanceOf(OperationDeadlineError);
        expect(operation.signal.reason.deadline).toBe(deadline);
        expect(operation.signal.reason.operation.outcome).toBe('deadline');
        expect(operation.signal.reason.operation.status).toBe('draining');
    } finally { operation.dispose(); }
});

test('deadlines beyond the timer maximum do not overflow into immediate cancellation', async () => {
    const operation = new Operation({}, { deadline: Date.now() + 2_147_483_647 + 100_000 });
    try {
        await operation.run(() => operationSleep(5));
        expect(operation.signal.aborted).toBe(false);
    } finally { operation.dispose(); }
});

test('first abort wins and external listeners are removed on disposal', async () => {
    const controller = new AbortController();
    const operation = new Operation({}, { signal: controller.signal });
    operation.cancel('first'); controller.abort('second');
    expect(operation.signal.reason).toBeInstanceOf(OperationCancelledError);
    expect(operation.signal.reason.cause).toBe('first');
    operation.dispose();
    const anotherController = new AbortController();
    const completed = new Operation({}, { signal: anotherController.signal });
    completed.dispose(); anotherController.abort();
    expect(completed.signal.aborted).toBe(false);
    await expect(completed.run(async () => checkOperation())).rejects.toBeInstanceOf(OperationCancelledError);
});

test('phase timings handle nesting and concurrent spans without changing the active phase', async () => {
    const operation = new Operation({}, {});
    const outer = operation.beginPhase('action');
    const first = operation.beginPhase('screenshot');
    const second = operation.beginPhase('screenshot');
    expect(operation.snapshot().phase).toBe('screenshot');
    expect(operation.snapshot().timings.screenshot?.count).toBe(2);
    first(); first(); // Closing a span twice is harmless.
    expect(operation.snapshot().phase).toBe('screenshot');
    second();
    expect(operation.snapshot().phase).toBe('action');
    await operation.run(async () => {
        await expect(measureOperation('retry', async () => { throw new Error('fixture'); })).rejects.toThrow('fixture');
    });
    outer(); operation.finish();
    const snapshot = operation.snapshot();
    expect(snapshot.timings.action?.count).toBe(1);
    expect(snapshot.timings.screenshot?.count).toBe(2);
    expect(snapshot.timings.retry?.count).toBe(1);
    expect(snapshot.timings.action!.totalMs).toBeGreaterThanOrEqual(snapshot.timings.retry!.totalMs);
    operation.cancel();
    expect(operation.snapshot()).toEqual(snapshot);
});

test('late callbacks cannot rewrite a completed outcome after its former deadline', async () => {
    const operation = new Operation({}, { deadline: Date.now() + 10 });
    operation.finish();
    const completed = operation.snapshot();
    await operationSleep(20);
    expect(() => operation.check()).toThrow(OperationCancelledError);
    expect(operation.snapshot()).toEqual(completed);
    expect(operation.signal.aborted).toBe(false);
});

test('provider attempts are bounded, isolated, and immutable in snapshots', () => {
    const operation = new Operation({}, {});
    const attempt = { provider: 'fixture', model: 'fixture', startedAt: 123,
        elapsedMs: null, httpStatus: null, requestId: null, outcome: 'unknown' as const };
    for (let i = 0; i < 105; i++) operation.recordProviderAttempt(attempt);
    const snapshot = operation.snapshot();
    expect(snapshot.providerAttempts).toHaveLength(100);
    expect(snapshot.providerAttemptsTruncated).toBe(true);
    expect(snapshot.providerAttempts![0].attempt).toBe(6);
    expect(snapshot.providerAttempts![99].attempt).toBe(105);
    snapshot.providerAttempts![0].model = 'changed';
    expect(operation.snapshot().providerAttempts![0].model).toBe('fixture');
    operation.finish();
    operation.recordProviderAttempt(attempt);
    expect(operation.snapshot().providerAttempts![99].attempt).toBe(105);
    const next = new Operation({}, {});
    expect(next.snapshot().providerAttempts).toBeUndefined();
    next.recordProviderAttempt(attempt);
    expect(next.snapshot().providerAttempts![0].attempt).toBe(1);
    next.finish();
});

test('click snapshots retain only the latest operation-owned metadata and clone nested fields', () => {
    const operation = new Operation({}, {});
    const click = { x: 10, y: 20, button: 'left' as const, clickCount: 1,
        screenshot: { width: 512, height: 384 }, viewport: { width: 1024, height: 768 },
        hit: { tag: 'button', role: null } };
    operation.prepareAction('mouse:click');
    operation.recordClick(click);
    const snapshot = operation.snapshot();
    expect(snapshot.lastClick?.operationId).toBe(snapshot.id);
    expect(snapshot.lastClick?.actionIndex).toBe(1);
    snapshot.lastClick!.viewport!.width = 0;
    snapshot.lastClick!.screenshot!.height = 0;
    snapshot.lastClick!.hit!.tag = 'changed';
    expect(operation.snapshot().lastClick).toMatchObject(click);
    operation.recordClick({ ...click, x: 30 });
    expect(operation.snapshot().lastClick?.x).toBe(30);
    operation.finish();
    operation.recordClick(click);
    expect(operation.snapshot().lastClick?.x).toBe(30);
    const next = new Operation({}, {});
    expect(next.snapshot().lastClick).toBeUndefined();
    next.finish();
});
