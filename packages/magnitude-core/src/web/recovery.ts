import type { Action } from '@/actions/types';
import type { OperationDiagnostics } from '@/common/operation';

export type BlockReason = 'rate_limit' | 'subscription' | 'authentication' | 'no_progress';
export interface BrowserBlock {
    reason: BlockReason;
    evidence: string;
    retryAt?: number;
}

export class BrowserBlockedError extends Error {
    declare readonly operation?: OperationDiagnostics;
    constructor(public readonly block: BrowserBlock) {
        super(`Browser blocked (${block.reason}): ${block.evidence}`);
        this.name = 'BrowserBlockedError';
    }
}

export interface HttpDiagnostic {
    timestamp: number;
    url: string;
    status: number;
    retryAt?: number;
    navigation?: boolean;
}

// Strip userinfo, query strings and fragments; do not persist arbitrary headers.
export function diagnosticUrl(value: string): string {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
    catch { return 'unknown'; }
}

export function retryAt(value: string | undefined, now: number): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return seconds >= 0 ? now + seconds * 1000 : undefined;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(now, date) : undefined;
}

export function detectBlock(headings: string[], response?: HttpDiagnostic): BrowserBlock | undefined {
    const rate = headings.find(text => /too many requests|you have exceeded a secondary rate limit|rate limit exceeded/i.test(text));
    if ((response?.status === 429 && response.navigation !== false) || rate) return {
        reason: 'rate_limit', evidence: rate ?? `HTTP 429 at ${response!.url}`,
        retryAt: response?.retryAt ?? (response ? response.timestamp + 60_000 : undefined),
    };
    const subscription = headings.find(text => /subscri(?:be|ption required).{0,60}(?:to continue|to (?:read|access)|required)/i.test(text));
    if (subscription) return { reason: 'subscription', evidence: subscription };
    const authentication = headings.find(text => /(?:sign|log) in to (?:continue|read|access)/i.test(text));
    if (authentication) return { reason: 'authentication', evidence: authentication };
    // A bare 403 can have many causes; it is not proof of rate limiting.
}

export interface RecoveryOptions {
    maxRateLimitWaitMs?: number;
    /** Unchanged attempts before stopping; known-state cycles allow twice this many attempts. Default: 6. */
    repeatedActionLimit?: number;
    /** Opt in to heuristic loop warnings and automatic no-progress termination. */
    noProgress?: boolean;
}

export class BrowserRecovery {
    block?: BrowserBlock;
    warning?: string;
    waitUntil?: number;
    private rateWaitMs = 0;
    private blockedActions = 0;
    private recentStates = new Set<string>();
    private repetitions = 0;
    private knownStateAttempts = 0;
    private lastFingerprint?: string;
    readonly maxRateLimitWaitMs: number;
    readonly repeatedActionLimit: number;
    readonly noProgress: boolean;

    constructor(options: RecoveryOptions = {}) {
        this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 120_000;
        this.repeatedActionLimit = options.repeatedActionLimit ?? 6;
        this.noProgress = options.noProgress ?? false;
        if (!Number.isFinite(this.maxRateLimitWaitMs) || this.maxRateLimitWaitMs < 0
            || !Number.isSafeInteger(this.repeatedActionLimit) || this.repeatedActionLimit < 3) {
            throw new Error('Invalid browser recovery limits');
        }
    }

    reset() {
        this.block = undefined;
        this.rateWaitMs = 0;
        this.blockedActions = 0;
        this.recentStates.clear();
        this.recordProgress();
        this.lastFingerprint = undefined;
    }

    /** New non-page evidence, such as a browser download lifecycle transition. */
    recordProgress() {
        this.repetitions = 0;
        this.knownStateAttempts = 0;
        this.warning = undefined;
    }

    observe(fingerprint: string, action: Action | undefined, block: BrowserBlock | undefined, now = Date.now()) {
        const previousFingerprint = this.lastFingerprint ?? fingerprint;
        if (block?.reason !== this.block?.reason || fingerprint !== this.lastFingerprint) this.blockedActions = 0;
        const fresh = !this.recentStates.has(fingerprint) && this.recentStates.size < 4096;
        const initial = this.lastFingerprint === undefined;
        if (fresh || block) this.recordProgress();
        else if (fingerprint !== previousFingerprint) this.repetitions = 0;
        this.lastFingerprint = fingerprint;
        // Do not evict states: a cycle longer than an LRU must not look new forever.
        // At capacity, conservatively treat further states as previously seen.
        if (fresh) this.recentStates.add(fingerprint);
        if (block?.reason === 'rate_limit') {
            block.retryAt ??= this.block?.reason === 'rate_limit' ? this.block.retryAt : now + 60_000;
        }
        this.block = block;
        // Waiting is deliberate inactivity, not evidence of a navigation loop.
        if (!action || action.variant === 'wait' || action.variant === 'mouse:hover') return;
        if (block) { this.blockedActions++; return; }
        if (!this.noProgress) return;
        // Count outcomes, not action variants or coordinates. Familiar return
        // paths get extra room, but cycling without new evidence remains bounded.
        if (!fresh || initial) this.knownStateAttempts++;
        if (fingerprint === previousFingerprint) this.repetitions++;
        this.warning = this.repetitions >= 3 || this.knownStateAttempts >= this.repeatedActionLimit
            ? 'Browser actions have repeatedly produced previously seen states without new evidence. Use a materially different approach, wait for pending work, finish if the goal is verified, or report browser:blocked with reason no_progress.'
            : undefined;
    }

    check() {
        if (this.block && this.block.reason !== 'rate_limit' && this.blockedActions >= 3) {
            throw new BrowserBlockedError(this.block);
        }
        if (this.noProgress && !this.block && (this.repetitions >= this.repeatedActionLimit
            || this.knownStateAttempts >= 2 * this.repeatedActionLimit)) {
            throw new BrowserBlockedError({ reason: 'no_progress', evidence: this.warning! });
        }
    }

    waitDuration(requestedMs: number, now = Date.now(), deadline?: number): number {
        const duration = Math.max(requestedMs, (this.block?.retryAt ?? now) - now, 0);
        if (this.block?.reason === 'rate_limit') {
            if (deadline !== undefined && (this.block.retryAt ?? now) >= deadline) {
                throw new BrowserBlockedError({ ...this.block, evidence: `${this.block.evidence}; Retry-After exceeds the remaining operation deadline` });
            }
            if (this.rateWaitMs + duration > this.maxRateLimitWaitMs) {
                throw new BrowserBlockedError({ ...this.block, evidence: `${this.block.evidence}; required wait exceeds the remaining rate-limit wait budget` });
            }
            this.rateWaitMs += duration;
        }
        return duration;
    }
}
