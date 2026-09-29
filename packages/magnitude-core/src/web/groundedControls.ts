import { randomUUID } from 'node:crypto';
import type { ElementHandle, Frame, JSHandle, Page } from 'playwright';
import { checkOperation, currentOperation, type Operation } from '@/common/operation';
import type { WebHarness } from './harness';

export const GROUNDED_CLICK_REJECTED = Object.freeze({ clicked: false, reason: 'target_unavailable',
    instruction: 'No click was submitted. Replan from the new observation; do not reuse the rejected reference.' });

export const GROUNDED_INPUT_REJECTED = Object.freeze({ changed: false, reason: 'target_unavailable',
    instruction: 'No value was set. Replan from the new observation; do not reuse the rejected reference.' });

// Native form controls whose pickers render outside the page screenshot.
const FIELDS = 'select,input[type="date"],input[type="time"],input[type="datetime-local"],input[type="month"],input[type="week"]';

/** A deliberately small, current-viewport subset of one frame; this is not an accessibility tree. */
function captureControls(fields: string) {
    const documentAtCapture = document;
    const url = location.href;
    const visibility: CheckVisibilityOptions = { checkOpacity: true, checkVisibilityCSS: true };
    const interactive = 'a[href],area[href],button,input,select,textarea,label,summary,iframe,object,embed,'
        + 'audio[controls],video[controls],[tabindex],[contenteditable]:not([contenteditable="false"]),'
        + '[role~="button"],[role~="link"],[role~="checkbox"],[role~="radio"],[role~="switch"],'
        + '[role~="menuitem"],[role~="menuitemcheckbox"],[role~="menuitemradio"],[role~="option"],'
        + '[role~="combobox"],[role~="listbox"],[role~="textbox"],[role~="searchbox"],'
        + '[role~="slider"],[role~="spinbutton"],[role~="scrollbar"],[role~="tab"],[role~="treeitem"]';
    const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    function describe(node: Element) {
        const field = node.matches(fields) ? node as HTMLSelectElement | HTMLInputElement : null;
        if (!(field || node instanceof HTMLAnchorElement || node instanceof HTMLButtonElement)
            || !node.isConnected || !node.checkVisibility(visibility) || node.closest('[hidden],[inert],[aria-hidden="true"]')) return null;
        if (node instanceof HTMLButtonElement && node.form && node.type !== 'button') return null;
        if (node instanceof HTMLAnchorElement && !/^https?:$/.test(node.protocol)) return null;
        const box = node.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0 || box.left < 0 || box.top < 0
            || box.right > innerWidth || box.bottom > innerHeight) return null;
        const labelledBy = node.getAttribute('aria-labelledby');
        const label = text(labelledBy
            ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
            : node.getAttribute('aria-label') || (field
                // A wrapping label also contains the field's own text, such as its option labels.
                ? Array.from(field.labels?.[0]?.childNodes ?? []).filter(child => !(child instanceof Element && child.matches('input,select,textarea,button')))
                    .map(child => child.textContent).join(' ').trim() || node.getAttribute('title') || node.getAttribute('name')
                : (node as HTMLElement).innerText || node.getAttribute('title')));
        if (!label || label.length > 256) return null;
        const container = node.closest('tr,[role="row"],li,fieldset,form,dialog,[role="dialog"],section,article');
        const context = text(container?.matches('tr,[role="row"],li')
            ? (container as HTMLElement).innerText
            : container?.getAttribute('aria-label') || container?.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3')?.textContent);
        if (context.length > 256) return null;
        const enabled = !node.matches(':disabled') && !node.closest('[aria-disabled="true"]') && !(field as HTMLInputElement | null)?.readOnly;
        const role = field instanceof HTMLSelectElement ? 'select' : field ? (field as HTMLInputElement).type
            : node.getAttribute('role') || (node instanceof HTMLAnchorElement ? 'link' : 'button');
        const value = field instanceof HTMLSelectElement ? text(field.selectedOptions[0]?.text) : field ? field.value : undefined;
        const options = field instanceof HTMLSelectElement
            ? Array.from(field.options).filter(option => !option.disabled && !option.hidden).slice(0, 40).map(option => text(option.text)) : undefined;
        // Keep activation attributes and context identity local, not in diagnostics.
        const identity = JSON.stringify([label, context, role, enabled, node.getAttribute('name'),
            node.getAttribute('href'), node instanceof HTMLAnchorElement ? node.href : null,
            node.getAttribute('target'), node.getAttribute('download'), node.getAttribute('type'),
            node.getAttribute('popovertarget'), node.getAttribute('popovertargetaction'),
            node.getAttribute('commandfor'), node.getAttribute('command'),
            node.getAttribute('aria-expanded'), node.getAttribute('aria-selected'), node.getAttribute('aria-pressed')]);
        const form = node instanceof HTMLButtonElement || field ? (node as HTMLButtonElement).form : null;
        return { label, context, role, enabled, value, options, identity, container, form,
            box: { x: box.x, y: box.y, width: box.width, height: box.height } };
    }
    const nodes: Element[] = [];
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT, {
        acceptNode: node => (node as Element).matches(`a[href],button,${fields}`) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    }); // Does not cross frames or shadow roots; stop collecting at the first match beyond the cap.
    while (nodes.length <= 512 && walker.nextNode()) nodes.push(walker.currentNode as Element);
    const entries: { node: Element; state: NonNullable<ReturnType<typeof describe>> }[] = [];
    const truncated = nodes.length > 512;
    if (!truncated) for (const node of nodes) {
        const state = describe(node);
        if (state) entries.push({ node, state });
    }
    // Re-check a reference against the node it was captured from, without dispatching anything.
    function current(index: number) {
        const entry = entries[index];
        if (document !== documentAtCapture || location.href !== url || !entry) return null;
        const state = describe(entry.node);
        if (!state || !state.enabled || state.container !== entry.state.container
            || state.form !== entry.state.form || state.identity !== entry.state.identity) return null;
        return { entry, state };
    }
    return {
        truncated,
        controls: entries.map(({ state }) => ({ role: state.role, label: state.label, context: state.context, enabled: state.enabled,
            ...(state.value !== undefined ? { value: state.value } : {}), ...(state.options ? { options: state.options } : {}), box: state.box })),
        point(index: number) {
            const resolved = current(index);
            if (!resolved) return null;
            const { entry, state } = resolved;
            const x = state.box.x + state.box.width / 2, y = state.box.y + state.box.height / 2;
            const hit = document.elementFromPoint(x, y);
            // Text/icon descendants belong to this control; nested controls do not.
            if (!hit || hit.closest(interactive) !== entry.node) return null;
            // Hit-testing retargets shadow content to its host. Do not treat that
            // host (or a slotted descendant) as ordinary content of the control.
            for (let descendant: Element | null = hit; descendant && descendant !== entry.node; descendant = descendant.parentElement) {
                if (descendant.shadowRoot || descendant.localName.includes('-') || descendant.hasAttribute('is')) return null;
            }
            return { x, y };
        },
        field(index: number) {
            const resolved = current(index);
            return resolved && resolved.entry.node.matches(fields) ? resolved.entry.node : null;
        },
    };
}

