import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson } from './results';

const directory = mkdtempSync(join(tmpdir(), 'magnitude-eval-test-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function cli(args: string[], failure = '') {
    const child = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, 'fixtures/mock-runtime.ts'), join(import.meta.dir, 'wv.ts'), ...args], {
        cwd: directory,
        env: { ...process.env, ANTHROPIC_API_KEY: 'test-only-not-a-real-key', EVAL_TEST_FAILURE: failure },
        stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
}

test('dry run validates the harder suite and preserves its criteria without creating output', async () => {
    const runDir = join(directory, 'dry');
    const result = await cli(['run', '--suite', join(import.meta.dir, 'baseline.json'), '--run-dir', runDir, '--dry-run']);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.tasks).toHaveLength(12);
    expect(new Set(manifest.tasks.map((task: any) => task.web_name)).size).toBe(3);
    expect(manifest.tasks.every((task: any) => task.criteria.length >= 3 && task.capabilities.length >= 2)).toBe(true);
    expect(manifest.actor).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', temperature: 0.2 });
    expect(manifest.judge).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5', temperature: 1 });
    expect(manifest.limits).toEqual({ maxActions: 100, maxJudgeBytes: 24 * 1024 * 1024 });
    expect(existsSync(runDir)).toBe(false);
});

test('legacy smoke and scroll suites still resolve their original tasks', async () => {
    for (const [file, count] of [['smoke.json', 20], ['scroll-baseline.json', 4]] as const) {
        const result = await cli(['run', '--suite', join(import.meta.dir, file), '--dry-run']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).tasks).toHaveLength(count);
    }
});

test('holdout requires explicit exposure and rejects selective runs', async () => {
    const suite = join(import.meta.dir, 'holdout.json');
    const reserved = await cli(['run', '--suite', suite, '--dry-run']);
    expect(reserved.code).toBe(1);
    expect(reserved.stderr).toContain('Holdout is reserved');
    for (const extra of [['Amazon--35'], ['--failed'], ['--failed-only'], ['--replace']]) {
        const result = await cli(['run', ...extra, '--suite', suite, '--allow-holdout', '--dry-run']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('complete suite without selective reruns');
    }
    const preview = await cli(['run', '--suite', suite, '--allow-holdout', '--dry-run']);
    expect(preview.code).toBe(0);
    const manifest = JSON.parse(preview.stdout);
    expect(manifest.partition).toBe('holdout');
    expect(manifest.tasks).toHaveLength(12);
    const unscored = await cli(['run', '--suite', suite, '--allow-holdout']);
    expect(unscored.code).toBe(1);
    expect(unscored.stderr).toContain('require --eval');
});

test('a suite can be narrowed to one custom task or one site', async () => {
    for (const [input, count] of [['ArXiv Hard--0', 1], ['ArXiv', 4]] as const) {
        const result = await cli(['run', input, '--suite', join(import.meta.dir, 'baseline.json'), '--dry-run']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).tasks).toHaveLength(count);
    }
    expect((await cli(['run', 'BBC News--5', '--suite', join(import.meta.dir, 'baseline.json'), '--dry-run'])).code).toBe(1);
});

test('custom criteria reach actor and judge, and capability metrics retain all tasks', async () => {
    const runDir = join(directory, 'criteria');
    const result = await cli(['run', 'ArXiv Hard--0', '--suite', join(import.meta.dir, 'baseline.json'), '--run-dir', runDir, '--eval'], 'criteria');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
    expect(summary.capabilities.constraints.selected).toBe(1);
    expect(summary.capabilities.extraction.counts.success).toBe(1);
    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    expect(manifest.tasks[0].criteria).toHaveLength(3);
});

test('a blocked custom task remains in each relevant capability denominator', async () => {
    const runDir = join(directory, 'criteria-blocked');
    expect((await cli(['run', 'ArXiv Hard--0', '--suite', join(import.meta.dir, 'baseline.json'), '--run-dir', runDir, '--eval'], 'blocked')).code).toBe(1);
    const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
    for (const capability of ['constraints', 'extraction']) {
        expect(summary.capabilities[capability].selected).toBe(1);
        expect(summary.capabilities[capability].counts.blocked).toBe(1);
        expect(summary.capabilities[capability].successRate).toBe(0);
    }
});

