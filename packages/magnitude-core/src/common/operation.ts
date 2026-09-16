import { AsyncLocalStorage } from 'node:async_hooks';
import { OperationCancelledError, OperationDeadlineError } from '@/agent/errors';

export interface OperationOptions {
    signal?: AbortSignal;
    /** Absolute Unix time in milliseconds, shared by every step, retry, and wait. */
    deadline?: number;
}

// Keep context through async callbacks so a late callback cannot act on a reused agent.
const operations = new AsyncLocalStorage<Operation>();

export class Operation {
    private controller = new AbortController();
    private timer?: ReturnType<typeof setTimeout>;
    private closed = false;
    readonly signal = this.controller.signal;
    readonly deadline?: number;
    private externalAbort = () => this.cancel(this.options.signal?.reason);

    constructor(readonly owner: object, private options: OperationOptions) {
        if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
            throw new TypeError('deadline must be a finite Unix timestamp in milliseconds');
        }
        this.deadline = options.deadline;
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
        clearTimeout(this.timer);
        if (!this.signal.aborted) this.controller.abort(new OperationCancelledError(reason));
    }

    check() {
        if (!this.signal.aborted && this.deadline !== undefined && Date.now() >= this.deadline) {
            this.controller.abort(new OperationDeadlineError(this.deadline));
        }
        if (this.signal.aborted) throw this.signal.reason;
        if (this.closed) throw new OperationCancelledError('Operation already finished');
    }

    run<T>(fn: () => Promise<T>): Promise<T> {
        return operations.run(this, fn);
    }

    dispose() {
        this.closed = true;
        clearTimeout(this.timer);
        this.options.signal?.removeEventListener('abort', this.externalAbort);
    }
}

export function currentOperation(): Operation | undefined {
    return operations.getStore();
}

export function checkOperation(): void {
    currentOperation()?.check();
}

export function operationOptions(): OperationOptions {
    checkOperation();
    const operation = currentOperation();
    return { signal: operation?.signal, deadline: operation?.deadline };
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