type Capture = ReturnType<typeof captureControls>;
type Rect = { x: number; y: number; width: number; height: number };
type Entry = { frame: Frame; handle: JSHandle<Capture>; index: number; role: string; ambiguous?: boolean };
// Large enough to hold any frame, so offsets are computed without clipping.
const UNCLIPPED = { x: -1e9, y: -1e9, width: 2e9, height: 2e9 };

// Where a frame's content box sits in main-viewport coordinates, clipped to what is visible.
async function frameArea(frame: Frame, viewport: Rect): Promise<Rect & { dx: number; dy: number } | null> {
    const parent = frame.parentFrame();
    if (!parent) return { ...viewport, dx: 0, dy: 0 };
    const outer = await frameArea(parent, viewport);
    const owner = outer && await frame.frameElement().catch(() => null);
    if (!outer || !owner) return null;
    try {
        const box = await owner.evaluate(node => {
            const element = node as HTMLElement;
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            const left = rect.left + element.clientLeft + parseFloat(style.paddingLeft);
            const top = rect.top + element.clientTop + parseFloat(style.paddingTop);
            return { left, top, width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                height: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) };
        });
        const dx = outer.dx + box.left, dy = outer.dy + box.top;
        const x = Math.max(outer.x, dx), y = Math.max(outer.y, dy);
        const width = Math.min(outer.x + outer.width, dx + box.width) - x, height = Math.min(outer.y + outer.height, dy + box.height) - y;
        return width > 0 && height > 0 ? { x, y, width, height, dx, dy } : null;
    } finally { await owner.dispose(); }
}

// Each ancestor frame must show its iframe at the point; another element covering it would take the click.
async function frameVisibleAt(frame: Frame, x: number, y: number): Promise<boolean> {
    const parent = frame.parentFrame();
    if (!parent) return true;
    const owner = await frame.frameElement().catch(() => null);
    if (!owner) return false;
    try {
        const local = await frameArea(parent, UNCLIPPED);
        if (!local) return false;
        const hit = await owner.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element,
            { x: x - local.dx, y: y - local.dy });
        return hit && await frameVisibleAt(parent, x, y);
    } finally { await owner.dispose(); }
}

/** One disposable snapshot per frame, owned by the operation that observed it. No DOM attributes are injected. */
export class GroundedControls {
    private snapshot?: { handles: JSHandle<Capture>[]; entries: Entry[]; page: Page; operation: Operation; prefix: string };

    async clear(): Promise<void> {
        const snapshot = this.snapshot;
        this.snapshot = undefined;
        await Promise.all(snapshot?.handles.map(handle => handle.dispose().catch(() => {})) ?? []);
    }

