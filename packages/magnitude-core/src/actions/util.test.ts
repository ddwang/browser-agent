import { expect, test } from 'bun:test';
import { z } from 'zod';
import { convertZodToJsonSchema } from './util';

test('coercing dates and bigints have explicit model-facing wire schemas', () => {
    const schema = z.object({ date: z.coerce.date(), count: z.coerce.bigint() });
    expect(convertZodToJsonSchema(schema)).toMatchObject({ properties: {
        date: { type: 'string', format: 'date-time' }, count: { type: 'integer' },
    } });
});

test('unrepresentable schemas without a supported coercion still fail conversion', () => {
    for (const schema of [z.date(), z.bigint(), z.bigint().default(42n), z.bigint().catch(42n), z.symbol(), z.map(z.string(), z.string()), z.set(z.string())]) {
        expect(() => convertZodToJsonSchema(schema)).toThrow();
    }
});

test('bigint defaults stay local while wrapped wire types remain representable', () => {
    for (const schema of [z.coerce.bigint().default(42n), z.coerce.bigint().prefault(42n), z.coerce.bigint().catch(42n)]) {
        const wire = convertZodToJsonSchema(schema);
        expect(wire.type).toBe('integer');
        expect(wire).not.toHaveProperty('default');
        expect(schema.parse(undefined)).toBe(42n);
        expect(schema.parse(7)).toBe(7n);
    }
    const counts = z.object({ counts: z.array(z.coerce.bigint()) });
    for (const schema of [counts.default({ counts: [42n] }), counts.catch({ counts: [42n] })]) {
        expect(convertZodToJsonSchema(schema)).toMatchObject({
            type: 'object', properties: { counts: { type: 'array', items: { type: 'integer' } } },
        });
        expect(convertZodToJsonSchema(schema)).not.toHaveProperty('default');
    }
    expect(z.coerce.bigint().catch(42n).parse('invalid')).toBe(42n);
});

test('JSON-compatible default annotations remain available to the model', () => {
    for (const schema of [z.number().default(42), z.number().catch(42)]) {
        expect(convertZodToJsonSchema(schema)).toMatchObject({ type: 'number', default: 42 });
    }
});
