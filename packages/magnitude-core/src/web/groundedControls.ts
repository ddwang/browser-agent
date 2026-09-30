import { randomUUID } from 'node:crypto';
import type { Frame, JSHandle, Page } from 'playwright';
import { checkOperation, currentOperation, type Operation } from '@/common/operation';
import type { WebHarness } from './harness';

export const GROUNDED_CLICK_REJECTED = Object.freeze({ clicked: false, reason: 'target_unavailable',
    instruction: 'No click was submitted. Replan from the new observation; do not reuse the rejected reference.' });

export const GROUNDED_INPUT_REJECTED = Object.freeze({ changed: false, reason: 'target_unavailable',
    instruction: 'No value was set. Replan from the new observation; do not reuse the rejected reference.' });
const OPTION_UNAVAILABLE = Object.freeze({ changed: false, reason: 'option_unavailable',
    instruction: 'No value was set. Choose exactly one enabled option label from the observation.' });
const INVALID_VALUE = Object.freeze({ changed: false, reason: 'invalid_value',
    instruction: 'No value was set. Use the input\'s ISO format, such as yyyy-mm-dd for date, HH:MM for time, or yyyy-mm for month.' });
/** Results that submitted nothing; the executor stops the remaining batch after any of them. */
export const GROUNDED_REJECTIONS: ReadonlySet<unknown> = new Set([GROUNDED_CLICK_REJECTED, GROUNDED_INPUT_REJECTED, OPTION_UNAVAILABLE, INVALID_VALUE]);
const REJECTIONS = { target_unavailable: GROUNDED_INPUT_REJECTED, option_unavailable: OPTION_UNAVAILABLE, invalid_value: INVALID_VALUE };

