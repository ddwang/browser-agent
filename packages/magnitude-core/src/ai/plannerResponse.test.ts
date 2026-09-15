import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createAction, type ActionDefinition } from '@/actions';
import { parsePlannerResponse, PlannerResponseError } from './plannerResponse';

const vocabulary = [createAction({ name: 'click', schema: z.object({ x: z.number() }), resolver: async () => {} })];
const plan = { reasoning: 'Click the observed button.', memory_updates: [], actions: [{ variant: 'click', x: 12 }] };

test('accepts exactly one JSON plan, optionally in a single JSON fence', () => {
    expect(parsePlannerResponse(JSON.stringify(plan), vocabulary)).toEqual(plan);
    expect(parsePlannerResponse(['', '```json', JSON.stringify(plan), '```', ''].join('\n'), vocabulary)).toEqual(plan);
});

for (const raw of [
    null, '', '<function_calls><invoke name="web_action">...</invoke></function_calls>',
    `Here is the plan: ${JSON.stringify(plan)}`, `${JSON.stringify(plan)}\nNow I see a new page.`,
    `${JSON.stringify(plan)}\n${JSON.stringify(plan)}`, JSON.stringify(plan).slice(0, -2),
    JSON.stringify([plan]), JSON.stringify({ ...plan, actions: [] }),
    JSON.stringify({ ...plan, reasoning: '' }), JSON.stringify({ actions: plan.actions }),
    JSON.stringify({ ...plan, observations: 'Invented results' }),
    JSON.stringify({ ...plan, actions: [{ variant: 'unknown', x: 12 }] }),
    JSON.stringify({ ...plan, actions: [{ variant: 'click', x: '12' }] }),
    JSON.stringify({ ...plan, actions: [{ variant: 'click' }] }),
    JSON.stringify({ ...plan, actions: [...plan.actions, { variant: 'click', x: 'invalid' }] }),
]) test(`rejects invalid planner output: ${String(raw).slice(0, 75)}`, () => {
    expect(() => parsePlannerResponse(raw, vocabulary)).toThrow(PlannerResponseError);
});

test('validates primitive action inputs without transforming them twice', () => {
    const primitive = createAction({ name: 'say', schema: z.string().transform(text => `${text}!`), resolver: async () => {} });
    const response = { reasoning: 'Answer.', memory_updates: [], actions: [{ variant: 'say', input: 'hello' }] };
    expect(parsePlannerResponse(JSON.stringify(response), [primitive])).toEqual(response);
});

test('requires a bounded memory review and validates every update before accepting actions', () => {
    const note = { key: 'record', text: 'Observed value: 731.', sources: [0], operation: 'add' as const, expected_text: null };
    const valid = { ...plan, memory_updates: [note] };
    expect(parsePlannerResponse(JSON.stringify(valid), vocabulary)).toEqual(valid);
    const correction = { ...valid, memory_updates: [{ ...note, operation: 'correct' as const, expected_text: note.text, text: 'Corrected value: 914.' }] };
    expect(parsePlannerResponse(JSON.stringify(correction), vocabulary)).toEqual(correction);
    const { memory_updates, ...missing } = valid;
    for (const invalid of [missing, ...[null, {}, [null], [{ ...note, sources: [] }],
        [{ ...note, sources: [-1] }], [{ ...note, sources: ['0'] }], [{ ...note, sources: [0.5] }],
        [{ ...note, text: '' }], [{ ...note, text: 'a'.repeat(2001) }], [{ ...note, key: 'a'.repeat(81) }],
        [{ ...note, fabricated: true }], [{ ...note, operation: 'replace' }], [{ ...note, operation: undefined }],
        [{ ...note, expected_text: undefined }], [{ ...note, expected_text: '' }], [{ ...note, expected_text: 'a'.repeat(2001) }],
        Array(33).fill(note), [note, { ...note, sources: [] }],
    ].map(memory_updates => ({ ...plan, memory_updates }))]) {
        expect(() => parsePlannerResponse(JSON.stringify(invalid), vocabulary)).toThrow(PlannerResponseError);
    }
});

