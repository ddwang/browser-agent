import { expect, test } from 'bun:test';
import type { BrowserContext, Page } from 'playwright';
import { ActionVisualizer } from './index';
import { CursorVisual } from './cursor';
import { Operation } from '@/common/operation';
import { OperationCancelledError } from '@/agent/errors';

function pageFixture() {
    const evaluations: unknown[] = [];
    const page = {
        on: () => {},
        evaluate: async (_fn: unknown, arg: unknown) => { evaluations.push(arg); },
    } as unknown as Page;
    return { page, evaluations };
}

test('hidden cursor does not draw, register cursor timings, or wait', async () => {
    const { page, evaluations } = pageFixture();
    const visualizer = new ActionVisualizer({} as BrowserContext, { showCursor: false });
    await visualizer.setActivePage(page);
    evaluations.length = 0;
    const operation = new Operation({}, {});
    await operation.run(async () => {
        await visualizer.moveVirtualCursor(12, 34); await visualizer.hideAll(); await visualizer.showAll();
    });
    operation.finish();
    expect(evaluations).toEqual([]);
    expect(operation.snapshot().timings.cursor).toBeUndefined();
});

test('animation can be disabled while preserving cursor position and visibility controls', async () => {
    const { page, evaluations } = pageFixture();
    const visualizer = new ActionVisualizer({} as BrowserContext, { animateCursor: false });
    await visualizer.setActivePage(page);
    evaluations.length = 0;
    const operation = new Operation({}, {});
    // No timer is needed: the move finishes before the next timers phase.
    const nextTimer = new Promise(resolve => setTimeout(() => resolve('timer'), 0));
    const move = operation.run(() => visualizer.moveVirtualCursor(12, 34)).then(() => 'move');
    expect(await Promise.race([move, nextTimer])).toBe('move');
    await visualizer.hideAll(); await visualizer.showAll(); operation.finish();
    expect(evaluations).toEqual([
        { x: 12, y: 34, id: 'action-visual-indicator', showClickEffect: false, animate: false },
        'action-visual-indicator', 'action-visual-indicator',
    ]);
    expect(operation.snapshot().timings.cursor?.count).toBe(1);
});

test('default animation still waits and its wait is cancellable', async () => {
    const { page, evaluations } = pageFixture();
    const cursor = new CursorVisual();
    await cursor.setActivePage(page);
    const operation = new Operation({}, {});
    const move = operation.run(() => cursor.move(12, 34));
    // Drawing is synchronous in this fixture; allow the animation wait to start.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(evaluations[0]).toMatchObject({ animate: true });
    let complete = false;
    void move.then(() => { complete = true; }, () => {});
    expect(complete).toBe(false);
    operation.cancel(); await expect(move).rejects.toBeInstanceOf(OperationCancelledError);
    operation.finish();
});