// Single-choice native form controls whose pickers render outside the page screenshot.
const FIELDS = 'select:not([multiple]),input[type="date"],input[type="time"],input[type="datetime-local"],input[type="month"],input[type="week"]';

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
    // Read form attributes through the prototype: a control named "action" would shadow form.action.
    const formProperty = <K extends keyof HTMLFormElement>(form: HTMLFormElement, key: K) =>
        Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, key)!.get!.call(form) as HTMLFormElement[K];
    // Options a person could choose: neither the option nor its group is disabled or hidden.
    // Computed styles work while the picker is closed; layout-based visibility checks do not.
    const concealed = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return element.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    };
    const eligible = (select: HTMLSelectElement) => Array.from(select.options).filter(option => {
        const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
        return !option.disabled && !concealed(option) && !(group && (group.disabled || concealed(group)));
    });
    // inView: false checks identity and eligibility regardless of where the node has scrolled.
    function describe(node: Element, inView = true) {
        const field = node.matches(fields) ? node as HTMLSelectElement | HTMLInputElement : null;
        const submit = node instanceof HTMLInputElement && node.type === 'submit' ? node : null;
        if (!(field || submit || node instanceof HTMLAnchorElement || node instanceof HTMLButtonElement)
            || !node.isConnected || !node.checkVisibility(visibility) || node.closest('[hidden],[inert],[aria-hidden="true"]')) return null;
        // Submit buttons are listed; reset buttons only discard input.
        if (node instanceof HTMLButtonElement && node.type === 'reset') return null;
        if (node instanceof HTMLAnchorElement && !/^https?:$/.test(node.protocol)) return null;
        const box = node.getBoundingClientRect();
        // At least partly in view; actions scroll a control fully into view first.
        if (box.width <= 0 || box.height <= 0 || (inView && (box.right <= 0 || box.bottom <= 0
            || box.left >= innerWidth || box.top >= innerHeight))) return null;
        const labelledBy = node.getAttribute('aria-labelledby');
        const label = text(labelledBy
            ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
            : node.getAttribute('aria-label') || (field
                // A wrapping label also contains the field's own text, such as its option labels.
                ? Array.from(field.labels?.[0]?.childNodes ?? []).filter(child => !(child instanceof Element && child.matches('input,select,textarea,button')))
                    .map(child => child.textContent).join(' ').trim() || node.getAttribute('title') || node.getAttribute('name')
                : (submit ? submit.value : (node as HTMLElement).innerText) || node.getAttribute('title')));
        if (!label || label.length > 256) return null;
        const container = node.closest('tr,[role="row"],li,fieldset,form,dialog,[role="dialog"],section,article');
        const context = text(container?.matches('tr,[role="row"],li')
            ? (container as HTMLElement).innerText
            : container?.getAttribute('aria-label') || container?.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3')?.textContent);
        if (context.length > 256) return null;
        const enabled = !node.matches(':disabled') && !node.closest('[aria-disabled="true"]') && !(field as HTMLInputElement | null)?.readOnly;
        const role = field instanceof HTMLSelectElement ? 'select' : field ? (field as HTMLInputElement).type
            : node.getAttribute('role') || (node instanceof HTMLAnchorElement ? 'link' : 'button');
        const value = field instanceof HTMLSelectElement ? text(field.selectedOptions[0]?.label) : field ? field.value : undefined;
        const form = node instanceof HTMLButtonElement || field || submit ? (node as HTMLButtonElement).form : null;
        // Where a submit control sends its form: its own overrides, else the form's attributes.
        const submitter = submit ?? (node instanceof HTMLButtonElement && node.type === 'submit' ? node : null);
        const submission = submitter && form ? [
            submitter.hasAttribute('formaction') ? submitter.formAction : formProperty(form, 'action'),
            submitter.hasAttribute('formmethod') ? submitter.formMethod : formProperty(form, 'method'),
            submitter.hasAttribute('formtarget') ? submitter.formTarget : formProperty(form, 'target'),
            submitter.hasAttribute('formenctype') ? submitter.formEnctype : formProperty(form, 'enctype'),
            submitter.formNoValidate || formProperty(form, 'noValidate'),
        ] : null;
        const options = field instanceof HTMLSelectElement ? eligible(field).slice(0, 40).map(option => text(option.label)) : undefined;
        // Keep activation attributes and context identity local, not in diagnostics.
        const identity = JSON.stringify([label, context, role, enabled, node.getAttribute('name'),
            node.getAttribute('href'), node instanceof HTMLAnchorElement ? node.href : null,
            node.getAttribute('target'), node.getAttribute('download'), node.getAttribute('type'),
            node.getAttribute('popovertarget'), node.getAttribute('popovertargetaction'),
            node.getAttribute('commandfor'), node.getAttribute('command'),
            node.getAttribute('aria-expanded'), node.getAttribute('aria-selected'), node.getAttribute('aria-pressed'), submission]);
        return { label, context, role, enabled, value, options, identity, container, form,
            box: { x: box.x, y: box.y, width: box.width, height: box.height } };
    }
    const nodes: Element[] = [];
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT, {
        acceptNode: node => (node as Element).matches(`a[href],button,input[type="submit"],${fields}`) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    }); // Does not cross frames or shadow roots; stop collecting at the first match beyond the cap.
    while (nodes.length <= 512 && walker.nextNode()) nodes.push(walker.currentNode as Element);
    const entries: { node: Element; state: NonNullable<ReturnType<typeof describe>> }[] = [];
    const truncated = nodes.length > 512;
    if (!truncated) for (const node of nodes) {
        const state = describe(node);
        if (state) entries.push({ node, state });
    }
    // Re-check a reference against the node it was captured from, without dispatching anything.
    function current(index: number, inView = true) {
        const entry = entries[index];
        if (document !== documentAtCapture || location.href !== url || !entry) return null;
        const state = describe(entry.node, inView);
        if (!state || !state.enabled || state.container !== entry.state.container
            || state.form !== entry.state.form || state.identity !== entry.state.identity) return null;
        return { entry, state };
    }
    return {
        truncated,
        controls: entries.map(({ state }) => ({ role: state.role, label: state.label, context: state.context, enabled: state.enabled,
            ...(state.value !== undefined ? { value: state.value } : {}), ...(state.options ? { options: state.options } : {}), box: state.box })),
        // The still-current control's box in this frame, wherever it has scrolled.
        box(index: number) {
            return current(index, false)?.state.box ?? null;
        },
        // Centers the control, through enclosing frames, so content it reveals just below or above
        // is also in view. The in-view checks run afterward, before any input.
        reveal(index: number) {
            current(index, false)?.entry.node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        },
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
        // Checks a field change without making it: the reference is current, the field receives
        // input at its center, and the value is one the field accepts.
        check(index: number, kind: 'select' | 'fill', value: string) {
            const at = this.point(index);
            const node = entries[index]?.node;
            if (!at || !node?.matches(fields) || (kind === 'select') !== node instanceof HTMLSelectElement) return { ok: false as const, reason: 'target_unavailable' as const };
            if (node instanceof HTMLSelectElement) {
                const matches = eligible(node).filter(option => text(option.label) === value);
                return matches.length === 1 ? { ok: true as const, point: at, option: matches[0].index } : { ok: false as const, reason: 'option_unavailable' as const };
            }
            // A detached input of the same type sanitizes an invalid value to empty, without touching the page.
            const probe = document.createElement('input');
            probe.type = (node as HTMLInputElement).type;
            probe.value = value;
            return probe.value === value ? { ok: true as const, point: at, option: -1 } : { ok: false as const, reason: 'invalid_value' as const };
        },
        // Rechecks and changes the field in one step, through the native setter, then reports its value.
        apply(index: number, kind: 'select' | 'fill', value: string) {
            const checked = this.check(index, kind, value);
            if (!checked.ok) return checked;
            const node = entries[index].node;
            if (node instanceof HTMLSelectElement) {
                Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')!.set!.call(node, checked.option);
            } else {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
            }
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true as const, value: node instanceof HTMLSelectElement ? text(node.selectedOptions[0]?.label) : (node as HTMLInputElement).value };
        },
    };
}

