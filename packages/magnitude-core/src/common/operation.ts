import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { OperationCancelledError, OperationDeadlineError } from '@/agent/errors';
import logger from '@/logger';

export interface OperationOptions {
    signal?: AbortSignal;
    /** Absolute Unix time in milliseconds, shared by every step, retry, and wait. */
    deadline?: number;
}

export type OperationKind = 'act' | 'query' | 'extract' | 'nav' | 'exec';
export type OperationPhase = 'preparing' | 'context' | 'observations' | 'model' | 'action'
    | 'screenshot' | 'stability' | 'cooldown' | 'retry' | 'paused' | 'cursor';
export interface OperationTiming { count: number; totalMs: number }
export interface OperationDiagnostics {
    id: string;
    kind: OperationKind;
    status: 'running' | 'draining' | 'finished';
    outcome?: 'succeeded' | 'failed' | 'cancelled' | 'deadline';
    phase: OperationPhase;
    startedAt: number;
    elapsedMs: number;
    cancellationToDrainMs?: number;
    cancellationToIdleMs?: number;
    lastAction?: { index: number; name: string; state: 'pending' | 'started' | 'completed' | 'failed' };
    /** Inclusive totals: nested and concurrent phases overlap and must not be summed. */
    timings: Partial<Record<OperationPhase, OperationTiming>>;
}

/** Preserve the original error and add only a payload-free snapshot, when extensible. */
export function attachOperationDiagnostics(error: unknown, diagnostics: OperationDiagnostics): void {
    if (!(error instanceof Error)) return;
    try {
        if (!('operation' in error)) Object.defineProperty(error, 'operation', { value: diagnostics, enumerable: true });
    } catch { /* Caller-owned errors may be frozen or expose a custom property. */ }
}

// Keep context through async callbacks so a late callback cannot act on a reused agent.
const operations = new AsyncLocalStorage<Operation>();

export class Operation {
    private controller = new AbortController();
    private timer?: ReturnType<typeof setTimeout>;
    private closed = false;
    readonly signal = this.controller.signal;
    readonly deadline?: number;
    private externalSignal?: AbortSignal;
    private externalAbort = () => this.cancel(this.externalSignal?.reason);
    private readonly id = randomUUID();
    private readonly startedAt = Date.now();
    private readonly started = performance.now();
    private finished?: number;
    private cancelled?: number;
    private idle?: number;
    private announced = false;
    private outcome?: OperationDiagnostics['outcome'];
    private lastAction?: OperationDiagnostics['lastAction'];
    private timings: OperationDiagnostics['timings'] = {};
    private spans = new Set<{ phase: OperationPhase; started: number }>();

