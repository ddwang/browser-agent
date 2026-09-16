import type { TaskResult } from './results';

export interface NotebookRecord { path: string; label: string; units: number; code: string }

// Diagnostic only: exact source-linked token coverage, not a semantic note judge.
// Historical/corrected values can coexist legitimately; final answers are checked separately.
export function notebookCoverage(run: TaskResult, records: NotebookRecord[]) {
    const observations = run.memory?.observations ?? [];
    const urlAt = (index: number): string | undefined => (observations[index]?.data as any)?.url?.content;
    const matches = (url: string | undefined, path: string) => {
        try { return url !== undefined && new URL(url).pathname === path; } catch { return false; }
    };
    const linked = (sources: number[], record: NotebookRecord) => sources.some(index => matches(urlAt(index), record.path));
    const contains = (text: string, record: NotebookRecord) => text.includes(record.label) && text.includes(record.code)
        && new RegExp(`(?<![0-9])${record.units}(?![0-9])`).test(text);
    const writes = observations.flatMap((observation, index) => {
        if (observation.source !== 'action:taken:memory:note') return [];
        const note = JSON.parse((observation.data as any).content);
        const result = observations[index + 1];
        return result?.source === 'action:result:memory:note' && (result.data as any)?.saved?.content === note.key
            ? [{ index, ...note }] : [];
    });
    return records.map(record => {
        const firstSeen = observations.findIndex((_, index) => matches(urlAt(index), record.path));
        const departure = firstSeen < 0 ? -1 : observations.findIndex((_, index) => index > firstSeen
            && urlAt(index) !== undefined && !matches(urlAt(index), record.path));
        const text = writes.filter(note => note.index > firstSeen && note.index < departure && linked(note.sources, record)).map(note => note.text).join('\n');
        const retained = (run.memory?.notes ?? []).filter(note => linked(note.sources, record)).map(note => note.text).join('\n');
        return { label: record.label, seen: firstSeen >= 0, departed: departure >= 0,
            capturedBeforeFirstDeparture: firstSeen >= 0 && departure >= 0 && contains(text, record),
            exactTokensInFinalNotes: contains(retained, record) };
    });
}