test('resume rejects changed criteria even when task IDs and source hash match', async () => {
    const runDir = join(directory, 'changed-criteria');
    const args = ['run', 'ArXiv Hard--0', '--suite', join(import.meta.dir, 'baseline.json'), '--run-dir', runDir];
    expect((await cli(args)).code).toBe(0);
    const path = join(runDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.tasks[0].criteria = ['A different task with the same ID.'];
    writeJson(path, manifest);
    const result = await cli(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Tasks differ from the saved run');
});

test('other judge models retain temperature zero', async () => {
    const result = await cli(['run', 'Allrecipes--0', '--judge-model', 'claude-sonnet-4-5-20250929', '--dry-run']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).judge).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', temperature: 0 });
});

test('action and judge payload budgets are configurable and recorded', async () => {
    const result = await cli(['run', 'Allrecipes--0', '--max-actions', '50', '--max-judge-mb', '8', '--dry-run']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).limits).toEqual({ maxActions: 50, maxJudgeBytes: 8 * 1024 * 1024 });
});

test('run --eval preserves earlier evidence for judging and the saved final answer, then stats reads the complete manifest', async () => {
    const runDir = join(directory, 'success');
    const result = await cli(['run', 'Allrecipes--0', '--run-dir', runDir, '--eval']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const task = JSON.parse(readFileSync(join(runDir, 'Allrecipes--0.json'), 'utf8'));
    // Judge-only retention changes must not mutate the saved actor history.
    expect(task.memory.observations[0].options.limit).toBe(3);
    expect(task.memory.observations.at(-1).source).toBe('action:taken:answer');
    expect(task.totalOutputCost).toBe(0.07);
    expect(task.progress.phase).toBe('finished');
    expect(result.stdout).toContain('[Allrecipes--0] planning');
    expect(result.stdout).toContain('[Allrecipes--0] acting (answer)');
    expect(JSON.parse(readFileSync(join(runDir, 'Allrecipes--0.status.json'), 'utf8')).phase).toBe('finished');
    const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
    expect(summary.counts.success).toBe(1);
    expect(summary.estimatedActorCost).toBeCloseTo(0.08);
    expect(summary.estimatedJudgeCost).toBeCloseTo(0.08);
    const stats = await cli(['stats', '--run-dir', runDir]);
    expect(JSON.parse(stats.stdout).successRate).toBe(1);
});

test.each(['crash', 'timeout', 'judge', 'judge-timeout', 'blocked', 'action-limit'])('%s remains in the denominator with a distinct outcome', async failure => {
    const runDir = join(directory, failure);
    const result = await cli(['run', 'Allrecipes--0', '--run-dir', runDir, '--eval', '--timeout', '1', '--judge-timeout', '1'], failure);
    expect(result.code).toBe(1);
    const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
    expect(summary.selected).toBe(1);
    expect(summary.successRate).toBe(0);
    expect(summary.counts[failure === 'crash' ? 'error' : failure.startsWith('judge') ? 'judge_error' : failure === 'action-limit' ? 'failure' : failure]).toBe(1);
});

test('run without --eval remains unscored and the separate eval command scores it', async () => {
    const runDir = join(directory, 'separate');
    expect((await cli(['run', 'Allrecipes--0', '--run-dir', runDir])).code).toBe(0);
    let summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
    expect(summary.counts.unscored).toBe(1);
    expect((await cli(['eval', '--run-dir', runDir])).code).toBe(0);
    summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
    expect(summary.counts.success).toBe(1);
});

test('oversized histories fail without calling the judge', async () => {
    const runDir = join(directory, 'payload-limit');
    expect((await cli(['run', 'Allrecipes--0', '--run-dir', runDir, '--eval', '--max-judge-mb', '1'], 'payload-limit')).code).toBe(1);
    const evaluation = JSON.parse(readFileSync(join(runDir, 'Allrecipes--0.eval.json'), 'utf8'));
    expect(evaluation.result).toBe('NOT SUCCESS');
    expect(evaluation.budget.kind).toBe('payload_bytes');
    expect(evaluation.usage.modelCalls).toBe(0);
    expect(evaluation.usage.totalOutputCost).toBe(0);
});

test('invalid workers and unknown task IDs fail before creating output', async () => {
    expect((await cli(['run', 'Allrecipes--0', '--workers', '0', '--dry-run'])).code).toBe(1);
    expect((await cli(['run', 'Unknown--0', '--dry-run'])).code).toBe(1);
});
