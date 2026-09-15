import { z } from 'zod';
import type { ActionDefinition } from '@/actions';
import type { Action } from '@/actions/types';
import { noteUpdateSchema, NOTEBOOK_LIMITS, type NoteUpdate } from '@/memory/notebook';

export interface PlannerResponse {
    reasoning: string;
    memory_updates: NoteUpdate[];
    actions: Action[];
}

export const memoryUpdatesSchema = z.array(noteUpdateSchema).max(NOTEBOOK_LIMITS.entries)
    .describe('Review the current observations before acting. Add exact facts and completed checks as separate records; correct only the targeted existing record with an exact current-text match. Omitted records stay unchanged. Return [] when nothing new needs retaining. Never record imagined action results. Each update costs one action.');

export class PlannerResponseError extends Error {
    readonly diagnostic: string;

    constructor(diagnostic = '$: expected one complete JSON plan with reasoning, memory_updates and actions', message = 'Invalid planner response') {
        const bounded = diagnostic.slice(0, 1024);
        super(`${message}: ${bounded}`);
        this.name = 'PlannerResponseError';
        this.diagnostic = bounded;
    }
}

const planSchema = z.object({
    reasoning: z.string().trim().min(1),
    memory_updates: memoryUpdatesSchema,
    actions: z.array(z.object({ variant: z.string() }).passthrough()).min(1),
}).strict();

// Only schema-owned field names and array indices may enter the repair prompt.
// Record keys, custom refinement paths/messages and received values can contain
// model output or page text; do not echo them into prompts or persisted errors.
function diagnosticPath(schema: z.ZodTypeAny, path: (string | number)[], prefix: string): string {
    let current = schema;
    for (const part of path.slice(0, 6)) {
        for (let depth = 0; depth < 16; depth++) {
            if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap();
            else if (current instanceof z.ZodEffects) current = current.innerType();
            else if (current instanceof z.ZodDefault) current = current.removeDefault();
            else break;
        }
        if (typeof part === 'string' && current instanceof z.ZodObject
            && Object.hasOwn(current.shape, part) && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(part)) {
            prefix += `.${part}`;
            current = current.shape[part];
        } else if (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 && current instanceof z.ZodArray) {
            prefix += `[${part}]`;
            current = current.element;
        } else return `${prefix}[*]`;
    }
    return path.length > 6 ? `${prefix}...` : prefix;
}

function schemaDiagnostic(error: z.ZodError, schema: z.ZodTypeAny, prefix = '$'): string {
    const details = error.issues.slice(0, 3).map(issue => {
        let constraint = '';
        if (issue.code === 'invalid_type' && Object.hasOwn(z.ZodParsedType, issue.expected)) {
            constraint = ` (expected ${issue.expected})`;
        } else if (issue.code === 'too_big' || issue.code === 'too_small') {
            const limit = issue.code === 'too_big' ? issue.maximum : issue.minimum;
            if (typeof limit === 'number' && Number.isFinite(limit)) {
                constraint = ` (${issue.code === 'too_big' ? 'maximum' : 'minimum'} ${limit}, ${issue.inclusive ? 'inclusive' : 'exclusive'})`;
            }
        }
        const code = Object.hasOwn(z.ZodIssueCode, issue.code) ? issue.code : 'schema constraint failed';
        return `${diagnosticPath(schema, issue.path, prefix)}: ${code}${constraint}`;
    });
    if (error.issues.length > 3) details.push('additional issues omitted');
    return details.join('; ');
}

// BAML can coerce prose, incomplete JSON, or multiple objects into a plan. Do not
// execute that recovery: a simulated multi-turn transcript is not a safe batch.
export function parsePlannerResponse<T>(raw: string | null, vocabulary: ActionDefinition<T>[]): PlannerResponse {
    const text = raw?.trim() ?? '';
    // Accept a single JSON fence for compatibility, but no surrounding narrative.
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
    let value: unknown;
    try { value = JSON.parse(fenced ? fenced[1] : text); }
    catch { throw new PlannerResponseError('$: invalid_json; return exactly one complete JSON object'); }
    const plan = planSchema.safeParse(value);
    if (!plan.success) throw new PlannerResponseError(schemaDiagnostic(plan.error, planSchema));
    for (const [index, action] of plan.data.actions.entries()) {
        const definition = vocabulary.find(candidate => candidate.name === action.variant);
        if (!definition) throw new PlannerResponseError(`$.actions[${index}].variant: unknown action; choose an action from the schema`);
        const { variant, ...fields } = action;
        const objectInput = definition.schema instanceof z.ZodObject;
        const parsed = definition.schema.safeParse(objectInput ? fields : action.input);
        if (!parsed.success) {
            throw new PlannerResponseError(schemaDiagnostic(parsed.error, definition.schema, `$.actions[${index}]${objectInput ? '' : '.input'}`));
        }
    }
    return plan.data;
}
