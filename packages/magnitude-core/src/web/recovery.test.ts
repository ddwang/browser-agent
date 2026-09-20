import { expect, test } from 'bun:test';
import { BrowserBlockedError, BrowserRecovery, detectBlock, diagnosticUrl, retryAt } from './recovery';

const click = { variant: 'mouse:click', x: 10, y: 10 };

test('retry headers support seconds and HTTP dates, without persisting query credentials', () => {
    expect(retryAt('30', 1000)).toBe(31_000);
    expect(retryAt('Tue, 15 Sep 2026 00:00:00 GMT', 0)).toBe(Date.parse('2026-09-15T00:00:00Z'));
    expect(retryAt('invalid', 0)).toBeUndefined();
    expect(retryAt('-1', 0)).toBeUndefined();
    expect(diagnosticUrl('https://user:password@example.com/search?q=secret&token=secret#private')).toBe('https://example.com/search');
});

test('classifies explicit barriers, not a bare 403 or ordinary Subscribe button', () => {
    expect(detectBlock([], { status: 429, timestamp: 0, url: 'https://example.com', retryAt: 5000 })).toMatchObject({ reason: 'rate_limit', retryAt: 5000 });
    expect(detectBlock(['Too many requests'])).toMatchObject({ reason: 'rate_limit' });
    expect(detectBlock(['Subscribe to BBC to continue'])).toMatchObject({ reason: 'subscription' });
    expect(detectBlock(['Sign in to continue'])).toMatchObject({ reason: 'authentication' });
    expect(detectBlock(['Subscribe'], { status: 403, timestamp: 0, url: 'https://example.com' })).toBeUndefined();
    expect(detectBlock(['Normal page'], { status: 429, timestamp: 0, url: 'https://example.com/analytics', navigation: false })).toBeUndefined();
});

test('respects server cooldown, then blocks rather than shortening an unaffordable wait', () => {
    const recovery = new BrowserRecovery({ maxRateLimitWaitMs: 100, noProgress: true });
    recovery.observe('limited', click, { reason: 'rate_limit', evidence: '429', retryAt: 60 }, 0);
    expect(recovery.waitDuration(10, 0)).toBe(60);
    recovery.observe('limited', click, { reason: 'rate_limit', evidence: '429', retryAt: 120 }, 60);
    expect(() => recovery.waitDuration(0, 60)).toThrow(BrowserBlockedError);
});

test('unavailable retry headers get one stable cooldown, not a fresh delay on every observation', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    recovery.observe('limited', undefined, { reason: 'rate_limit', evidence: 'Too many requests' }, 0);
    recovery.observe('limited', { variant: 'wait' }, { reason: 'rate_limit', evidence: 'Too many requests' }, 60_000);
    expect(recovery.block?.retryAt).toBe(60_000);
    expect(recovery.waitDuration(0, 60_000)).toBe(0);
});

test('repeated outcomes warn before stopping, even if click coordinates vary', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    for (let i = 0; i < 3; i++) recovery.observe('same-query-and-page', { ...click, x: i }, undefined);
    expect(recovery.warning).toContain('different approach');
    expect(() => recovery.check()).not.toThrow();
    for (let i = 0; i < 3; i++) recovery.observe('same-query-and-page', click, undefined);
    expect(() => recovery.check()).toThrow(BrowserBlockedError);
});

test('no-progress termination is opt-in for library consumers', () => {
    const recovery = new BrowserRecovery();
    for (let i = 0; i < 100; i++) recovery.observe('unchanged', click, undefined);
    expect(recovery.warning).toBeUndefined();
    expect(() => recovery.check()).not.toThrow();
});

