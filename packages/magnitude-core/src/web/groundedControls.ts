import { randomUUID } from 'node:crypto';
import type { JSHandle, Page } from 'playwright';
import { checkOperation, currentOperation, type Operation } from '@/common/operation';
import type { WebHarness } from './harness';

export const GROUNDED_CLICK_REJECTED = Object.freeze({ clicked: false, reason: 'target_unavailable',
    instruction: 'No click was submitted. Replan from the new observation; do not reuse the rejected reference.' });

/** A deliberately small, current-viewport subset; this is not an accessibility tree. */
function captureControls() {
    const documentAtCapture = document;
    const url = location.href;
    const visibility = { checkOpacity: true, checkVisibility: true };
    function describe(node: Element) {
        if (!(node instanceof HTMLAnchorElement || node instanceof HTMLButtonElement)
            || !node.isConnected || !node.checkVisibility(visibility) || node.closest('[hidden],[inert],[aria-hidden="true"]')) return null;
        if (node instanceof HTMLButtonElement && node.form && node.type !== 'button') return null;
        if (node instanceof HTMLAnchorElement && !/^https?:$/.test(node.protocol)) return null;
        const box = node.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0 || box.left < 0 || box.top < 0
            || box.right > innerWidth || box.bottom > innerHeight) return null;
        const labelledBy = node.getAttribute('aria-labelledby');
        const label = (labelledBy
            ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
            : node.getAttribute('aria-label') || node.innerText || node.getAttribute('title') || '').trim();
        if (!label || label.length > 256) return null;
        const container = node.closest('tr,[role="row"],li,fieldset,form,dialog,[role="dialog"],section,article');
        const context = (container?.matches('tr,[role="row"],li')
            ? (container as HTMLElement).innerText
            : container?.getAttribute('aria-label') || container?.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3')?.textContent || '').trim();
        if (context.length > 256) return null;
        const enabled = !node.matches(':disabled') && !node.closest('[aria-disabled="true"]');
        const role = node.getAttribute('role') || (node instanceof HTMLAnchorElement ? 'link' : 'button');
        // Keep activation attributes and context identity local, not in diagnostics.
        const identity = JSON.stringify([label, context, role, enabled,
            node.getAttribute('href'), node instanceof HTMLAnchorElement ? node.href : null,
            node.getAttribute('target'), node.getAttribute('download'), node.getAttribute('type'),
            node.getAttribute('popovertarget'), node.getAttribute('popovertargetaction'),
            node.getAttribute('commandfor'), node.getAttribute('command'),
            node.getAttribute('aria-expanded'), node.getAttribute('aria-selected'), node.getAttribute('aria-pressed')]);
        const form = node instanceof HTMLButtonElement ? node.form : null;
        return { label, context, role, enabled, identity, container, form, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    const nodes: Element[] = [];
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT, {
        acceptNode: node => (node as Element).matches('a[href],button') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    }); // Does not cross frames or shadow roots; stop collecting at the first match beyond the cap.
    while (nodes.length <= 512 && walker.nextNode()) nodes.push(walker.currentNode as Element);
    const entries: { node: Element; state: NonNullable<ReturnType<typeof describe>> }[] = [];
    let truncated = nodes.length > 512;
    if (!truncated) for (const node of nodes) {
        const state = describe(node);
        if (state) entries.push({ node, state });
    }
    const counts = new Map<string, number>();
    const key = (state: { label: string; context: string; role: string }) => JSON.stringify([state.role, state.label, state.context]);
    for (const { state } of entries) counts.set(key(state), (counts.get(key(state)) ?? 0) + 1);
    let bytes = 0;
    const controls: { role: string; label: string; context: string; enabled: boolean; ambiguous: boolean }[] = [];
    for (const { state } of entries) {
        const item = { role: state.role, label: state.label, context: state.context, enabled: state.enabled, ambiguous: counts.get(key(state))! > 1 };
        bytes += new TextEncoder().encode(JSON.stringify(item)).length + 100; // Reserve reference/JSON overhead.
        if (controls.length === 64 || bytes > 16_000) { truncated = true; break; }
        controls.push(item);
    }
    return {
        controls, truncated,
        resolve(index: number) {
            const entry = entries[index];
            if (document !== documentAtCapture || location.href !== url || !entry || !controls[index]
                || controls[index].ambiguous) return null;
            const state = describe(entry.node);
            if (!state || !state.enabled || state.container !== entry.state.container
                || state.form !== entry.state.form || state.identity !== entry.state.identity) return null;
            const hit = document.elementFromPoint(state.x, state.y);
            if (!hit || !(hit === entry.node || entry.node.contains(hit))) return null;
            return { x: state.x, y: state.y };
        },
    };
}

/** One disposable snapshot, owned by the operation that observed it. No DOM attributes are injected. */
export class GroundedControls {
    private snapshot?: { handle: JSHandle<ReturnType<typeof captureControls>>; page: Page; operation: Operation; prefix: string };

    async clear(): Promise<void> {
        const snapshot = this.snapshot;
        this.snapshot = undefined;
        await snapshot?.handle.dispose();
    }

    async observe(page: Page) {
        await this.clear();
        checkOperation();
        const operation = currentOperation();
        if (!operation) return { controls: [], truncated: false, scope: 'viewport-native-links-and-buttons' };
        const handle = await page.evaluateHandle(captureControls);
        const prefix = randomUUID();
        this.snapshot = { handle, page, operation, prefix };
        checkOperation();
        const data = await handle.evaluate(({ controls, truncated }) => ({ controls, truncated }));
        return { scope: 'viewport-native-links-and-buttons', truncated: data.truncated,
            controls: data.controls.map((control, index) => ({ ref: `${prefix}:${index}`, ...control })) };
    }

    async click(harness: WebHarness, ref: string): Promise<boolean> {
        const snapshot = this.snapshot;
        const index = Number(ref.slice(ref.lastIndexOf(':') + 1));
        if (!snapshot || snapshot.operation !== currentOperation() || !Number.isInteger(index)
            || ref !== `${snapshot.prefix}:${index}`) return false;
        return harness.clickGrounded(async () => {
            checkOperation();
            if (this.snapshot !== snapshot || harness.page !== snapshot.page) return null;
            try { return await snapshot.handle.evaluate((state, index) => state.resolve(index), index); }
            catch { checkOperation(); return null; } // A destroyed document rejects the read; never replay a click.
        });
    }
}
