import type { BrowserContext, Download, Page } from 'playwright';
import { currentOperation, type Operation } from '@/common/operation';

interface DownloadEvidence {
    id: number;
    actionIndex: number;
    status: 'started' | 'completed' | 'failed';
}

interface DownloadScope {
    operation: Operation;
    operationId: string;
    records: DownloadEvidence[];
    truncated: boolean;
}

interface DownloadOwner { scope: DownloadScope; actionIndex: number }

/** Observes browser-owned downloads; never reads, saves, or logs their payloads. */
export class BrowserDownloads {
    private scope?: DownloadScope;
    private operation?: Operation;
    private observed = 0;
    private owners = new WeakMap<Page, DownloadOwner>();
    private listeners = new Map<Page, () => void>();

    constructor(private context: BrowserContext, private onProgress: () => void) {
        context.on('page', this.onPage);
        for (const page of context.pages()) this.onPage(page);
    }

    reset() {
        this.scope = undefined;
    }

    private currentScope(): DownloadScope | undefined {
        const operation = currentOperation();
        if (!operation) return undefined;
        if (this.operation !== operation) {
            this.operation = operation;
            this.observed = 0;
        }
        if (this.scope?.operation !== operation) {
            this.scope = { operation, operationId: operation.snapshot().id, records: [], truncated: false };
        }
        return this.scope;
    }

    private active(scope: DownloadScope): boolean {
        return this.scope === scope && !scope.operation.signal.aborted
            && scope.operation.snapshot().status === 'running';
    }

    beforeAction(page: Page) {
        const scope = this.currentScope();
        const actionIndex = scope?.operation.snapshot().lastAction?.index;
        if (scope && actionIndex !== undefined) this.owners.set(page, { scope, actionIndex });
    }

    snapshot() {
        const scope = this.currentScope();
        return {
            operationId: scope?.operationId ?? null,
            downloads: scope && this.active(scope) ? scope.records.map(record => ({ ...record })) : [],
            truncated: scope && this.active(scope) ? scope.truncated : false,
        };
    }

    private onPage = (page: Page) => {
        if (this.listeners.has(page)) return;
        // Attach synchronously, including to popups that immediately download.
        // Capture the opener's owner once, not when a later download completes.
        const openerOwner = page.opener().then(opener => opener ? this.owners.get(opener) : undefined, () => undefined);
        const onDownload = (download: Download) => {
            const owner = this.owners.get(page);
            void openerOwner.then(inherited => this.observe(download, owner ?? inherited));
        };
        const cleanup = () => {
            page.off('download', onDownload);
            page.off('close', cleanup);
            this.listeners.delete(page);
            this.owners.delete(page);
        };
        page.on('download', onDownload);
        page.on('close', cleanup);
        this.listeners.set(page, cleanup);
    };

    private async observe(download: Download, owner?: DownloadOwner) {
        if (!owner || !this.active(owner.scope)) return;
        const { scope, actionIndex } = owner;
        // Bound both retained evidence and completion observers per operation.
        if (this.observed >= 20) { scope.truncated = true; return; }
        const record: DownloadEvidence = { id: ++this.observed, actionIndex, status: 'started' };
        scope.records.push(record);
        this.onProgress();
        let status: DownloadEvidence['status'];
        try {
            // Playwright waits for the browser's terminal download state. Do not
            // infer success from the event, filename, response, or page image.
            status = await download.failure() === null ? 'completed' : 'failed';
        } catch { status = 'failed'; }
        if (!this.active(scope)) return;
        record.status = status;
        this.onProgress();
    }

    stop() {
        this.reset();
        this.operation = undefined;
        this.context.off('page', this.onPage);
        for (const cleanup of this.listeners.values()) cleanup();
    }
}
