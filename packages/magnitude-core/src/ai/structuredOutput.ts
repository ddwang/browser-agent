import { zodToJsonSchema } from 'zod-to-json-schema';
import { z, type Schema } from 'zod';
import type { LLMClient } from './types';
import type { ActionDefinition } from '@/actions';
import { actionInputSchema } from '@/actions/util';
import { memoryUpdatesSchema } from './plannerResponse';

type JsonSchema = Record<string, any>;

export function usesStructuredOutput(client: LLMClient): boolean {
    if (client.provider !== 'anthropic') return false;
    // Unknown/older models and OAuth providers keep their existing transport.
    return client.options.structuredOutputs ?? /^claude-(?:haiku-4-5|sonnet-(?:4-5|4-6|5)|opus-(?:4-5|4-6|4-7|4-8|5))(?:-\d{8})?$/.test(client.options.model);
}

export function plannerSchema(vocabulary: ActionDefinition<any>[]): Schema {
    const actions = vocabulary.map(actionInputSchema);
    if (!actions.length) throw new Error('Planner requires at least one action definition');
    return z.object({
        reasoning: z.string(),
        memory_updates: memoryUpdatesSchema,
        actions: z.array(actions.length === 1 ? actions[0] : z.union(actions as [Schema, Schema, ...Schema[]])).min(1),
    });
}

// https://platform.claude.com/docs/en/build-with-claude/structured-outputs
// Provider constraints are narrower than Zod. Retain unsupported value constraints
// in descriptions and validate the response against the original Zod schema.
// Open maps, recursive schemas, and unknown schema constructs use the existing
// BAML path instead of silently changing the caller's data shape.
export function anthropicOutputFormat(schema: Schema): { type: 'json_schema'; schema: JsonSchema } | undefined {
    const root = zodToJsonSchema(schema) as JsonSchema;
    const constraints = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'maxItems', 'uniqueItems']);
    const annotations = new Set(['$schema', 'definitions', '$defs', 'title', 'description', 'default']);
    let optionalCount = 0;
    let unionCount = 0;
    function convert(input: JsonSchema, ancestors = new Set<JsonSchema>()): JsonSchema {
        if (!input || typeof input !== 'object' || Array.isArray(input) || ancestors.has(input)) throw new Error('Unsupported schema');
        const path = new Set(ancestors).add(input);
        if (input.$ref) {
            if (!input.$ref.startsWith('#/')) throw new Error('Unsupported schema reference');
            const referenced = input.$ref.slice(2).split('/').reduce((value: any, key: string) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
            return convert(referenced, path);
        }
        const result: JsonSchema = {};
        const notes: string[] = [];
        for (const [key, value] of Object.entries(input)) {
            if (constraints.has(key) || (key === 'minItems' && value > 1)) {
                notes.push(`${key}: ${JSON.stringify(value)}`);
            } else if (key === 'properties') {
                result.properties = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, convert(property as JsonSchema, path)]));
            } else if (key === 'items') {
                result.items = convert(value, path);
            } else if (key === 'anyOf' || key === 'allOf') {
                if (key === 'anyOf') unionCount++;
                result[key] = value.map((item: JsonSchema) => convert(item, path));
            } else if (['type', 'enum', 'const', 'required', 'minItems', 'additionalProperties'].includes(key)) {
                result[key] = value;
                if (key === 'type' && Array.isArray(value)) unionCount++;
            } else if (!annotations.has(key)) throw new Error('Unsupported schema keyword');
        }
        if (!result.type && !result.anyOf && !result.allOf && !('const' in result) && !result.enum) throw new Error('Unconstrained schema');
        if (result.enum?.some((value: unknown) => value !== null && typeof value === 'object') || (result.const !== null && typeof result.const === 'object')) throw new Error('Complex literal');
        if (result.type === 'object') {
            if (result.additionalProperties !== false) throw new Error('Open-ended object');
            optionalCount += Object.keys(result.properties ?? {}).filter(key => !result.required?.includes(key)).length;
        }
        if (input.description || notes.length) result.description = [input.description, ...notes].filter(Boolean).join('\n');
        return result;
    }
    try {
        const converted = convert(root);
        if (optionalCount > 24 || unionCount > 16) return undefined;
        return { type: 'json_schema', schema: converted };
    } catch { return undefined; }
}
