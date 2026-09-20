import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserContext, Download, Page } from 'playwright';
import { Operation } from '@/common/operation';
import { BrowserDownloads } from './downloads';

class FakePage extends EventEmitter {
    constructor(private parent?: FakePage) { super(); }
    async opener() { return this.parent; }
}

function fixture() {
    const page = new FakePage();
    const context = Object.assign(new EventEmitter(), { pages: () => [page] });
    let progress = 0;
    const downloads = new BrowserDownloads(context as unknown as BrowserContext, () => { progress++; });
    const operation = () => new Operation({}, {});
    const start = () => downloads.beforeAction(page as unknown as Page);
    return { page, context, downloads, operation, start, progress: () => progress };
}

function transfer(page: FakePage) {
    const { promise, resolve } = Promise.withResolvers<string | null>();
    page.emit('download', { failure: () => promise } as Download);
    return resolve;
}

// Drain the event observer's promise continuations without a clock-based sleep.
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

test('download evidence is bounded, copied, content-free, and uses terminal browser state', async () => {
    const f = fixture();
    const operation = f.operation();
    try {
        await operation.run(async () => {
            operation.prepareAction('mouse:click');
            f.start();
            const finish = transfer(f.page);
            await flush();
            const snapshot = f.downloads.snapshot();
            expect(snapshot.downloads).toEqual([{ id: 1, actionIndex: 1, status: 'started' }]);
            finish(null);
            await flush();
            expect(snapshot.downloads[0].status).toBe('started');
            expect(f.downloads.snapshot().downloads[0].status).toBe('completed');
            const fail = transfer(f.page);
            await flush();
            fail('Sensitive filename, path, URL and server message');
            await flush();
            expect(f.downloads.snapshot().downloads[1].status).toBe('failed');
            expect(JSON.stringify(f.downloads.snapshot())).not.toContain('Sensitive');
            for (let i = 0; i < 100; i++) transfer(f.page)(null);
            await flush();
            expect(f.downloads.snapshot().downloads).toHaveLength(20);
            expect(f.downloads.snapshot().truncated).toBe(true);
            expect(f.progress()).toBe(40);
        });
    } finally { operation.finish(); f.downloads.stop(); }
});

test('unattributed, cancelled, finished and late downloads cannot enter a later operation', async () => {
    const f = fixture();
    const first = f.operation();
    let finish!: (failure: string | null) => void;
    try {
        transfer(f.page)(null);
        await first.run(async () => {
            expect(f.downloads.snapshot().downloads).toEqual([]);
            first.prepareAction('mouse:click');
            f.start();
            finish = transfer(f.page);
            await flush();
            expect(f.progress()).toBe(1);
            first.cancel();
            expect(f.downloads.snapshot().downloads).toEqual([]);
        });
        first.finish();
        const next = f.operation();
        await next.run(async () => {
            expect(f.downloads.snapshot().downloads).toEqual([]);
            transfer(f.page)(null); // No initiating action in the new operation.
            next.prepareAction('mouse:click');
            f.start(); // Reassign the page before the old transfer completes.
            finish(null);
            await flush();
            expect(f.downloads.snapshot().downloads).toEqual([]);
            expect(f.progress()).toBe(1);
            transfer(f.page)(null);
            await flush();
            expect(f.downloads.snapshot().downloads[0].status).toBe('completed');
        });
        next.finish();
        transfer(f.page)(null);
        await flush();
        expect(f.progress()).toBe(3);
    } finally { first.finish(); f.downloads.stop(); }
});

test('popup downloads inherit their initiating owner and all page listeners are removed', async () => {
    const f = fixture();
    const operation = f.operation();
    try {
        await operation.run(async () => {
            operation.prepareAction('mouse:click');
            f.start();
            const unrelated = new FakePage();
            f.context.emit('page', unrelated);
            transfer(unrelated)(null);
            await flush();
            expect(f.downloads.snapshot().downloads).toEqual([]);
            unrelated.emit('close');
            const popup = new FakePage(f.page);
            f.context.emit('page', popup);
            expect(popup.listenerCount('download')).toBe(1);
            transfer(popup)(null);
            await flush();
            expect(f.downloads.snapshot().downloads[0].status).toBe('completed');
            popup.emit('close');
            expect(popup.listenerCount('download')).toBe(0);
            expect(popup.listenerCount('close')).toBe(0);
        });
    } finally { operation.finish(); f.downloads.stop(); }
    expect(f.context.listenerCount('page')).toBe(0);
    expect(f.page.listenerCount('download')).toBe(0);
    expect(f.page.listenerCount('close')).toBe(0);
});

test('repeated tasks replace evidence without accumulating event listeners', async () => {
    const f = fixture();
    try {
        for (let i = 0; i < 100; i++) {
            const operation = f.operation();
            await operation.run(async () => {
                f.downloads.reset();
                operation.prepareAction('mouse:click');
                f.start();
                transfer(f.page)(null);
                await flush();
                expect(f.downloads.snapshot().downloads).toHaveLength(1);
                expect(f.page.listenerCount('download')).toBe(1);
                expect(f.context.listenerCount('page')).toBe(1);
            });
            operation.finish();
        }
    } finally { f.downloads.stop(); }
});

test('steps in one operation clear old evidence without restarting its observer budget', async () => {
    const f = fixture();
    const operation = f.operation();
    try {
        await operation.run(async () => {
            for (let step = 0; step < 25; step++) {
                f.downloads.reset();
                expect(f.downloads.snapshot().downloads).toEqual([]);
                operation.prepareAction('mouse:click');
                f.start();
                transfer(f.page)(null);
                await flush();
                const snapshot = f.downloads.snapshot();
                if (step < 20) expect(snapshot.downloads).toEqual([{ id: step + 1, actionIndex: step + 1, status: 'completed' }]);
                else {
                    expect(snapshot.downloads).toEqual([]);
                    expect(snapshot.truncated).toBe(true);
                }
            }
            expect(f.progress()).toBe(40);
        });
    } finally { operation.finish(); f.downloads.stop(); }
});