    constructor(readonly owner: object, options: OperationOptions, private kind: OperationKind = 'exec',
        private onUpdate?: (diagnostics: OperationDiagnostics) => void) {
        if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
            throw new TypeError('deadline must be a finite Unix timestamp in milliseconds');
        }
        this.deadline = options.deadline;
        this.externalSignal = options.signal;
        this.signal.addEventListener('abort', () => {
            this.cancelled = performance.now();
            this.outcome = this.signal.reason instanceof OperationDeadlineError ? 'deadline' : 'cancelled';
            attachOperationDiagnostics(this.signal.reason, this.snapshot());
            this.publish();
        }, { once: true });
        options.signal?.addEventListener('abort', this.externalAbort, { once: true });
        if (options.signal?.aborted) this.externalAbort();
        this.scheduleDeadline();
    }

    private scheduleDeadline() {
        if (this.deadline === undefined || this.signal.aborted) return;
        const remaining = this.deadline - Date.now();
        if (remaining <= 0) this.controller.abort(new OperationDeadlineError(this.deadline));
        else this.timer = setTimeout(() => this.scheduleDeadline(), Math.min(remaining, 2_147_483_647));
    }

    cancel(reason?: unknown) {
        if (this.closed) return;
        clearTimeout(this.timer);
        if (!this.signal.aborted) this.controller.abort(new OperationCancelledError(reason));
    }

    check() {
        if (this.signal.aborted) throw this.signal.reason;
        if (this.closed) throw new OperationCancelledError('Operation already finished');
        if (this.deadline !== undefined && Date.now() >= this.deadline) {
            this.controller.abort(new OperationDeadlineError(this.deadline));
        }
        if (this.signal.aborted) throw this.signal.reason;
    }

    run<T>(fn: () => Promise<T>): Promise<T> {
        return operations.run(this, fn);
    }

    announce(): void {
        this.announced = true;
        this.publish();
    }

    private publish(): void {
        if (!this.announced) return;
        try { this.onUpdate?.(this.snapshot()); }
        catch { logger.warn('Operation diagnostic listener failed'); }
    }

    snapshot(): OperationDiagnostics {
        const now = this.finished ?? performance.now();
        const timings: OperationDiagnostics['timings'] = {};
        for (const [phase, timing] of Object.entries(this.timings)) timings[phase as OperationPhase] = { ...timing };
        let phase: OperationPhase = 'preparing';
        for (const span of this.spans) {
            phase = span.phase;
            const timing = timings[phase] ??= { count: 0, totalMs: 0 };
            timing.count++;
            timing.totalMs += now - span.started;
        }
        return {
            id: this.id, kind: this.kind,
            status: this.finished !== undefined ? 'finished' : this.cancelled !== undefined ? 'draining' : 'running',
            outcome: this.outcome, phase, startedAt: this.startedAt, elapsedMs: now - this.started,
            ...(this.cancelled !== undefined && this.finished !== undefined ? { cancellationToDrainMs: this.finished - this.cancelled } : {}),
            ...(this.cancelled !== undefined && this.idle !== undefined ? { cancellationToIdleMs: this.idle - this.cancelled } : {}),
            ...(this.lastAction ? { lastAction: { ...this.lastAction } } : {}), timings,
        };
    }

    beginPhase(phase: OperationPhase): () => void {
        if (this.closed) return () => {};
        const span = { phase, started: performance.now() };
        this.spans.add(span);
        this.publish();
        return () => {
            if (!this.spans.delete(span)) return;
            const timing = this.timings[phase] ??= { count: 0, totalMs: 0 };
            timing.count++;
            timing.totalMs += performance.now() - span.started;
            this.publish();
        };
    }

    prepareAction(name: string): void {
        this.lastAction = { index: (this.lastAction?.index ?? 0) + 1, name, state: 'pending' };
        this.publish();
    }

    actionState(state: 'started' | 'completed' | 'failed'): void {
        if (this.lastAction) this.lastAction.state = state;
    }

    fail(error: unknown): void {
        this.outcome ??= 'failed';
        attachOperationDiagnostics(error, this.snapshot());
    }

    finish(): void {
        this.finished = performance.now();
        this.outcome ??= 'succeeded';
        this.dispose();
        this.publish();
    }

    markIdle(): void {
        if (this.idle !== undefined) return;
        this.idle = performance.now();
        this.publish();
    }

    dispose() {
        this.closed = true;
        clearTimeout(this.timer);
        this.externalSignal?.removeEventListener('abort', this.externalAbort);
    }
}

export function currentOperation(): Operation | undefined {
    return operations.getStore();
}

export function withoutOperation<T>(fn: () => T): T {
    return operations.exit(fn);
}

export function checkOperation(): void {
    currentOperation()?.check();
}

export function operationOptions(): OperationOptions {
    checkOperation();
    const operation = currentOperation();
    return { signal: operation?.signal, deadline: operation?.deadline };
}

export function beginOperationPhase(phase: OperationPhase): () => void {
    return currentOperation()?.beginPhase(phase) ?? (() => {});
}

export async function measureOperation<T>(phase: OperationPhase, fn: () => Promise<T>): Promise<T> {
    const finish = beginOperationPhase(phase);
    try { checkOperation(); return await fn(); }
    finally { finish(); }
}

/** Wait for every branch, even when one fails, before releasing the operation. */
export async function drainAll<T extends readonly unknown[]>(promises: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
    const results = await Promise.allSettled(promises);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** Only race the public result or passive waits. The worker must still drain before reuse. */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

export async function operationSleep(ms: number, signal = currentOperation()?.signal): Promise<void> {
    checkOperation();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await untilAborted(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal);
        checkOperation();
    } finally {
        clearTimeout(timer);
    }
}
