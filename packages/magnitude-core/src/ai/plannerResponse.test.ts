import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createAction } from '@/actions';
import { parsePlannerResponse, PlannerResponseError } from './plannerResponse';

const vocabulary = [createAction({ name: 'click', schema: z.object({ x: z.number() }), resolver: async () => {} })];
const plan = { reasoning: 'Click the observed button.', actions: [{ variant: 'click', x: 12 }] };

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
    const response = { reasoning: 'Answer.', actions: [{ variant: 'say', input: 'hello' }] };
    expect(parsePlannerResponse(JSON.stringify(response), [primitive])).toEqual(response);
});
