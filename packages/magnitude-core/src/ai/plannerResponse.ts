import { z } from 'zod';
import type { ActionDefinition } from '@/actions';
import type { Action } from '@/actions/types';

export class PlannerResponseError extends Error {
    constructor(message = 'Expected one complete JSON plan with reasoning and actions') {
        super(message);
        this.name = 'PlannerResponseError';
    }
}

const planSchema = z.object({
    reasoning: z.string().trim().min(1),
    actions: z.array(z.object({ variant: z.string() }).passthrough()).min(1),
}).strict();

// BAML can coerce prose, incomplete JSON, or multiple objects into a plan. Do not
// execute that recovery: a simulated multi-turn transcript is not a safe batch.
export function parsePlannerResponse<T>(raw: string | null, vocabulary: ActionDefinition<T>[]): { reasoning: string; actions: Action[] } {
    const text = raw?.trim() ?? '';
    // Accept a single JSON fence for compatibility, but no surrounding narrative.
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
    let value: unknown;
    try { value = JSON.parse(fenced ? fenced[1] : text); }
    catch { throw new PlannerResponseError(); }
    const plan = planSchema.safeParse(value);
    if (!plan.success) throw new PlannerResponseError();
    for (const action of plan.data.actions) {
        const definition = vocabulary.find(candidate => candidate.name === action.variant);
        if (!definition) throw new PlannerResponseError('Plan contains an unknown action variant');
        const { variant, ...fields } = action;
        const input = definition.schema instanceof z.ZodObject ? fields : action.input;
        if (!definition.schema.safeParse(input).success) {
            throw new PlannerResponseError('Plan contains action inputs that do not match the schema');
        }
    }
    return plan.data;
}