test('unavailable fingerprints clear a stall and do not count as repeated evidence', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    for (let i = 0; i < 6; i++) recovery.observe('same', click, undefined);
    expect(() => recovery.check()).toThrow(BrowserBlockedError);
    for (let i = 0; i < 20; i++) {
        recovery.observe(null, click, undefined);
        expect(recovery.warning).toBeUndefined();
        expect(() => recovery.check()).not.toThrow();
    }
    for (let i = 0; i < 6; i++) {
        expect(() => recovery.check()).not.toThrow();
        recovery.observe('same', click, undefined);
    }
    expect(() => recovery.check()).toThrow(BrowserBlockedError);
});

test('unavailable fingerprints preserve rate-limit cooldowns and deadline checks', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    const block = { reason: 'rate_limit' as const, evidence: 'Too many requests' };
    recovery.observe(null, click, { ...block }, 0);
    recovery.observe(null, { variant: 'wait' }, { ...block }, 10_000);
    expect(recovery.waitDuration(0, 10_000)).toBe(50_000);
    expect(() => recovery.waitDuration(0, 10_000, 30_000)).toThrow(BrowserBlockedError);
});

test('new page states and deliberate waits do not count as repeated outcomes', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    for (let i = 0; i < 20; i++) recovery.observe(`page-${i}`, click, undefined);
    for (let i = 0; i < 20; i++) recovery.observe('same', { variant: 'wait' }, undefined);
    expect(recovery.warning).toBeUndefined();
    expect(() => recovery.check()).not.toThrow();
});

test('subscription barrier allows a few recovery actions, then produces a distinct block', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    const block = { reason: 'subscription' as const, evidence: 'Subscribe to continue' };
    recovery.observe('paywall', undefined, block);
    for (let i = 0; i < 3; i++) { recovery.check(); recovery.observe('paywall', click, block); }
    expect(() => recovery.check()).toThrow(BrowserBlockedError);
    recovery.observe('accessible', undefined, undefined);
    expect(() => recovery.check()).not.toThrow();
});

for (const reason of ['subscription', 'authentication'] as const) {
    const block = { reason, evidence: 'Explicit access barrier' };

    test(`unavailable fingerprints preserve the ${reason} attempt limit`, () => {
        for (const noProgress of [false, true]) for (const fingerprints of [
            [null, null, null], ['same', null, 'same'], [null, null, 'same'], ['same', 'same', null],
        ]) {
            const recovery = new BrowserRecovery({ noProgress });
            recovery.observe(fingerprints[0], undefined, block);
            for (const fingerprint of fingerprints) {
                expect(() => recovery.check()).not.toThrow();
                recovery.observe(fingerprint, click, block);
            }
            expect(() => recovery.check()).toThrow(BrowserBlockedError);
            expect(recovery.block?.reason).toBe(reason);
            for (const action of [undefined, { variant: 'wait' }, { variant: 'mouse:hover' }]) {
                recovery.observe(null, action, block);
                expect(() => recovery.check()).toThrow(BrowserBlockedError);
                expect(recovery.warning).toBeUndefined();
            }
        }
    });

    test(`a changed known fingerprint resets ${reason} attempts across unavailable observations`, () => {
        const recovery = new BrowserRecovery();
        for (let i = 0; i < 3; i++) recovery.observe('old', click, block);
        expect(() => recovery.check()).toThrow(BrowserBlockedError);
        recovery.observe(null, undefined, block);
        recovery.observe('new', undefined, block);
        for (let i = 0; i < 3; i++) {
            expect(() => recovery.check()).not.toThrow();
            recovery.observe('new', click, block);
        }
        expect(() => recovery.check()).toThrow(BrowserBlockedError);
    });

    test(`clearing or changing the ${reason} barrier and task reset release its attempt limit`, () => {
        const other = { ...block, reason: reason === 'subscription' ? 'authentication' as const : 'subscription' as const };
        for (const nextBlock of [undefined, other]) {
            const recovery = new BrowserRecovery();
            for (let i = 0; i < 3; i++) recovery.observe(null, click, block);
            expect(() => recovery.check()).toThrow(BrowserBlockedError);
            recovery.observe(null, undefined, nextBlock);
            expect(() => recovery.check()).not.toThrow();
            if (nextBlock) expect(recovery.block?.reason).toBe(nextBlock.reason);
            else expect(recovery.block).toBeUndefined();
            for (let i = 0; i < 3; i++) {
                expect(() => recovery.check()).not.toThrow();
                recovery.observe(null, click, nextBlock);
            }
            if (nextBlock) expect(() => recovery.check()).toThrow(BrowserBlockedError);
            else expect(() => recovery.check()).not.toThrow();
            recovery.reset();
            for (let i = 0; i < 3; i++) {
                expect(() => recovery.check()).not.toThrow();
                recovery.observe(null, click, block);
            }
            expect(() => recovery.check()).toThrow(BrowserBlockedError);
        }
    });
}

