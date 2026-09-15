import { expect, test } from 'bun:test';
import { NOTEBOOK_LIMITS, TaskNotebook, noteSchema } from './notebook';

const source = (observation: number) => ({ observation, capturedAt: observation + 100, url: `https://fixture.invalid/record/${observation}?filter=active` });
const entry = (key = 'item', text = 'Observed value', sources = [0]) => ({ key, text, sources });

test('adds do not overwrite and explicit corrections preserve unrelated records', () => {
    const notebook = new TaskNotebook();
    notebook.put(entry('__proto__', 'Uncertain old value', [0, 0]), source);
    notebook.put(entry('unrelated', 'Another record', [2]), source);
    expect(notebook.toJSON()[0].sources).toEqual([0]);
    const before = notebook.toJSON();
    expect(() => notebook.put(entry('__proto__', 'New record'), source)).toThrow('already exists');
    expect(() => notebook.put(entry('__proto__', 'Corrected exact value'), source, 'stale value')).toThrow('exactly match');
    expect(() => notebook.put(entry('missing', 'Corrected exact value'), source, 'Uncertain old value')).toThrow('key must exist');
    expect(notebook.toJSON()).toEqual(before);
    notebook.put(entry('__proto__', 'Corrected exact value', [1]), source, 'Uncertain old value');
    expect(notebook.toJSON()).toEqual([entry('__proto__', 'Corrected exact value', [1]), before[1]]);
    expect(notebook.sourceIds()).toEqual([1, 2]);
    expect(notebook.render()).toContain('model-written summaries, not independent evidence');
    expect(notebook.render()).toContain(source(1).url);
    expect(notebook.render()).not.toContain('Uncertain old value');
    notebook.forget('__proto__');
    notebook.forget('unrelated');
    notebook.forget('already absent');
    expect(notebook.render()).toBeUndefined();
});

test('entry limits reject updates atomically without evicting old facts', () => {
    const notebook = new TaskNotebook();
    for (let i = 0; i < NOTEBOOK_LIMITS.entries; i++) notebook.put(entry(`item-${i}`), source);
    const before = notebook.toJSON();
    expect(() => notebook.put(entry('overflow'), source)).toThrow('Consolidate or forget');
    expect(notebook.toJSON()).toEqual(before);
    notebook.put(entry('item-0', 'replacement'), source, 'Observed value');
    expect(notebook.toJSON().slice(1)).toEqual(before.slice(1));
    notebook.forget('item-1');
    notebook.put(entry('new-slot'), source);
    expect(notebook.toJSON()).toHaveLength(NOTEBOOK_LIMITS.entries);
});

test('the byte cap includes Unicode and captured URLs, not just text character counts', () => {
    const notebook = new TaskNotebook();
    notebook.put(entry(), source);
    const before = notebook.toJSON();
    expect(() => notebook.put(entry('oversized-url'), id => ({ ...source(id), url: 'x'.repeat(NOTEBOOK_LIMITS.bytes) })))
        .toThrow('bytes');
    expect(notebook.toJSON()).toEqual(before);
    expect(() => notebook.put(entry('item', 'Valid replacement'), id => ({ ...source(id), url: 'x'.repeat(NOTEBOOK_LIMITS.bytes) }), 'Observed value'))
        .toThrow('bytes');
    expect(notebook.toJSON()).toEqual(before);
    let rejected = false;
    for (let i = 0; i < NOTEBOOK_LIMITS.entries; i++) {
        try { notebook.put(entry(`unicode-${i}`, '界'.repeat(NOTEBOOK_LIMITS.text)), source); }
        catch (error) { expect(String(error)).toContain('bytes'); rejected = true; break; }
    }
    expect(rejected).toBe(true);
    expect(notebook.toJSON().length).toBeLessThan(NOTEBOOK_LIMITS.entries);
});

test('invalid content or provenance never replaces a valid note', () => {
    const notebook = new TaskNotebook();
    notebook.put(entry(), source);
    const before = notebook.toJSON();
    for (const input of [entry('', 'fact'), entry('item', ''), entry('item', 'x'.repeat(NOTEBOOK_LIMITS.text + 1)),
        entry('item', 'fact', []), entry('item', 'fact', [-1]), entry('item', 'fact', [0.5]),
        entry('item', 'fact', Array(NOTEBOOK_LIMITS.sources + 1).fill(0))]) {
        expect(noteSchema.safeParse(input).success).toBe(false);
        expect(() => notebook.put(input, source)).toThrow();
    }
    expect(() => notebook.put(entry(), () => { throw new Error('Unobserved source'); }, 'Observed value')).toThrow('Unobserved source');
    expect(notebook.toJSON()).toEqual(before);
    const exported = notebook.toJSON();
    exported[0].sources.push(99);
    expect(notebook.toJSON()).toEqual(before);
});

test('varied add/correct sequences never change omitted records or accept stale corrections', () => {
    let seed = 0x5932;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const notebook = new TaskNotebook();
    const expected = new Map<string, ReturnType<typeof entry>>();
    for (let i = 0; i < NOTEBOOK_LIMITS.entries; i++) {
        const note = entry(`record-${next()}`, `Exact value ${next()}`, [i]);
        notebook.put(note, source);
        expected.set(note.key, note);
    }
    for (let i = 0; i < 100; i++) {
        const old = [...expected.values()][next() % expected.size];
        const corrected = entry(old.key, `Changed value ${next()}`, [next() % NOTEBOOK_LIMITS.entries]);
        expect(() => notebook.put(corrected, source)).toThrow('already exists');
        expect(notebook.toJSON()).toEqual([...expected.values()]);
        notebook.put(corrected, source, old.text);
        expected.set(old.key, corrected);
        expect(() => notebook.put(old, source, old.text)).toThrow('exactly match');
        expect(notebook.toJSON()).toEqual([...expected.values()]);
    }
});