type Capture = ReturnType<typeof captureControls>;
type Rect = { x: number; y: number; width: number; height: number };
type Entry = { frame: Frame; handle: JSHandle<Capture>; index: number; role: string; ambiguous?: boolean };
// Large enough to hold any frame, so offsets are computed without clipping.
export const UNCLIPPED = { x: -1e9, y: -1e9, width: 2e9, height: 2e9 };

// Where a frame's content box sits in main-viewport coordinates, clipped to what is visible.
export async function frameArea(frame: Frame, viewport: Rect): Promise<Rect & { dx: number; dy: number } | null> {
    const parent = frame.parentFrame();
    if (!parent) return { ...viewport, dx: 0, dy: 0 };
    const outer = await frameArea(parent, viewport);
    const owner = outer && await frame.frameElement().catch(() => null);
    if (!outer || !owner) return null;
    try {
        const box = await owner.evaluate(node => {
            const element = node as HTMLElement;
            // An iframe that is invisible, hidden, or inert hides its controls, as it would a control of its own.
            if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
                || element.closest('[hidden],[inert],[aria-hidden="true"]')) return null;
            // A transformed or zoomed iframe doesn't map its coordinates by offset; don't ground its controls.
            for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor);
                if (style.transform !== 'none' || style.scale !== 'none' || style.rotate !== 'none'
                    || style.translate !== 'none' || (style.zoom && style.zoom !== '1')) return null;
            }
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            const left = rect.left + element.clientLeft + parseFloat(style.paddingLeft);
            const top = rect.top + element.clientTop + parseFloat(style.paddingTop);
            return { left, top, width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                height: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) };
        });
        if (!box) return null;
        const dx = outer.dx + box.left, dy = outer.dy + box.top;
        const x = Math.max(outer.x, dx), y = Math.max(outer.y, dy);
        const width = Math.min(outer.x + outer.width, dx + box.width) - x, height = Math.min(outer.y + outer.height, dy + box.height) - y;
        return width > 0 && height > 0 ? { x, y, width, height, dx, dy } : null;
    } finally { await owner.dispose(); }
}

