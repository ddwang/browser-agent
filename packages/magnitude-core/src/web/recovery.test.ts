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
    const recovery = new BrowserRecovery({ maxRateLimitWaitMs: 100 });
    recovery.observe('limited', click, { reason: 'rate_limit', evidence: '429', retryAt: 60 }, 0);
    expect(recovery.waitDuration(10, 0)).toBe(60);
    recovery.observe('limited', click, { reason: 'rate_limit', evidence: '429', retryAt: 120 }, 60);
    expect(() => recovery.waitDuration(0, 60)).toThrow(BrowserBlockedError);
});

test('unavailable retry headers get one stable cooldown, not a fresh delay on every observation', () => {
    const recovery = new BrowserRecovery();
    recovery.observe('limited', undefined, { reason: 'rate_limit', evidence: 'Too many requests' }, 0);
    recovery.observe('limited', { variant: 'wait' }, { reason: 'rate_limit', evidence: 'Too many requests' }, 60_000);
    expect(recovery.block?.retryAt).toBe(60_000);
    expect(recovery.waitDuration(0, 60_000)).toBe(0);
});

test('repeated outcomes warn before stopping, even if click coordinates vary', () => {
    const recovery = new BrowserRecovery();
    for (let i = 0; i < 3; i++) recovery.observe('same-query-and-page', { ...click, x: i }, undefined);
    expect(recovery.warning).toContain('different approach');
    expect(() => recovery.check(click)).not.toThrow();
    for (let i = 0; i < 3; i++) recovery.observe('same-query-and-page', click, undefined);
    expect(() => recovery.check(click)).toThrow(BrowserBlockedError);
    expect(() => recovery.check({ variant: 'browser:blocked' })).not.toThrow();
});

test('new page states and deliberate waits do not count as repeated outcomes', () => {
    const recovery = new BrowserRecovery();
    for (let i = 0; i < 20; i++) recovery.observe(`page-${i}`, click, undefined);
    for (let i = 0; i < 20; i++) recovery.observe('same', { variant: 'wait' }, undefined);
    expect(recovery.warning).toBeUndefined();
    expect(() => recovery.check(click)).not.toThrow();
});

test('subscription barrier allows a few recovery actions, then produces a distinct block', () => {
    const recovery = new BrowserRecovery();
    const block = { reason: 'subscription' as const, evidence: 'Subscribe to continue' };
    recovery.observe('paywall', undefined, block);
    for (let i = 0; i < 3; i++) { recovery.check(click); recovery.observe('paywall', click, block); }
    expect(() => recovery.check(click)).toThrow(BrowserBlockedError);
    recovery.observe('accessible', undefined, undefined);
    expect(() => recovery.check(click)).not.toThrow();
});

test('a new task resets previous repetition and wait budgets', () => {
    const recovery = new BrowserRecovery({ maxRateLimitWaitMs: 100 });
    for (let i = 0; i < 6; i++) recovery.observe('same', click, undefined);
    recovery.reset();
    expect(() => recovery.check(click)).not.toThrow();
    recovery.observe('limited', undefined, { reason: 'rate_limit', evidence: '429', retryAt: 100 }, 0);
    expect(recovery.waitDuration(0, 0)).toBe(100);
    recovery.reset();
    recovery.observe('limited', undefined, { reason: 'rate_limit', evidence: '429', retryAt: 200 }, 100);
    expect(recovery.waitDuration(0, 100)).toBe(100);
});

test('new content after a wait clears the old loop warning', () => {
    const recovery = new BrowserRecovery();
    for (let i = 0; i < 6; i++) recovery.observe('old', click, undefined);
    recovery.observe('newly-loaded-results', { variant: 'wait' }, undefined);
    expect(recovery.warning).toBeUndefined();
    expect(() => recovery.check(click)).not.toThrow();
});

test('changing sign-in steps are not mistaken for an unchanged barrier', () => {
    const recovery = new BrowserRecovery();
    for (let i = 0; i < 6; i++) {
        recovery.observe(`step-${i}`, click, { reason: 'authentication', evidence: 'Sign in to continue' });
        expect(() => recovery.check(click)).not.toThrow();
    }
});