function rejection(value: unknown, actions: ActionDefinition<any>[] = vocabulary): PlannerResponseError {
    try { parsePlannerResponse(JSON.stringify(value), actions); }
    catch (error) {
        expect(error).toBeInstanceOf(PlannerResponseError);
        return error as PlannerResponseError;
    }
    throw new Error('Expected the whole plan to be rejected');
}

test('diagnoses missing fields, empty actions, and nested note limits', () => {
    const { memory_updates, ...missing } = plan;
    expect(rejection(missing).diagnostic).toContain('$.memory_updates: invalid_type (expected array)');
    expect(rejection({ ...plan, actions: [] }).diagnostic).toContain('$.actions: too_small (minimum 1, inclusive)');
    const note = { key: 'record', text: 'x'.repeat(2001), sources: Array(9).fill(0), operation: 'add', expected_text: null };
    const diagnostic = rejection({ ...plan, memory_updates: [note] }).diagnostic;
    expect(diagnostic).toContain('$.memory_updates[0].text: too_big (maximum 2000, inclusive)');
    expect(diagnostic).toContain('$.memory_updates[0].sources: too_big (maximum 8, inclusive)');
});

test('diagnoses the failing action without exposing its values or unknown variant', () => {
    const secret = 'REJECTED_RESPONSE_SECRET';
    const error = rejection({ ...plan, actions: [...plan.actions, { variant: 'click', x: secret }] });
    expect(error.diagnostic).toContain('$.actions[1].x: invalid_type (expected number)');
    expect(error.message).toContain(error.diagnostic);
    expect(error.message).not.toContain(secret);
    const unknown = rejection({ ...plan, actions: [{ variant: secret }] });
    expect(unknown.diagnostic).toContain('$.actions[0].variant: unknown action');
    expect(unknown.message).not.toContain(secret);
});

test('primitive and wrapped action inputs retain precise schema paths', () => {
    const say = createAction({ name: 'say', schema: z.string().max(4), resolver: async () => {} });
    expect(rejection({ ...plan, actions: [{ variant: 'say', input: 'longer' }] }, [say]).diagnostic)
        .toContain('$.actions[0].input: too_big (maximum 4, inclusive)');
    const nested = createAction({ name: 'nested', schema: z.object({ items: z.array(z.object({ count: z.number().int() }).optional()) }), resolver: async () => {} });
    expect(rejection({ ...plan, actions: [{ variant: 'nested', items: [{ count: 1.5 }] }] }, [nested]).diagnostic)
        .toContain('$.actions[0].items[0].count: invalid_type (expected integer)');
});

test('diagnostics omit unknown keys, dynamic record keys, and custom refinement messages', () => {
    const secret = 'REJECTED_RESPONSE_SECRET';
    expect(rejection({ ...plan, [secret]: true }).message).not.toContain(secret);
    const record = createAction({ name: 'record', schema: z.object({ values: z.record(z.number()) }), resolver: async () => {} });
    const error = rejection({ ...plan, actions: [{ variant: 'record', values: { [secret]: 'invalid' } }] }, [record]);
    expect(error.diagnostic).toContain('$.actions[0].values[*]: invalid_type (expected number)');
    expect(error.message).not.toContain(secret);
    const custom = createAction({ name: 'custom', schema: z.string().refine(() => false, { message: secret, path: [secret] }), resolver: async () => {} });
    const refined = rejection({ ...plan, actions: [{ variant: 'custom', input: secret }] }, [custom]);
    expect(refined.diagnostic).toContain('custom');
    expect(refined.message).not.toContain(secret);
});

test('diagnostics remain bounded for many errors and enormous malformed text', () => {
    const error = rejection({ ...plan, memory_updates: Array(100).fill({ key: '', text: '' }) });
    expect(error.diagnostic.length).toBeLessThanOrEqual(1024);
    expect(error.diagnostic).toContain('additional issues omitted');
    const secret = 'REJECTED_RESPONSE_SECRET';
    try { parsePlannerResponse(`${secret.repeat(10000)}{`, vocabulary); }
    catch (error) {
        expect(error).toBeInstanceOf(PlannerResponseError);
        expect((error as PlannerResponseError).diagnostic).toContain('invalid_json');
        expect((error as Error).message).not.toContain(secret);
        return;
    }
    throw new Error('Malformed output was accepted');
});
