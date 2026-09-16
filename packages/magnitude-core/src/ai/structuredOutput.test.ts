import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createAction } from '@/actions';
import { webActions } from '@/actions/webActions';
import { anthropicOutputFormat, plannerSchema, usesStructuredOutput } from './structuredOutput';

test('Anthropic native output is automatic only for known supported direct models', () => {
    for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-6']) {
        expect(usesStructuredOutput({ provider: 'anthropic', options: { model } })).toBe(true);
        expect(usesStructuredOutput({ provider: 'anthropic', options: { model, structuredOutputs: false } })).toBe(false);
    }
    for (const model of ['claude-sonnet-4-20250514', 'claude-sonnet-50', 'future-custom-model']) {
        expect(usesStructuredOutput({ provider: 'anthropic', options: { model } })).toBe(false);
    }
    expect(usesStructuredOutput({ provider: 'anthropic', options: { model: 'future-custom-model', structuredOutputs: true } })).toBe(true);
    expect(usesStructuredOutput({ provider: 'claude-code', options: { model: 'claude-sonnet-5' } })).toBe(false);
    expect(usesStructuredOutput({ provider: 'openai', options: { model: 'claude-sonnet-5' } })).toBe(false);
});

test('Baseten hosted Model APIs enable native output with an explicit custom-endpoint opt-in', () => {
    for (const model of ['deepseek-ai/DeepSeek-V4.1-Flash', 'zai-org/GLM-5.3-Flash', 'future-hosted-model']) {
        for (const baseUrl of [undefined, 'https://inference.baseten.co/v1', 'https://inference.baseten.co/v1/']) {
            expect(usesStructuredOutput({ provider: 'baseten', options: { model, baseUrl } })).toBe(true);
            expect(usesStructuredOutput({ provider: 'baseten', options: { model, baseUrl, structuredOutputs: false } })).toBe(false);
        }
    }
    for (const baseUrl of ['http://127.0.0.1:8080/v1', 'https://inference.baseten.co/v1/custom', 'https://proxy.example/v1']) {
        expect(usesStructuredOutput({ provider: 'baseten', options: { model: 'custom', baseUrl } })).toBe(false);
        expect(usesStructuredOutput({ provider: 'baseten', options: { model: 'custom', baseUrl, structuredOutputs: true } })).toBe(true);
    }
});

test('wire schema uses existing action definitions, including primitive and nested payloads', () => {
    const actions = [
        createAction({ name: 'move', schema: z.object({ to: z.object({ x: z.number().int(), y: z.number().int() }) }), resolver: async () => {} }),
        createAction({ name: 'report', schema: z.string(), resolver: async () => {} }),
    ];
    const schema = anthropicOutputFormat(plannerSchema(actions))!.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['reasoning', 'memory_updates', 'actions']);
    expect(schema.properties.memory_updates.type).toBe('array');
    expect(schema.properties.memory_updates.items.required).toEqual(['key', 'text', 'sources', 'operation', 'expected_text']);
    expect(schema.properties.memory_updates.items.properties.operation.enum).toEqual(['add', 'correct']);
    expect(schema.properties.memory_updates.items.properties.expected_text.anyOf.map((option: any) => option.type)).toEqual(['string', 'null']);
    expect(schema.properties.memory_updates.items.properties.sources.items.type).toBe('integer');
    expect(schema.properties.actions.minItems).toBe(1);
    expect(schema.properties.actions.items.anyOf.map((item: any) => item.properties.variant.const)).toEqual(['move', 'report']);
    expect(schema.properties.actions.items.anyOf[0].properties.to.properties.x.type).toBe('integer');
    expect(schema.properties.actions.items.anyOf[1].properties.input.type).toBe('string');
    expect(() => plannerSchema([])).toThrow('at least one action');
    expect(anthropicOutputFormat(plannerSchema([...webActions]))?.schema.properties.actions.items.anyOf).toHaveLength(webActions.length);
});

test('unsupported value constraints stay in descriptions and the original validator', () => {
    const original = z.object({
        size: z.number().int().min(2).max(5),
        text: z.string().min(2).max(4).regex(/^A/),
        rows: z.array(z.string()).min(3).max(7),
    });
    const format = anthropicOutputFormat(original)!;
    expect(format.schema.properties.size.minimum).toBeUndefined();
    expect(format.schema.properties.size.description).toContain('minimum: 2');
    expect(format.schema.properties.text.pattern).toBeUndefined();
    expect(format.schema.properties.rows.minItems).toBeUndefined();
    expect(format.schema.properties.rows.description).toContain('minItems: 3');
    expect(original.safeParse({ size: 1, text: 'bad', rows: [] }).success).toBe(false);
});

test('reused nonrecursive definitions resolve without treating property names as keywords', () => {
    const coordinate = z.object({ x: z.number() });
    const format = anthropicOutputFormat(z.object({ minimum: coordinate, properties: coordinate, 'a/b~c': coordinate }))!;
    expect(format.schema.properties.minimum).toEqual(format.schema.properties.properties);
    expect(format.schema.properties['a/b~c']).toEqual(format.schema.properties.minimum);
});

test('unsupported data shapes retain prompt-only compatibility instead of changing their shape', () => {
    const recursive: z.ZodType<any> = z.lazy(() => z.object({ next: recursive.optional() }));
    for (const schema of [z.record(z.string()), z.object({}).passthrough(), z.any(), recursive, z.tuple([z.string(), z.number()])]) {
        expect(anthropicOutputFormat(schema)).toBeUndefined();
    }
    expect(anthropicOutputFormat(z.object(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`field${i}`, z.string().optional()]))))).toBeUndefined();
});

test('generated schemas stay stable across varied field names and action vocabularies', () => {
    // Synthetic protocol cases, independent of website task content or answers.
    let seed = 0x9147;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed.toString(36); };
    for (let i = 0; i < 64; i++) {
        const name = `op:${next()}`;
        const field = `field_${next()}_\"\\é`;
        const schema = plannerSchema([createAction({ name, schema: z.object({ [field]: z.string(), enabled: z.boolean().optional() }), resolver: async () => {} })]);
        const first = anthropicOutputFormat(schema)!;
        expect(first).toEqual(anthropicOutputFormat(schema)!);
        expect(first.schema.properties.actions.items.properties[field].type).toBe('string');
        expect(first.schema.properties.actions.items.properties.variant.const).toBe(name);
        expect(first.schema.properties.actions.items.required).not.toContain('enabled');
    }
});
