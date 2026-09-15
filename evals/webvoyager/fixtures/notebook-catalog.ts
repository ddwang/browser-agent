import { randomInt, randomUUID } from 'node:crypto';
import type { NotebookRecord } from '../notebook-metrics';

export interface NotebookCatalog {
    root: string;
    minimumUnits: number;
    groups: { path: string; start: number; count: number }[];
}

export function matchesCatalogRule(answer: { entries?: { qualifies?: unknown }[]; qualifiedTotalUnits?: unknown } | undefined,
    records: NotebookRecord[], catalog: NotebookCatalog): boolean {
    return Array.isArray(answer?.entries) && answer.entries.length === records.length
        && records.every((record, i) => answer.entries![i]?.qualifies === (record.units >= catalog.minimumUnits))
        && answer.qualifiedTotalUnits === records.filter(record => record.units >= catalog.minimumUnits).reduce((sum, record) => sum + record.units, 0);
}

// A different workflow from the serial collection: root rule -> group directory
// -> record -> group directory. The rule is not repeated on the record pages.
export function makeCatalog(records: NotebookRecord[]): NotebookCatalog {
    const size = randomInt(4, 7);
    return { root: `/${randomUUID()}`, minimumUnits: randomInt(250, 651),
        groups: Array.from({ length: Math.ceil(records.length / size) }, (_, index) => ({
            path: `/${randomUUID()}`, start: index * size, count: Math.min(size, records.length - index * size),
        })),
    };
}

export function catalogPage(catalog: NotebookCatalog, records: NotebookRecord[], path: string, end: string): string | undefined {
    if (path === catalog.root) return `<h1>Stock audit directory</h1>
        <p>Qualification rule: an entry qualifies when its units are at least ${catalog.minimumUnits}.</p>
        <p>Audit groups in the listed order, and entries in each group's listed order. Read Final notices after the audit.</p>
        <ol>${catalog.groups.map((group, i) => `<li><a href="${group.path}">Group ${i + 1}</a></li>`).join('')}</ol>
        <a href="${end}">Final notices</a>`;
    const groupIndex = catalog.groups.findIndex(group => group.path === path);
    if (groupIndex >= 0) {
        const group = catalog.groups[groupIndex];
        return `<h1>Group ${groupIndex + 1} directory</h1><p>Directory only. Links are not additional stock records.</p>
            <ol>${records.slice(group.start, group.start + group.count).map(record => `<li><a href="${record.path}">${record.label}</a></li>`).join('')}</ol>
            <p><a href="${catalog.groups[groupIndex + 1]?.path ?? end}">${groupIndex + 1 < catalog.groups.length ? 'Next group' : 'Final notices'}</a></p>
            <a href="${catalog.root}">Audit overview</a>`;
    }
    const index = records.findIndex(record => record.path === path);
    if (index < 0) return;
    const record = records[index];
    const group = catalog.groups.find(group => index >= group.start && index < group.start + group.count)!;
    return `<h1>Stock record</h1><table style="border-spacing:16px;text-align:left">
        <tr><th>Confirmation code</th><td>${record.code}</td></tr>
        <tr><th>Label</th><td>${record.label}</td></tr>
        <tr><th>Units</th><td>${record.units}</td></tr></table>
        <a href="${group.path}">Return to group directory</a>`;
}
