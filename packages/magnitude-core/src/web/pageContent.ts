import { randomUUID } from 'node:crypto';
import type { Frame, JSHandle, Page } from 'playwright';
import { checkOperation } from '@/common/operation';

export async function getVisiblePageContent(page: Page): Promise<string> {
    return readFrame(page.mainFrame());
}

async function readFrame(frame: Frame): Promise<string> {
    checkOperation();
    const marker = randomUUID();
    const snapshot = await frame.evaluateHandle((marker) => {
        const documentCopy = document.implementation.createHTMLDocument();
        const frames: Element[] = [];
        const visibility = { checkOpacity: true, checkVisibility: true };

        function copy(source: Element): Node | null {
            if (['script', 'style', 'template', 'noscript'].includes(source.localName)) return null;
            const style = getComputedStyle(source);
            if (style.display === 'none' || style.opacity === '0' || style.contentVisibility === 'hidden') return null;

            const visible = style.visibility === 'visible' && (
                style.display === 'contents' || source.checkVisibility(visibility) ||
                (['option', 'optgroup'].includes(source.localName) && source.closest('select')?.checkVisibility(visibility))
            );
            if (source instanceof HTMLIFrameElement || source instanceof HTMLFrameElement) {
                if (!visible) return null;
                frames.push(source);
                return documentCopy.createComment(`${marker}:${frames.length - 1}`);
            }

            const target = documentCopy.importNode(source, false);
            if (source instanceof HTMLInputElement) {
                if (source.type === 'password') target.removeAttribute('value');
                else target.setAttribute('value', source.value);
                target.toggleAttribute('checked', source.checked);
            }
            if (source instanceof HTMLOptionElement) target.toggleAttribute('selected', source.selected);
            if (source instanceof HTMLTextAreaElement) {
                target.textContent = visible ? source.value : '';
                return visible ? target : null;
            }
            const summary = source instanceof HTMLDetailsElement && !source.open ? source.querySelector('summary') : null;
            for (const child of source.childNodes) {
                if (source instanceof HTMLDetailsElement && !source.open && child !== summary) continue;
                if (child instanceof Element) {
                    const copied = copy(child);
                    if (copied) target.appendChild(copied);
                } else if (visible && child.nodeType === Node.TEXT_NODE) {
                    target.appendChild(documentCopy.importNode(child, false));
                }
            }
            return visible || target.hasChildNodes() ? target : null;
        }

        const body = document.body && copy(document.body);
        return { html: body instanceof Element ? body.innerHTML : '', frames };
    }, marker);
    const handles: JSHandle[] = [snapshot];
    try {
        let html = await snapshot.evaluate(({ html }) => html);
        const frames = await snapshot.getProperty('frames');
        handles.push(frames);
        const entries = await frames.getProperties();
        handles.push(...entries.values());
        for (const [index, handle] of entries) {
            checkOperation();
            const child = await handle.asElement()?.contentFrame();
            const content = child ? await readFrame(child) : '';
            html = html.replace(`<!--${marker}:${index}-->`, () => `<div>${content}</div>`);
        }
        checkOperation();
        return html;
    } finally {
        await Promise.all(handles.map(handle => handle.dispose()));
    }
}
