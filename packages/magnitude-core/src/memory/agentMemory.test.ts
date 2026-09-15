import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { AgentMemory } from './agentMemory';
import { Observation } from './observation';
import { Image } from './image';

const screen = (n: number) => Observation.fromConnector('fixture', {
    url: `https://fixture.invalid/record/${n}?filter=active`,
    screenshot: new Image(sharp({ create: { width: 2, height: 2, channels: 3, background: { r: n * 13, g: 80, b: 120 } } }).png()),
}, { type: 'screenshot', limit: 2, dedupe: true });
const text = async (memory: AgentMemory) => (await memory.render()).flatMap(message => message.content)
    .filter(part => typeof part === 'string').join('');

for (const promptCaching of [false, true]) test(`notes survive screenshot and thought eviction with prompt caching ${promptCaching}`, async () => {
    const memory = new AgentMemory({ promptCaching, thoughtLimit: 1 });
    memory.recordObservation(screen(0));
    expect(await text(memory)).toContain('[Observation 0]');
    memory.remember({ key: 'record', text: 'Exact value: 791; status uncertain.', sources: [0] });
    for (let i = 1; i < 15; i++) {
        memory.recordThought(i === 1 ? 'Discard-this-old-thought' : `Intermediate check ${i}`);
        memory.recordObservation(screen(i));
        await memory.render();
    }
    const rendered = await text(memory);
    expect(rendered).not.toContain('[Observation 0]');
    expect(rendered).not.toContain('Discard-this-old-thought');
    expect(rendered).toContain('Exact value: 791; status uncertain.');
    expect(rendered).toContain('https://fixture.invalid/record/0?filter=active');
    expect((await memory.render()).at(-1)?.cacheControl).toBe(false);
    const saved = JSON.parse(JSON.stringify(await memory.toJSON()));
    const restored = new AgentMemory({ promptCaching });
    await restored.loadJSON(saved);
    expect(await restored.toJSON()).toEqual(saved);
    expect(await text(restored)).toContain('Exact value: 791; status uncertain.');
    expect((await restored.simpleRender()).join('')).toContain('not independent evidence');
    // Consolidation can reference provenance still shown in the notebook.
    restored.remember({ key: 'consolidated', text: 'Prior observed value: 791.', sources: [0] });
    restored.forget('record');
    expect(await text(restored)).not.toContain('status uncertain');
});

test('only visible connector observations or retained note sources can be cited', async () => {
    const memory = new AgentMemory();
    memory.recordObservation(screen(0));
    memory.recordObservation(Observation.fromThought('A model claim is not a source.'));
    memory.recordObservation(Observation.fromActionTaken('answer', 'A model answer is not a source.'));
    for (let i = 1; i < 4; i++) memory.recordObservation(screen(i));
    await memory.render();
    for (const id of [0, 1, 2, 999, -1, 0.5]) {
        expect(() => memory.remember({ key: 'invalid', text: 'claim', sources: [id] })).toThrow();
    }
    memory.remember({ key: 'observed', text: 'visible fact', sources: [5] });
    memory.recordObservation(screen(4));
    // Merely recording an observation does not make it model-visible.
    expect(() => memory.remember({ key: 'not-seen', text: 'claim', sources: [6] })).toThrow();
    expect((await memory.toJSON()).notes).toHaveLength(1);
});

test('loading legacy memory clears notes and visibility/cache state', async () => {
    const memory = new AgentMemory({ promptCaching: true });
    memory.recordObservation(screen(0));
    await memory.render();
    memory.remember({ key: 'old-task', text: 'old task fact', sources: [0] });
    const legacy = new AgentMemory();
    legacy.recordObservation(Observation.fromConnector('fixture', 'New task observation'));
    await memory.loadJSON(await legacy.toJSON());
    expect((await memory.toJSON()).notes).toBeUndefined();
    expect(() => memory.remember({ key: 'premature', text: 'claim', sources: [0] })).toThrow();
    expect(await text(memory)).not.toContain('old task fact');
    expect(await text(memory)).toContain('New task observation');
});

test('malformed checkpoint provenance does not replace current memory', async () => {
    const memory = new AgentMemory();
    memory.recordObservation(screen(0));
    const saved = await memory.toJSON();
    await expect(memory.loadJSON({ ...saved, notes: [{ key: 'bad', text: 'claim', sources: [50] }] })).rejects.toThrow();
    expect(await memory.toJSON()).toEqual(saved);
});

for (const promptCaching of [false, true]) test(`completed checks outlive the default thought window and can be corrected, caching ${promptCaching}`, async () => {
    const memory = new AgentMemory({ promptCaching });
    const url = `https://fixture.invalid/${crypto.randomUUID()}`;
    memory.recordObservation(Observation.fromConnector('fixture', { url, value: 'pending' }, { type: 'state', limit: 1 }));
    memory.recordThought('Original inspection finished.');
    await memory.render();
    memory.remember({ key: 'inspection', text: 'Checked record; observed status pending. Follow-up unresolved.', sources: [0] });
    for (let i = 0; i < 35; i++) {
        memory.recordObservation(Observation.fromConnector('fixture', `Other record ${i}`, { type: 'state', limit: 1 }));
        memory.recordThought(`Unrelated check ${i}`);
        await memory.render();
    }
    const rendered = await text(memory);
    expect(rendered).not.toContain('Original inspection finished.');
    expect(rendered).not.toContain('[Observation 0]');
    expect(rendered).toContain('Checked record; observed status pending. Follow-up unresolved.');
    // A legitimate later revisit can change the fact: no automatic "already seen" skip.
    memory.recordObservation(Observation.fromConnector('fixture', { url, value: 'complete' }, { type: 'state', limit: 1 }));
    const latestId = (await memory.toJSON()).observations.length - 1;
    await memory.render();
    memory.remember({ key: 'inspection', text: 'Rechecked record; now complete. No follow-up remains.', sources: [latestId] },
        'Checked record; observed status pending. Follow-up unresolved.');
    const corrected = await text(memory);
    expect(corrected).toContain('now complete');
    expect(corrected).not.toContain('status pending');
    expect((await memory.toJSON()).notes?.[0].sources).toEqual([latestId]);
    expect((await memory.toJSON()).observations[0].data).toHaveProperty('value');
    const saved = await memory.toJSON();
    const restored = new AgentMemory({ promptCaching });
    await restored.loadJSON(saved);
    await restored.render();
    expect(() => restored.remember({ key: 'inspection', text: 'A different record', sources: [latestId] })).toThrow('already exists');
    expect(() => restored.remember({ key: 'inspection', text: 'Stale correction', sources: [latestId] },
        'Checked record; observed status pending. Follow-up unresolved.')).toThrow('exactly match');
    expect(await restored.toJSON()).toEqual(saved);
});

test('duplicate keys in a checkpoint fail without replacing existing memory', async () => {
    const memory = new AgentMemory();
    memory.recordObservation(screen(0));
    await memory.render();
    memory.remember({ key: 'unique', text: 'Keep this fact', sources: [0] });
    const saved = await memory.toJSON();
    await expect(memory.loadJSON({ ...saved, notes: [...saved.notes!, { ...saved.notes![0], text: 'Discarded duplicate' }] })).rejects.toThrow('already exists');
    expect(await memory.toJSON()).toEqual(saved);
});