test('a new task resets previous repetition and wait budgets', () => {
    const recovery = new BrowserRecovery({ maxRateLimitWaitMs: 100, noProgress: true });
    for (let i = 0; i < 6; i++) recovery.observe('same', click, undefined);
    recovery.reset();
    expect(() => recovery.check()).not.toThrow();
    recovery.observe('limited', undefined, { reason: 'rate_limit', evidence: '429', retryAt: 100 }, 0);
    expect(recovery.waitDuration(0, 0)).toBe(100);
    recovery.reset();
    recovery.observe('limited', undefined, { reason: 'rate_limit', evidence: '429', retryAt: 200 }, 100);
    expect(recovery.waitDuration(0, 100)).toBe(100);
});

test('new content after a wait clears the old loop warning', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    for (let i = 0; i < 6; i++) recovery.observe('old', click, undefined);
    recovery.observe('newly-loaded-results', { variant: 'wait' }, undefined);
    expect(recovery.warning).toBeUndefined();
    expect(() => recovery.check()).not.toThrow();
});

test('changing sign-in steps are not mistaken for an unchanged barrier', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    for (let i = 0; i < 6; i++) {
        recovery.observe(`step-${i}`, click, { reason: 'authentication', evidence: 'Sign in to continue' });
        expect(() => recovery.check()).not.toThrow();
    }
});

test('productive graph walks can revisit hubs and shared return paths without warnings', () => {
    for (const depth of [1, 2, 4]) for (const breadth of [7, 13, 40]) {
        const recovery = new BrowserRecovery({ noProgress: true });
        recovery.observe('hub', undefined, undefined);
        for (let leaf = 0; leaf < breadth; leaf++) {
            const path = [`record-${leaf}`, ...Array.from({ length: depth }, (_, i) => `return-${i}`), 'hub'];
            for (const state of path) {
                expect(() => recovery.check()).not.toThrow();
                recovery.observe(state, click, undefined);
                expect(recovery.warning).toBeUndefined();
            }
        }
        expect(() => recovery.check()).not.toThrow();
    }
});

test('cycles stop after twice the configured bound without new evidence, including long cycles', () => {
    for (const length of [2, 3, 5, 40, 100]) {
        const recovery = new BrowserRecovery({ noProgress: true });
        for (let i = 0; i < length; i++) recovery.observe(`state-${i}`, click, undefined);
        let warned = false;
        for (let step = 0; step < 2 * recovery.repeatedActionLimit; step++) {
            expect(() => recovery.check()).not.toThrow();
            recovery.observe(`state-${step % length}`, { ...click, x: step,
                variant: step % 2 ? 'mouse:right_click' : 'keyboard:enter' }, undefined);
            warned ||= Boolean(recovery.warning);
        }
        expect(warned).toBe(true);
        expect(() => recovery.check()).toThrow(BrowserBlockedError);
    }
});

test('different routes through already known records do not count as new evidence', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    for (let i = 0; i < 9; i++) recovery.observe(`known-${i}`, undefined, undefined);
    recovery.observe('hub', undefined, undefined);
    for (let i = 0; i < recovery.repeatedActionLimit; i++) {
        expect(() => recovery.check()).not.toThrow();
        recovery.observe(`known-${i}`, click, undefined);
        recovery.observe('hub', click, undefined);
    }
    expect(() => recovery.check()).toThrow(BrowserBlockedError);
});