// Each ancestor frame must show its iframe at the point; another element covering it would take the click.
export async function frameVisibleAt(frame: Frame, x: number, y: number): Promise<boolean> {
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

type Snapshot = { handles: JSHandle<Capture>[]; entries: Entry[]; page: Page; operation: Operation; prefix: string };

/** One disposable snapshot per frame, owned by the operation that observed it. No DOM attributes are injected. */
export class GroundedControls {
    // Every snapshot observed since the plan began; the latest is last. Refs stay usable for the whole batch.
    private snapshots: Snapshot[] = [];

    async clear(): Promise<void> {
        await this.release(this.snapshots.splice(0));
    }

    /** Called before planning: the planner sees only the latest snapshot. */
    async keepLatest(): Promise<void> {
        await this.release(this.snapshots.splice(0, this.snapshots.length - 1));
    }

    private async release(snapshots: Snapshot[]) {
        await Promise.all(snapshots.flatMap(snapshot => snapshot.handles.map(handle => handle.dispose().catch(() => {}))));
    }

    async observe(page: Page) {
        checkOperation();
        const scope = 'viewport-links-buttons-and-native-fields';
        const operation = currentOperation();
        // Refs belong to one operation; keep earlier snapshots of this one until the next plan.
        await this.release(this.snapshots.filter(snapshot => snapshot.operation !== operation));
        this.snapshots = this.snapshots.filter(snapshot => snapshot.operation === operation);
        if (!operation) return { controls: [], truncated: false, scope };
        const size = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const viewport = { x: 0, y: 0, ...size };
        const handles: JSHandle<Capture>[] = [], entries: Entry[] = [];
        type Listed = { role: string; label: string; context: string; enabled: boolean; value?: string; options?: string[] };
        const candidates: { frame: Frame; handle: JSHandle<Capture>; index: number; control: Listed }[] = [];
        let truncated = false;
        const prefix = randomUUID();
        this.snapshots.push({ handles, entries, page, operation, prefix });
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
                // Only controls at least partly inside the frame's visible area of the main viewport.
                if (x + box.width <= area.x || y + box.height <= area.y || x >= area.x + area.width || y >= area.y + area.height) return;
                candidates.push({ frame, handle, index, control });
            });
        }
        checkOperation();
        // Count descriptions before limiting the list, so truncation can't hide a duplicate.
        const key = (control: Listed) => JSON.stringify([control.role, control.label, control.context]);
        const counts = new Map<string, number>();
        for (const { control } of candidates) counts.set(key(control), (counts.get(key(control)) ?? 0) + 1);
        const listed: (Listed & { ambiguous: boolean })[] = [];
        let bytes = 0;
        for (const { frame, handle, index, control } of candidates) {
            bytes += new TextEncoder().encode(JSON.stringify(control)).length + 100; // Reserve reference/JSON overhead.
            if (listed.length === 64 || bytes > 16_000) { truncated = true; break; }
            const ambiguous = counts.get(key(control))! > 1;
            listed.push({ ...control, ambiguous });
            entries.push({ frame, handle, index, role: control.role, ambiguous });
        }
        return { scope, truncated, controls: listed.map((control, index) => ({ ref: `${prefix}:${index}`, ...control })) };
    }

    private entry(ref: string) {
        const index = Number(ref.slice(ref.lastIndexOf(':') + 1));
        const snapshot = this.snapshots.find(snapshot => ref === `${snapshot.prefix}:${index}`);
        if (!snapshot || snapshot.operation !== currentOperation() || !snapshot.entries[index] || snapshot.entries[index].ambiguous) return null;
        return { snapshot, entry: snapshot.entries[index] };
    }

    // Scrolling changes no value, so a failure here rejects the ref without input.
    // Scrolls only a control that isn't fully visible, including one an earlier batch action scrolled away.
    private async reveal(harness: WebHarness, snapshot: Snapshot, entry: Entry): Promise<boolean> {
        checkOperation();
        if (!this.snapshots.includes(snapshot) || harness.page !== snapshot.page) return false;
        try {
            const size = harness.page.viewportSize() ?? await harness.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
            const [area, box] = await Promise.all([frameArea(entry.frame, { x: 0, y: 0, ...size }),
                entry.handle.evaluate((state, index) => state.box(index), entry.index)]);
            const visible = area && box && area.dx + box.x >= area.x && area.dy + box.y >= area.y
                && area.dx + box.x + box.width <= area.x + area.width && area.dy + box.y + box.height <= area.y + area.height;
            if (!visible) await entry.handle.evaluate((state, index) => state.reveal(index), entry.index);
        } catch { checkOperation(); return false; }
        checkOperation();
        return true;
    }

    async click(harness: WebHarness, ref: string): Promise<boolean> {
        const found = this.entry(ref);
        if (!found) return false;
        const { snapshot, entry } = found;
        if (!await this.reveal(harness, snapshot, entry)) return false;
        return harness.clickGrounded(async () => {
            checkOperation();
            if (!this.snapshots.includes(snapshot) || harness.page !== snapshot.page) return null;
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
    async setValue(harness: WebHarness, ref: string, value: string, kind: 'select' | 'fill'): Promise<{ changed: true; value: string } | (typeof REJECTIONS)[keyof typeof REJECTIONS]> {
        const found = this.entry(ref);
        if (!found || (kind === 'select') !== (found.entry.role === 'select')) return GROUNDED_INPUT_REJECTED;
        const { snapshot, entry } = found;
        const args = { index: entry.index, kind, value };
        if (!await this.reveal(harness, snapshot, entry)) return GROUNDED_INPUT_REJECTED;
        try {
            // Nothing has changed yet, so any failure here is a rejection.
            checkOperation();
            if (!this.snapshots.includes(snapshot) || harness.page !== snapshot.page) return GROUNDED_INPUT_REJECTED;
            const area = await frameArea(entry.frame, UNCLIPPED);
            const checked = area && await entry.handle.evaluate((state, { index, kind, value }) => state.check(index, kind, value), args);
            if (!area || !checked) return GROUNDED_INPUT_REJECTED;
            if (!checked.ok) return REJECTIONS[checked.reason];
            if (!await frameVisibleAt(entry.frame, area.dx + checked.point.x, area.dy + checked.point.y)) return GROUNDED_INPUT_REJECTED;
        } catch { checkOperation(); return GROUNDED_INPUT_REJECTED; }
        checkOperation();
        if (!this.snapshots.includes(snapshot)) return GROUNDED_INPUT_REJECTED;
        // The field may change from here, so failures propagate as unknown outcomes rather than rejections.
        const applied = await entry.handle.evaluate((state, { index, kind, value }) => state.apply(index, kind, value), args);
        if (!applied.ok) return REJECTIONS[applied.reason];
        await harness.waitForStability();
        return { changed: true, value: applied.value };
    }
}
