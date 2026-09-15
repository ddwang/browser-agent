import z from 'zod';
import type { Task } from './results';

const text = z.string().trim().min(1);
const taskSchema = z.object({
    id: text.regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*--[0-9]+$/, 'Use a filename-safe task ID ending in --number'),
    web_name: text,
    web: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Expected an HTTP(S) URL'),
    ques: text,
    criteria: z.array(text).min(1).optional(),
    capabilities: z.array(z.enum(['constraints', 'comparison', 'stateful', 'extraction'])).min(1).optional(),
});

// Preserve ID-only WebVoyager suites, while allowing independent, explicit tasks.
export function suiteTasks(value: unknown, catalog: Task[]): Task[] {
    const suite = z.object({
        taskIds: z.array(text).min(1).optional(),
        tasks: z.array(taskSchema).min(1).optional(),
    }).refine(value => !!value.taskIds !== !!value.tasks, 'Provide exactly one of taskIds or tasks').parse(value);
    const byId = new Map(catalog.map(task => [task.id, task]));
    const tasks = suite.tasks ?? suite.taskIds!.map(id => {
        const task = byId.get(id);
        if (!task) throw new Error(`Unknown task in suite: ${id}`);
        return task;
    });
    if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Suite task IDs must be unique');
    return tasks;
}

// Both actor and judge receive the same requirements. Criteria are not answer keys.
export function taskPrompt(task: Task): string {
    if (!task.criteria?.length) return task.ques;
    return `${task.ques}\n\nAcceptance criteria (all required):\n${task.criteria.map((criterion, i) => `${i + 1}. ${criterion}`).join('\n')}\n\nUse observed browser evidence and include source URLs. Do not use an API, execute code, change an account, or bypass an access barrier. Report a barrier instead of guessing unavailable information.`;
}
