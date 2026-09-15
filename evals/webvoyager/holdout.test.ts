import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { suiteTasks } from './tasks';
import type { Task } from './results';

const read = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('holdout selection and task contents stay frozen and disjoint from development sites', () => {
    const suite = JSON.parse(read('holdout.json'));
    const raw = read('data/patchedTasks.jsonl');
    const catalog: Task[] = raw.trim().split('\n').map(line => JSON.parse(line));
    const tasks = suiteTasks(suite, catalog);
    expect(suite.partition).toBe('holdout');
    expect(tasks).toHaveLength(12);
    expect(digest(raw)).toBe(suite.selection.catalogSha256);
    expect(digest(JSON.stringify(tasks))).toBe(suite.selection.tasksSha256);
    const development = [
        ...suiteTasks(JSON.parse(read('baseline.json')), catalog),
        ...suiteTasks(JSON.parse(read('smoke.json')), catalog),
        ...suiteTasks(JSON.parse(read('scroll-baseline.json')), catalog),
    ];
    const excluded = new RegExp(suite.selection.exclusionPattern, 'i');
    const expected = suite.selection.sites.flatMap((site: string) => catalog
        .filter(task => task.web_name === site && !excluded.test(task.ques))
        .sort((a, b) => digest(`${suite.selection.seed}\n${a.id}`).localeCompare(digest(`${suite.selection.seed}\n${b.id}`)))
        .slice(0, suite.selection.perSite).map(task => task.id));
    expect(tasks.map(task => task.id)).toEqual(expected);
    for (const task of tasks) {
        expect(development.some(seen => seen.id === task.id || seen.web_name === task.web_name)).toBe(false);
        expect(excluded.test(task.ques)).toBe(false);
    }
});
