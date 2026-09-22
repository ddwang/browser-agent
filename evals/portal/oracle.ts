import type { Page } from 'patchright';
import type { Label } from './protocol';

export interface Oracle {
    label: Exclude<Label, 'unclear'> | null;
    url: string;
    resultId: string | null;
    evidence: string;
}

// Evaluator-only selectors for the synthetic fixtures, never model inputs or SDK behavior.
// Bracket the existing screenshot with two reads. Disagreement remains unlabelled.
export async function readOracle(page: Page): Promise<Oracle> {
    return page.evaluate(() => {
        let doc = document;
        let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        if (document.querySelector('dialog[open]')) return { label: null, url: location.href, resultId: null, evidence: 'dialog obscures page' };
        const frame = document.querySelector<HTMLIFrameElement>('#datatilesframe');
        const frameBox = frame?.getBoundingClientRect();
        if (frame) {
            const left = frameBox!.left + frame.clientLeft;
            const top = frameBox!.top + frame.clientTop;
            clip = { left: Math.max(0, -left), top: Math.max(0, -top), right: Math.min(frame.clientWidth, innerWidth - left), bottom: Math.min(frame.clientHeight, innerHeight - top) };
            if (!frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !frame.contentDocument || clip.right <= clip.left || clip.bottom <= clip.top) {
                return { label: null, url: location.href, resultId: null, evidence: 'clinical area not visible' };
            }
            doc = frame.contentDocument;
        }
        const visible = (node: Element) => {
            const box = node.getBoundingClientRect();
            const x = (Math.max(box.left, clip.left) + Math.min(box.right, clip.right)) / 2;
            const y = (Math.max(box.top, clip.top) + Math.min(box.bottom, clip.bottom)) / 2;
            const hit = doc.elementFromPoint(x, y);
            return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && box.width > 0 && box.height > 0
                && box.right > clip.left && box.left < clip.right && box.bottom > clip.top && box.top < clip.bottom
                && !!hit && node.contains(hit)
                && (!frame || document.elementFromPoint(x + frameBox!.left + frame.clientLeft, y + frameBox!.top + frame.clientTop) === frame);
        };
        const find = (selector: string, text?: RegExp) => [...doc.querySelectorAll(selector)]
            .find(node => visible(node) && (!text || text.test(node.textContent ?? '')));
        const url = doc.location.href;
        const resultId = new URL(url).searchParams.get('id');
        const result = (label: Exclude<Label, 'unclear'> | null, evidence: string) => ({ label, url, resultId, evidence });
        if (find('input[name="code"]')) return result('verification', 'visible code field');
        if (find('input[type="password"]')) return result('login', 'visible password field');
        if (find('[data-action="retry"]', /Try again/i)) return result('load_error', 'visible retry control');
        if (find('[role="status"],.loading', /Loading (your information|MySimChart|your synthetic portal)/i)) return result('loading', 'visible loading indicator');
        if (resultId && (find('.lab-component') || find('th', /^Component$/))) return result('result_detail', 'visible result components');
        if (find('.result-row')) return result('results', 'visible result row');
        if (find('h1', /^Test Results$/i) && find('[role="status"],.empty-state,.empty', /No results found|no test results available|No results match|no results to display/i)) {
            return result('empty_results', 'explicit empty-results message');
        }
        if (find('h1', /Welcome|Home/i)) return result('other', 'visible dashboard heading');
        return result(null, 'no supported visible oracle evidence');
    });
}

export function stableOracle(before: Oracle, after: Oracle): Oracle {
    return JSON.stringify(before) === JSON.stringify(after) ? after : { ...after, label: null, evidence: 'state changed across screenshot' };
}
