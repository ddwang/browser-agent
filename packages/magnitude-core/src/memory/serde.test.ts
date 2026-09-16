import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { AgentMemory } from './agentMemory';
import { Image } from './image';
import { maskObservations } from './masking';
import { Observation, type RenderableContent } from './observation';
import { jsonToObservableData, observableDataToJson } from './serde';

const roundTrip = async (value: RenderableContent) =>
    jsonToObservableData(JSON.parse(JSON.stringify(await observableDataToJson(value))));

test('nested objects, arrays, and falsy values survive an actual JSON round trip', async () => {
    const value = { count: 17, empty: '', nested: { label: 'fixture', values: [true, false, 0, null, { n: -2 }] } };
    expect(await roundTrip(value)).toEqual(value);
    expect(await roundTrip([value, 'text', 0, false, null])).toEqual([value, 'text', 0, false, null]);
});

test('undefined entries are omitted without losing null or empty values', async () => {
    expect(await roundTrip({ missing: undefined, empty: {}, nested: { absent: undefined, present: null }, values: [undefined, '', null] }))
        .toEqual({ empty: {}, nested: { present: null }, values: ['', null] });
    expect(await observableDataToJson(undefined)).toBeUndefined();
    expect(await jsonToObservableData(undefined)).toBeUndefined();
});

test('arbitrary own property names survive without changing object prototypes', async () => {
    const value = JSON.parse('{"__proto__":{"fixture":true},"constructor":{"prototype":{"n":2}},"a/b~c":false}');
    const saved = await observableDataToJson(value);
    const loaded = await roundTrip(value);
    for (const object of [saved, loaded]) {
        if (!object || typeof object !== 'object') throw new Error('Expected a saved/restored object');
        expect(Object.hasOwn(object, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
    }
    expect(loaded).toEqual(value);
    expect(Object.hasOwn(Object.prototype, 'fixture')).toBe(false);
});

test('nested media is serialized before JSON encoding and restored as an Image', async () => {
    const screenshot = new Image(sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png());
    const value = { nested: { screenshot }, rows: [screenshot, { label: 'image fixture' }] };
    const saved = (await observableDataToJson(value))!;
    const loaded = await roundTrip(value) as typeof value;
    expect(loaded.nested.screenshot).toBeInstanceOf(Image);
    expect(await loaded.nested.screenshot.getDimensions()).toEqual({ width: 2, height: 3 });
    expect(await observableDataToJson(loaded)).toEqual(saved);
});

test('memory checkpoints retain structured observations and their metadata', async () => {
    const memory = new AgentMemory();
    memory.recordObservation(new Observation('connector:fixture', 'user', { a: [{ b: 4 }] }, { type: 'state', dedupe: true }, 123));
    const saved = JSON.parse(JSON.stringify(await memory.toJSON()));
    const restored = new AgentMemory();
    await restored.loadJSON(saved);
    expect(await restored.toJSON()).toEqual(saved);
    expect((await restored.toJSON()).observations[0].data).toEqual({ a: [{ b: { type: 'primitive', content: 4 } }] });
});

test('deduplication distinguishes different structured observation values', async () => {
    const observations = [1, 1, 2].map(value => Observation.fromConnector('fixture', { nested: { value } }, { type: 'state', dedupe: true }));
    expect(await observations[0].equals(observations[1])).toBe(true);
    expect(await observations[1].equals(observations[2])).toBe(false);
    expect(await maskObservations(observations)).toEqual([false, true, true]);
});

test('varied synthetic object keys and nested values round-trip independently of task content', async () => {
    let seed = 0xa173;
    for (let i = 0; i < 64; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const value = { [`field_${seed.toString(36)}_é`]: [{ count: seed, enabled: !!(seed % 2), nested: { value: `value-${i}` } }] };
        expect(await roundTrip(value)).toEqual(value);
    }
});