test('new evidence clears old repetition history even when returning to a familiar page', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    recovery.observe('hub', undefined, undefined);
    for (let i = 0; i < 5; i++) recovery.observe('hub', click, undefined);
    recovery.observe('new-evidence', click, undefined);
    recovery.observe('hub', click, undefined);
    expect(recovery.warning).toBeUndefined();
    for (let i = 0; i < 5; i++) {
        expect(() => recovery.check()).not.toThrow();
        recovery.observe('hub', click, undefined);
    }
    expect(() => recovery.check()).not.toThrow();
    recovery.observe('hub', click, undefined);
    expect(() => recovery.check()).toThrow(BrowserBlockedError);
});

test('passive observations neither add failures nor erase an unchanged-page stop', () => {
    for (const action of [undefined, { variant: 'wait' }, { variant: 'mouse:hover' }]) {
        const recovery = new BrowserRecovery({ noProgress: true });
        for (let i = 0; i < 6; i++) recovery.observe('same', click, undefined);
        for (let i = 0; i < 40; i++) recovery.observe('same', action, undefined);
        expect(() => recovery.check()).toThrow(BrowserBlockedError);
        recovery.observe('fresh-evidence', action, undefined);
        recovery.observe('same', click, undefined);
        expect(recovery.warning).toBeUndefined();
        expect(() => recovery.check()).not.toThrow();
    }
});

test('a task reset clears both known states and attempt counts', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    for (let i = 0; i < 7; i++) {
        recovery.observe('a', click, undefined);
        recovery.observe('b', click, undefined);
    }
    expect(() => recovery.check()).toThrow(BrowserBlockedError);
    recovery.reset();
    recovery.observe('a', undefined, undefined);
    recovery.observe('b', click, undefined);
    recovery.observe('a', click, undefined);
    expect(recovery.warning).toBeUndefined();
    expect(() => recovery.check()).not.toThrow();
});

test('alternating action types and coordinate jitter share the configured unchanged-state bound', () => {
    for (const repeatedActionLimit of [3, 6, 9, 40]) {
        const recovery = new BrowserRecovery({ noProgress: true, repeatedActionLimit });
        recovery.observe('inert', undefined, undefined);
        const variants = ['mouse:click', 'mouse:double_click', 'mouse:right_click', 'keyboard:enter'];
        for (let i = 0; i < repeatedActionLimit; i++) {
            recovery.check();
            recovery.observe('inert', { variant: variants[i % variants.length], x: i, y: i + 1 }, undefined);
            recovery.observe('inert', { variant: 'mouse:hover' }, undefined);
        }
        expect(() => recovery.check()).toThrow(BrowserBlockedError);
    }
});

test('new download evidence resets attempts without treating a pending transfer as endless progress', () => {
    const recovery = new BrowserRecovery({ noProgress: true, repeatedActionLimit: 3 });
    recovery.observe('same', undefined, undefined);
    for (const transition of ['started', 'completed', 'failed']) {
        for (let i = 0; i < 3; i++) recovery.observe('same', click, undefined);
        expect(() => recovery.check()).toThrow(BrowserBlockedError);
        recovery.recordProgress();
        expect(recovery.warning).toBeUndefined();
        expect(() => recovery.check()).not.toThrow();
    }
});

test('bounded state memory never evicts a long cycle and becomes conservative at capacity', () => {
    const recovery = new BrowserRecovery({ noProgress: true });
    for (let i = 0; i < 4096; i++) {
        recovery.observe(`state-${i}`, click, undefined);
        recovery.check();
    }
    for (let i = 0; i < 12; i++) recovery.observe(`overflow-${i}`, click, undefined);
    expect(() => recovery.check()).toThrow(BrowserBlockedError);
    recovery.reset();
    recovery.observe('new-task', click, undefined);
    expect(() => recovery.check()).not.toThrow();
});
