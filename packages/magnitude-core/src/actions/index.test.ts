import { expect, test } from 'bun:test';
import { createAction } from './index';

test('an explicitly undefined action schema accepts an empty input', () => {
    const action = createAction({
        name: 'empty',
        schema: undefined,
        resolver: async () => {},
    });
    const input = action.schema.parse({});
    expect(action.render(input)).toBe('{}');
    expect(input).toEqual({});
});
