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
    private recent: string[] = [];
    private recentStates = new Set<string>();
    private repetitions = 0;
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
        this.warning = undefined;
        this.rateWaitMs = 0;
        this.blockedActions = 0;
        this.recent = [];
        this.recentStates.clear();
        this.repetitions = 0;
        this.lastFingerprint = undefined;
    }

    observe(fingerprint: string, action: Action | undefined, block: BrowserBlock | undefined, now = Date.now()) {
        const previousFingerprint = this.lastFingerprint ?? fingerprint;
        if (block?.reason !== this.block?.reason || fingerprint !== this.lastFingerprint) this.blockedActions = 0;
        if (fingerprint !== this.lastFingerprint || block) {
            this.warning = undefined;
            this.repetitions = 0;
        }
        this.lastFingerprint = fingerprint;
        // New evidence breaks a loop, even when reaching it requires familiar paths.
        // Keep a bounded LRU of states separate from the repetition history.
        if (!this.recentStates.has(fingerprint) || block) this.recent = [];
        this.recentStates.delete(fingerprint);
        this.recentStates.add(fingerprint);
        if (this.recentStates.size > 30) this.recentStates.delete(this.recentStates.values().next().value!);
        if (block?.reason === 'rate_limit') {
            block.retryAt ??= this.block?.reason === 'rate_limit' ? this.block.retryAt : now + 60_000;
        }
        this.block = block;
        // Waiting is deliberate inactivity, not evidence of a navigation loop.
        if (!action || action.variant === 'wait' || action.variant === 'mouse:hover') return;
        if (block) { this.blockedActions++; return; }
        if (!this.noProgress) return;
        // Returning from different pages is not repeating the same transition.
        // Ignore coordinates so jitter cannot disguise genuinely unchanged clicks.
        const key = JSON.stringify([previousFingerprint, action.variant, fingerprint]);
        this.recent.push(key);
        if (this.recent.length > 30) this.recent.shift();
        this.repetitions = this.recent.filter(value => value === key).length;
        this.warning = this.repetitions >= 3
            ? 'This action has repeatedly produced a previously seen page state. Review tried searches and visited pages; use a materially different approach, or report browser:blocked with reason no_progress. Do not repeat the same search or click without new evidence.'
            : undefined;
    }

    check() {
        if (this.block && this.block.reason !== 'rate_limit' && this.blockedActions >= 3) {
            throw new BrowserBlockedError(this.block);
        }
        if (this.noProgress && !this.block && this.repetitions >= this.repeatedActionLimit) {
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
