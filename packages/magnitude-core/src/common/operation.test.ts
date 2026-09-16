import { expect, test } from 'bun:test';
import { Operation, checkOperation, currentOperation, operationSleep } from './operation';
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
