import { expect, mock, test } from 'bun:test';
import type { Agent } from '@/agent';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { keyboardEscapeAction, scrollCoordAction, waitAction, webActions } from './webActions';

test('Escape is exposed and forwards the Escape command', async () => {
    const escape = mock(async () => {});
    const agent = { require: () => ({ getHarness: () => ({ escape }) }) } as unknown as Agent;
    expect(webActions).toContain(keyboardEscapeAction);
    await keyboardEscapeAction.resolver({ agent, input: {} });
    expect(escape).toHaveBeenCalledTimes(1);
});

test('wait validates its duration and uses browser cooldown handling', async () => {
    const wait = mock(async () => {});
    const agent = { require: () => ({ wait }) } as unknown as Agent;
    await waitAction.resolver({ agent, input: { seconds: 2 } });
    expect(wait).toHaveBeenCalledWith(2000);
    expect(waitAction.schema.safeParse({ seconds: -1 }).success).toBe(false);
    expect(waitAction.schema.safeParse({ seconds: Infinity }).success).toBe(false);
});

test('scroll scale and precision guidance are included in the action schema', () => {
    const prompt = `${scrollCoordAction.description} ${JSON.stringify(zodToJsonSchema(scrollCoordAction.schema))}`;
    expect(prompt).toContain('not wheel ticks');
    expect(prompt).toContain('500-600');
    expect(prompt).toContain('600 scrolls down, -600 scrolls up');
    expect(prompt).toContain('positive scrolls right, negative scrolls left');
    expect(prompt).toContain('fine adjustments');
});

for (const deltas of [
    { deltaX: 0, deltaY: 5 },
    { deltaX: 0, deltaY: -5 },
    { deltaX: 0, deltaY: 600 },
    { deltaX: 0, deltaY: -600 },
    { deltaX: 600, deltaY: 0 },
    { deltaX: -5, deltaY: 0 },
]) {
    test(`scroll forwards pixel distances unchanged: ${deltas.deltaX}, ${deltas.deltaY}`, async () => {
        const scroll = mock(async () => {});
        const agent = { require: () => ({ getHarness: () => ({ scroll }) }) } as unknown as Agent;
        const input = scrollCoordAction.schema.parse({ x: 120, y: 250, ...deltas });

        await scrollCoordAction.resolver({ agent, input });

        expect(scroll).toHaveBeenCalledTimes(1);
        expect(scroll).toHaveBeenCalledWith({ x: 120, y: 250, ...deltas });
    });
}
