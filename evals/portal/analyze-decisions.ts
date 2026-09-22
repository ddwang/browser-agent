import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlannerDecision } from './decisions';

export function readDecisions(path: string): PlannerDecision[] {
    const rows = new Map<number, PlannerDecision>();
    for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
        const { event, ...row } = JSON.parse(line);
        if (!Number.isSafeInteger(row.index) || row.index < 0) throw new Error('Invalid decision index');
        if (event === 'started' && !rows.has(row.index)) rows.set(row.index, { ...row, error: 'unfinished' });
        else if (event === 'finished' && rows.get(row.index)?.error === 'unfinished') {
            rows.set(row.index, { ...rows.get(row.index)!, ...row, error: row.error });
        } else throw new Error('Invalid decision event ordering');
    }
    return [...rows.values()];
}

/** Output shape is an opportunity screen, not proof that a click is safe or replaceable. */
export function decisionShape(row: PlannerDecision) {
    if (row.error || !row.response) return 'failed_or_unfinished';
    const actions = row.response.actions;
    if (actions.length === 1 && ['mouse:click', 'browser:click'].includes(actions[0].variant)) {
        return row.response.memory_updates.length ? 'one_click_with_notes' : 'one_click_without_notes';
    }
    if (actions.every(action => ['task:done', 'portal:report'].includes(action.variant))) return 'completion';
    if (actions.every(action => action.variant === 'wait')) return 'wait_only';
    if (actions.some(action => action.variant.startsWith('keyboard:'))) return 'keyboard_or_form_batch';
    return 'other_batch';
}

export function profileDecisions(root: string) {
    const decisions: { suite: string; caseId: string; decision: PlannerDecision }[] = [];
    const episodes: { suite: string; caseId: string; passed: boolean; elapsedMs: number; expectedCalls: number;
        capturedCalls: number; traceOverheadMs: number }[] = [];
    for (const suite of ['retrieval', 'writes']) {
        const manifest = JSON.parse(readFileSync(join(root, suite, 'manifest.json'), 'utf8'));
        if (manifest.synthetic !== true || manifest.portal !== 'ucsd' || !manifest.traceDecisions) throw new Error('Expected traced UCSD development capture');
        for (const caseId of manifest.episodes as string[]) {
            if (!/^[a-z-]+$/.test(caseId)) throw new Error('Invalid episode directory');
            const directory = join(root, suite, caseId);
            const episode = JSON.parse(readFileSync(join(directory, 'episode.json'), 'utf8'));
            const path = join(directory, 'decisions.jsonl');
            const rows = existsSync(path) ? readDecisions(path) : [];
            decisions.push(...rows.map(decision => ({ suite, caseId, decision })));
            episodes.push({ suite, caseId, passed: episode.passed, elapsedMs: episode.elapsedMs,
                expectedCalls: episode.plannerCalls, capturedCalls: rows.length, traceOverheadMs: episode.decisionTraceOverheadMs ?? 0 });
        }
    }
    const groups: Record<string, { calls: number; elapsedMs: number }> = {};
    for (const { decision } of decisions) {
        const key = decisionShape(decision);
        const group = groups[key] ??= { calls: 0, elapsedMs: 0 };
        group.calls++; group.elapsedMs += decision.elapsedMs;
    }
    return { episodes, groups, decisions };
}

if (import.meta.main) {
    const { episodes, groups } = profileDecisions(process.argv[2]);
    console.log(JSON.stringify({ episodes, groups }, null, 2));
}
