import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PlaywrightBlocker, fromPlaywrightDetails } from '@ghostery/adblocker-playwright';
import type { BrowserContext, Page, Request, Route } from 'patchright';
import type { FilterList } from './results';

export function describeFilterLists(paths: string[]): FilterList[] {
    const lists = paths.map(path => ({ name: basename(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
    if (new Set(lists.map(list => list.name)).size !== lists.length) throw new Error('Filter list file names must be unique.');
    return lists;
}

// Copies the snapshots into the run so every worker, including resumed ones, uses the same rules.
export function saveFilterLists(paths: string[], runDir: string) {
    mkdirSync(join(runDir, 'filter-lists'), { recursive: true });
    for (const path of paths) copyFileSync(path, join(runDir, 'filter-lists', basename(path)));
}

type Decision = { kind: 'continue' } | { kind: 'abort' } | { kind: 'fulfill'; body: string | Buffer; contentType: string };

// Mirrors PlaywrightBlocker.onRequest, which does not await or catch its route calls.
function decide(blocker: PlaywrightBlocker, details: Request): Decision {
    const request = fromPlaywrightDetails(details);
    if (request.isMainFrame() || (request.type === 'document' && details.frame().parentFrame() === null)) return { kind: 'continue' };
    const { match, redirect } = blocker.match(request);
    if (redirect) return redirect.contentType.endsWith(';base64')
        ? { kind: 'fulfill', body: Buffer.from(redirect.body, 'base64'), contentType: redirect.contentType.slice(0, -7) }
        : { kind: 'fulfill', body: redirect.body, contentType: redirect.contentType };
    return match ? { kind: 'abort' } : { kind: 'continue' };
}

// Blocks network requests and injects cosmetic filters in every page of the context.
// Request routing disables Chromium's HTTP cache for this context.
export async function enableFilterLists(context: BrowserContext, runDir: string, lists: FilterList[]) {
    const rules = lists.map(list => readFileSync(join(runDir, 'filter-lists', list.name), 'utf8')).join('\n');
    const blocker = PlaywrightBlocker.parse(rules);
    const stats = { blockedRequests: 0 };
    await context.route('**/*', async (route: Route) => {
        let decision: Decision;
        try { decision = decide(blocker, route.request()); }
        catch { decision = { kind: 'continue' }; } // Service worker requests have no frame.
        if (decision.kind !== 'continue') stats.blockedRequests++;
        try {
            if (decision.kind === 'abort') await route.abort('blockedbyclient');
            else if (decision.kind === 'fulfill') await route.fulfill({ body: decision.body, contentType: decision.contentType });
            else await route.continue();
        } catch {} // The page can close while its request is routed.
    });
    // Like BlockingContext.enable, also rescan the first loaded document.
    const watch = (page: Page) => page.on('framenavigated', blocker.onFrameNavigated)
        .once('domcontentloaded', () => blocker.onFrameNavigated(page.mainFrame()));
    context.pages().forEach(watch);
    context.on('page', watch);
    return stats;
}
