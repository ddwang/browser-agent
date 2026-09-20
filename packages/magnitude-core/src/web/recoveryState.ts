/** Runs in the page. Return bounded barrier text and a digest, never the page text. */
export function collectRecoveryState(includeText: boolean): { headings: string[]; fingerprint: string | null } {
    const maxNodes = 10_000;
    const maxCharacters = 256 * 1024;
    const headings: string[] = [];
    const headingOwners = new WeakMap<Node, number>();
    let visited = 0;
    let characters = 0;
    let complete = true;
    let hash1 = 0x811c9dc5;
    let hash2 = 0x9e3779b9;
    const hash = (value: string, normalize = false) => {
        if (!complete) return;
        characters += value.length;
        if (characters > maxCharacters) { complete = false; return; }
        if (normalize) value = value.replace(/\s+/g, ' ');
        // Two rolling hashes for a heuristic fingerprint, not a security boundary.
        for (let i = 0; i <= value.length; i++) {
            const code = i === value.length ? 0 : value.charCodeAt(i);
            hash1 = Math.imul(hash1 ^ code, 16777619);
            hash2 = Math.imul(hash2 ^ code, 3266489909);
        }
    };
    const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
            && rect.right > 0 && rect.left < innerWidth && getComputedStyle(element).visibility === 'visible';
    };
    hash(`${scrollX},${scrollY}`);
    const active = document.activeElement;
    let elementIndex = 0;
    // Count every visited node, including rejected/hidden nodes. A filtered walk
    // must not scan an unbounded number of nodes inside a single nextNode().
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL, {
        acceptNode(node) {
            if (++visited > maxNodes) return NodeFilter.FILTER_ACCEPT;
            if (node instanceof Element && (node.hasAttribute('data-magnitude-visual')
                || (!['HEAD', 'TITLE'].includes(node.tagName) && getComputedStyle(node).display === 'none'))) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    while (walker.nextNode()) {
        if (visited > maxNodes) { complete = false; break; }
        const node = walker.currentNode;
        let heading = node.parentNode ? headingOwners.get(node.parentNode) : undefined;
        if (node instanceof Element) {
            elementIndex++;
            if (headings.length < 32 && (node.tagName === 'TITLE'
                || (node.matches('h1, h2, [role="dialog"]') && visible(node)))) {
                heading = headings.push('') - 1;
            }
            // Read layout only for scrollers, not every element's bounding box.
            if (complete && (node.scrollLeft || node.scrollTop) && visible(node)) {
                hash(`scroll:${elementIndex},${node.scrollLeft},${node.scrollTop}`);
            }
            if (complete && node === active) {
                if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
                    hash(`input:${elementIndex}`);
                    hash(node.value);
                    if (node instanceof HTMLInputElement) hash(String(node.checked));
                } else if (node instanceof HTMLSelectElement) {
                    hash(`select:${elementIndex}`);
                    const selected = node.selectedOptions;
                    if (selected.length > maxNodes) complete = false;
                    else for (let i = 0; i < selected.length && complete; i++) hash(selected[i].value);
                }
            }
        } else if (node instanceof Text && node.parentElement
            && (node.parentElement.tagName === 'TITLE' || getComputedStyle(node.parentElement).visibility === 'visible')) {
            if (heading !== undefined) {
                const remaining = 500 - headings[heading].length;
                if (remaining > 0) headings[heading] += node.substringData(0, remaining);
            }
            if (includeText && complete) {
                if (node.length > maxCharacters - characters) complete = false;
                else for (let offset = 0; offset < node.length; offset += 4096) {
                    hash(node.substringData(offset, 4096), true);
                }
            }
        }
        if (heading !== undefined) headingOwners.set(node, heading);
    }
    // Without no-progress detection, retain enough state to distinguish changing
    // sign-in barriers without reading the rest of the document's text.
    if (!includeText) for (const heading of headings) hash(heading);
    return { headings, fingerprint: complete ? `${hash1 >>> 0}:${hash2 >>> 0}` : null };
}
