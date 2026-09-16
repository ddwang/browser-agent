import { expect, test } from 'bun:test';
import { suiteTasks, taskPrompt } from './tasks';
import type { Task } from './results';
import baseline from './baseline.json';

const task: Task = { id: 'Example--0', web_name: 'Example', web: 'https://example.com', ques: 'Compare two records.' };

test('ID-only and explicit suites produce independent task definitions', () => {
    expect(suiteTasks({ taskIds: [task.id] }, [task])).toEqual([task]);
    const custom: Task = { ...task, criteria: ['Open both records.'], capabilities: ['comparison'] };
    expect(suiteTasks({ tasks: [custom] }, [])).toEqual([custom]);
});

test.each([
    {}, { taskIds: [] }, { tasks: [] }, { taskIds: [task.id], tasks: [task] },
    { taskIds: [task.id, task.id] }, { taskIds: ['Unknown--0'] },
    { tasks: [task, task] }, { tasks: [{ ...task, id: '../Example--0' }] },
    { tasks: [{ ...task, web: 'file:///private/data' }] },
    { tasks: [{ ...task, ques: ' ' }] }, { tasks: [{ ...task, criteria: [] }] },
    { tasks: [{ ...task, criteria: [' '] }] }, { tasks: [{ ...task, capabilities: ['unknown'] }] },
])('rejects malformed or ambiguous suites: %j', value => {
    expect(() => suiteTasks(value, [task])).toThrow();
});

test('task prompts preserve old tasks and include every custom criterion once', () => {
    expect(taskPrompt(task)).toBe(task.ques);
    const criteria = ['Open both records.', 'Verify all dates.'];
    const prompt = taskPrompt({ ...task, criteria });
    for (const criterion of criteria) expect(prompt.split(criterion)).toHaveLength(2);
    expect(prompt).toContain('all required');
    expect(prompt).toContain('Do not use an API');
});

test('the hard suite covers each capability and avoids legacy task identities', () => {
    const tasks = suiteTasks(baseline, []);
    expect(tasks).toHaveLength(12);
    expect(new Set(tasks.map(task => task.id)).size).toBe(12);
    expect(tasks.every(task => task.id.includes(' Hard--') && task.criteria!.length >= 3)).toBe(true);
    for (const capability of ['constraints', 'comparison', 'stateful', 'extraction'] as const) {
        expect(tasks.filter(task => task.capabilities?.includes(capability)).length).toBeGreaterThanOrEqual(3);
    }
});
