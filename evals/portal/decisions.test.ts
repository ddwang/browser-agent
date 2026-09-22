import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDecisions, decisionShape } from './analyze-decisions';
import { tracePlanner, type PlannerDecision } from './decisions';
import { selectionQuestion } from './selection';
import { parseChoice } from './protocol';
import { GroundedControls } from '../../packages/magnitude-core/src/web/groundedControls';
import { Operation } from '../../packages/magnitude-core/src/common/operation';
import type { BrowserAgent } from '../../packages/magnitude-core/src/agent/browserAgent';

const row = (actions: string[], notes = 0): PlannerDecision => ({ index: 0, phase: 'task', task: 'Synthetic task',
    context: { observationContent: [], connectorInstructions: [] }, elapsedMs: 100,
    response: { reasoning: 'Fixture', actions: actions.map(variant => ({ variant })),
        memory_updates: Array.from({ length: notes }, () => ({ key: 'fixture', text: 'Observed value', sources: [1],
            operation: 'add' as const, expected_text: null })) } });

test('decision profiling separates one-click shapes from notes, forms, completion, and errors', () => {
    expect(decisionShape(row(['mouse:click']))).toBe('one_click_without_notes');
    expect(decisionShape(row(['browser:click'], 1))).toBe('one_click_with_notes');
    expect(decisionShape(row(['mouse:click', 'keyboard:type']))).toBe('keyboard_or_form_batch');
    expect(decisionShape(row(['task:done']))).toBe('completion');
    expect(decisionShape(row(['portal:report']))).toBe('completion');
    expect(decisionShape(row(['wait']))).toBe('wait_only');
    expect(decisionShape(row(['mouse:click', 'mouse:click']))).toBe('other_batch');
    expect(decisionShape({ ...row(['mouse:click']), error: 'timeout' })).toBe('failed_or_unfinished');
});

test('trace reader preserves unfinished calls and failures and rejects duplicate terminal events', () => {
    const directory = mkdtempSync(join(tmpdir(), 'decision-audit-'));
    const path = join(directory, 'trace.jsonl');
    const started = { event: 'started', ...row([]), response: undefined, elapsedMs: 0 };
    try {
        writeFileSync(path, JSON.stringify(started) + '\n');
        expect(readDecisions(path)[0].error).toBe('unfinished');
        const finished = { event: 'finished', index: 0, elapsedMs: 42, error: 'TimeoutError' };
        writeFileSync(path, [started, finished].map(value => JSON.stringify(value)).join('\n'));
        expect(readDecisions(path)[0]).toMatchObject({ elapsedMs: 42, error: 'TimeoutError', task: 'Synthetic task' });
        writeFileSync(path, [started, finished, finished].map(value => JSON.stringify(value)).join('\n'));
        expect(() => readDecisions(path)).toThrow('ordering');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('selection receives only prior inputs, excludes disabled or ambiguous refs, and delegates incomplete observations', () => {
    const input = { ...row(['mouse:click']), outcome: 'FUTURE_OUTCOME', controls: { truncated: false,
        scope: 'viewport-native-links-and-buttons', controls: [
            { ref: 'ref-1', role: 'link', label: 'One', context: 'Section', enabled: true, ambiguous: false },
            { ref: 'ref-2', role: 'button', label: 'Two', context: '', enabled: true, ambiguous: false },
            { ref: 'ref-3', role: 'button', label: 'Disabled', context: '', enabled: false, ambiguous: false },
            { ref: 'ref-4', role: 'button', label: 'Duplicate', context: '', enabled: true, ambiguous: true },
        ] } };
    input.response!.reasoning = 'FUTURE_REASONING';
    const normal = selectionQuestion(input), reversed = selectionQuestion(input, true);
    expect(normal.candidates?.c0.ref).toBe('ref-1');
    expect(reversed.candidates?.c0.ref).toBe('ref-2');
    const payload = JSON.stringify(normal.request);
    for (const secret of ['FUTURE_OUTCOME', 'FUTURE_REASONING', 'ref-1', 'ref-3', 'ref-4']) expect(payload).not.toContain(secret);
    expect(Object.keys(normal.request!.questions.next_action.criteria)).toEqual(['c0', 'c1', 'delegate']);
    expect(selectionQuestion({ ...input, controls: { ...input.controls, truncated: true } }).fallback).toBe('controls_unavailable');
    expect(selectionQuestion({ ...input, task: 'x'.repeat(64_000) }).fallback).toBe('context_too_large');
});

test('selection parser requires exact current choices and a valid probability distribution', () => {
    const response = { model: 'fixture', answers: { next_action: { type: 'choice', choice: 'c0',
        probabilities: { c0: 0.9, delegate: 0.1 }, confidence: 0.9 } } };
    expect(parseChoice(response, 'next_action', ['c0', 'delegate']).choice).toBe('c0');
    expect(() => parseChoice(response, 'next_action', ['c1', 'delegate'])).toThrow();
    expect(() => parseChoice(response, 'missing', ['c0', 'delegate'])).toThrow();
    response.answers.next_action.choice = 'delegate';
    expect(() => parseChoice(response, 'next_action', ['c0', 'delegate'])).toThrow();
});

test('cancellation during sidecar observation never starts the planner and remains in the trace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'decision-cancel-'));
    const controller = new AbortController();
    const operation = new Operation({}, { signal: controller.signal }, 'act');
    let calls = 0;
    const agent = { page: {}, models: { partialAct: async () => { calls++; return row(['task:done']).response!; } } } as unknown as BrowserAgent;
    const observe = spyOn(GroundedControls.prototype, 'observe').mockImplementation(async () => {
        controller.abort(); throw new Error('closed');
    });
    try {
        tracePlanner(agent, directory, () => '0000.png', () => 'task', () => {});
        await expect(operation.run(() => agent.models.partialAct({ observationContent: [], connectorInstructions: [] }, 'Task', [], []))).rejects.toThrow();
        expect(calls).toBe(0);
        const saved = readDecisions(join(directory, 'decisions.jsonl'))[0];
        expect(saved.error).toBe('OperationCancelledError');
        expect(saved.controlsError).toBe('Error');
        expect(readFileSync(join(directory, 'decisions.jsonl'), 'utf8')).not.toContain('closed');
    } finally { observe.mockRestore(); operation.finish(); rmSync(directory, { recursive: true, force: true }); }
});
