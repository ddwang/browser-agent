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
    for (const schema of [z.date(), z.bigint(), z.symbol(), z.map(z.string(), z.string()), z.set(z.string())]) {
        expect(() => convertZodToJsonSchema(schema)).toThrow();
    }
});