    async observe(page: Page) {
        await this.clear();
        checkOperation();
        const scope = 'viewport-links-buttons-and-native-fields';
        const operation = currentOperation();
        if (!operation) return { controls: [], truncated: false, scope };
        const size = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const viewport = { x: 0, y: 0, ...size };
        const handles: JSHandle<Capture>[] = [], entries: Entry[] = [];
        const listed: { role: string; label: string; context: string; enabled: boolean; value?: string; options?: string[] }[] = [];
        let truncated = false, bytes = 0;
        const prefix = randomUUID();
        this.snapshot = { handles, entries, page, operation, prefix };
        for (const frame of page.frames()) {
            const area = await frameArea(frame, viewport).catch(() => null);
            if (!area) continue;
            const handle = await frame.evaluateHandle(captureControls, FIELDS).catch(() => null);
            checkOperation();
            if (!handle) continue;
            handles.push(handle);
            const data = await handle.evaluate(({ controls, truncated }) => ({ controls, truncated })).catch(() => null);
            if (!data) continue;
            truncated ||= data.truncated;
            data.controls.forEach(({ box, ...control }, index) => {
                const x = area.dx + box.x, y = area.dy + box.y;
                // Only controls fully inside the frame's visible area of the main viewport.
                if (x < area.x || y < area.y || x + box.width > area.x + area.width || y + box.height > area.y + area.height) return;
                bytes += new TextEncoder().encode(JSON.stringify(control)).length + 100; // Reserve reference/JSON overhead.
                if (listed.length === 64 || bytes > 16_000) { truncated = true; return; }
                listed.push(control);
                entries.push({ frame, handle, index, role: control.role });
            });
        }
        checkOperation();
        const key = (control: { role: string; label: string; context: string }) => JSON.stringify([control.role, control.label, control.context]);
        const counts = new Map<string, number>();
        for (const control of listed) counts.set(key(control), (counts.get(key(control)) ?? 0) + 1);
        listed.forEach((control, index) => { entries[index].ambiguous = counts.get(key(control))! > 1; });
        return { scope, truncated,
            controls: listed.map((control, index) => ({ ref: `${prefix}:${index}`, ...control, ambiguous: entries[index].ambiguous })) };
    }

    private entry(ref: string) {
        const snapshot = this.snapshot;
        const index = Number(ref.slice(ref.lastIndexOf(':') + 1));
        if (!snapshot || snapshot.operation !== currentOperation() || !Number.isInteger(index)
            || ref !== `${snapshot.prefix}:${index}` || !snapshot.entries[index] || snapshot.entries[index].ambiguous) return null;
        return { snapshot, entry: snapshot.entries[index] };
    }

    async click(harness: WebHarness, ref: string): Promise<boolean> {
        const found = this.entry(ref);
        if (!found) return false;
        const { snapshot, entry } = found;
        return harness.clickGrounded(async () => {
            checkOperation();
            if (this.snapshot !== snapshot || harness.page !== snapshot.page) return null;
            try {
                const area = await frameArea(entry.frame, UNCLIPPED);
                const point = area && await entry.handle.evaluate((state, index) => state.point(index), entry.index);
                if (!area || !point) return null;
                const x = area.dx + point.x, y = area.dy + point.y;
                return await frameVisibleAt(entry.frame, x, y) ? { x, y } : null;
            } catch { checkOperation(); return null; } // A destroyed document rejects the read; never replay a click.
        });
    }

    /** Sets a native select or date-like input through the DOM, where its picker can't be seen. */
    async setValue(harness: WebHarness, ref: string, value: string, kind: 'select' | 'fill'): Promise<{ changed: true; value: string } | typeof GROUNDED_INPUT_REJECTED | { changed: false; reason: string; instruction: string }> {
        const found = this.entry(ref);
        if (!found || (kind === 'select') !== (found.entry.role === 'select')) return GROUNDED_INPUT_REJECTED;
        const { snapshot, entry } = found;
        if (this.snapshot !== snapshot || harness.page !== snapshot.page) return GROUNDED_INPUT_REJECTED;
        let element: ElementHandle | null = null;
        try {
            element = (await entry.handle.evaluateHandle((state, index) => state.field(index), entry.index)).asElement();
            checkOperation();
            if (!element) return GROUNDED_INPUT_REJECTED;
            if (kind === 'select') {
                const options = await element.evaluate((select, wanted) => Array.from((select as HTMLSelectElement).options)
                    .filter(option => !option.disabled && option.text.replace(/\s+/g, ' ').trim() === wanted).length, value);
                if (options !== 1) return { changed: false, reason: 'option_unavailable',
                    instruction: 'No value was set. Choose exactly one enabled option label from the observation.' };
                await element.selectOption({ label: value }, { timeout: 2000 });
            } else {
                await element.fill(value, { timeout: 2000 });
            }
            const now = await element.evaluate(field => field instanceof HTMLSelectElement
                ? field.selectedOptions[0]?.text.replace(/\s+/g, ' ').trim() ?? '' : (field as HTMLInputElement).value);
            await harness.waitForStability();
            return { changed: true, value: now };
        } catch (error) {
            checkOperation();
            const message = error instanceof Error ? error.message : String(error);
            return /malformed value/i.test(message) ? { changed: false, reason: 'invalid_value',
                instruction: 'No value was set. Use the input\'s ISO format, such as yyyy-mm-dd for date, HH:MM for time, or yyyy-mm for month.' }
                : GROUNDED_INPUT_REJECTED;
        } finally { await element?.dispose().catch(() => {}); }
    }
}
