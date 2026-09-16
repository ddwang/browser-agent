#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { Command, InvalidArgumentError, Option } from 'commander';
import { DEFAULT_LIMITS } from './budget';
import { suiteTasks } from './tasks';
import { DEFAULT_BASETEN_MODEL, validateBasetenOptions } from '../../packages/magnitude-core/src/ai/baseten';
import * as prompts from '@clack/prompts';
import { emptyUsage, outcome, summarize, writeJson, JUDGE_VERSION, type Evaluation, type ModelConfig, type RunManifest, type Task, type TaskRecord, type TaskResult, type TaskProgress } from './results';

const dataPath = join(import.meta.dir, 'data', 'patchedTasks.jsonl');
const defaultActor = 'claude-haiku-4-5-20251001';
const defaultJudge = 'claude-sonnet-5';

function sourceHash() {
    const root = resolve(import.meta.dir, '../..');
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'bun.lock', 'package.json', 'packages/magnitude-core', 'packages/magnitude-extract', 'evals/webvoyager'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
    const hash = createHash('sha256');
    for (const file of files) hash.update(file).update(readFileSync(join(root, file)));
    return hash.digest('hex');
}

function readJson<T>(filename: string): T {
    return JSON.parse(readFileSync(filename, 'utf8'));
}

function readOptional<T>(filename: string): T | undefined {
    return existsSync(filename) ? readJson<T>(filename) : undefined;
}

function loadRecords(runDir: string, manifest: RunManifest): TaskRecord[] {
    return manifest.tasks.map(task => {
        const run = readOptional<TaskResult>(join(runDir, `${task.id}.json`));
        const progress = run?.status === 'running' ? readOptional<TaskProgress>(join(runDir, `${task.id}.status.json`)) : undefined;
        if (run && progress) { run.progress = progress; run.time = progress.updatedAt - progress.startedAt; }
        return { task, run, evaluation: readOptional<Evaluation>(join(runDir, `${task.id}.eval.json`)) };
    });
}

function report(runDir: string, manifest: RunManifest) {
    const records = loadRecords(runDir, manifest);
    const categories = [...new Set(manifest.tasks.map(task => task.web_name))];
    return {
        partition: manifest.partition ?? 'development',
        ...summarize(records),
        categories: Object.fromEntries(categories.map(category => [category, summarize(records.filter(record => record.task.web_name === category))])),
        capabilities: Object.fromEntries([...new Set(manifest.tasks.flatMap(task => task.capabilities ?? []))]
            .map(capability => [capability, summarize(records.filter(record => record.task.capabilities?.includes(capability)))])),
        tasks: records.map(record => ({ id: record.task.id, outcome: outcome(record), timeMs: record.run?.time ?? null, progress: record.run?.progress, block: record.run?.block, budget: record.run?.budget ?? record.evaluation?.budget })),
    };
}

async function checkCredentials(provider: ModelConfig['provider']) {
    if (provider === 'anthropic' || provider === 'openai' || provider === 'baseten') {
        const key = `${provider.toUpperCase()}_API_KEY`;
        if (!process.env[key]) throw new Error(`Set ${key} in your environment or a local .env file before running evals.`);
    } else {
        if (!existsSync(join(homedir(), '.magnitude', 'credentials', 'claudeCode.json'))) {
            throw new Error('Magnitude Claude Code credentials are missing. Authenticate through create-magnitude-app, or use --provider anthropic with ANTHROPIC_API_KEY.');
        }
        // Authenticate once before workers start, avoiding concurrent refreshes and prompts.
        const { completeClaudeCodeAuthFlow } = await import('../../packages/magnitude-core/src/ai/claudeCode');
        await completeClaudeCodeAuthFlow();
    }
}

async function parallel<T>(items: T[], workers: number, work: (item: T) => Promise<void>) {
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
        while (index < items.length) await work(items[index++]);
    }));
}

function positiveInteger(value: string) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new InvalidArgumentError('Expected a positive integer');
    return number;
}

function temperature(value: string) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) throw new InvalidArgumentError('Expected a number from 0 to 1');
    return number;
}

async function selectTasks(input: string | undefined, suite?: string, holdout = false): Promise<Task[]> {
    const allTasks: Task[] = readFileSync(dataPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const reservedSites = new Set(suiteTasks(readJson(join(import.meta.dir, 'holdout.json')), allTasks).map(task => task.web_name));
    const checkReservation = (tasks: Task[]) => {
        if (!holdout && tasks.some(task => reservedSites.has(task.web_name))) {
            throw new Error('Holdout sites are reserved. Use the complete holdout suite with --allow-holdout after freezing the candidate.');
        }
        return tasks;
    };
    if (suite) {
        const selected = suiteTasks(readJson<unknown>(resolve(suite)), allTasks);
        const matching = input ? selected.filter(task => task.id === input || task.web_name === input) : selected;
        if (!matching.length) throw new Error(`Unknown task or category in suite: ${input}`);
        return checkReservation(matching);
    }
    if (input?.includes('--')) {
        const task = allTasks.find(task => task.id === input);
        if (!task) throw new Error(`Unknown task: ${input}`);
        return checkReservation([task]);
    }
    if (input && reservedSites.has(input)) checkReservation(allTasks.filter(task => task.web_name === input));
    const candidates = (input ? allTasks.filter(task => task.web_name === input) : allTasks)
        .filter(task => !reservedSites.has(task.web_name));
    if (!candidates.length) throw new Error(`Unknown category: ${input}`);
    const selected = await prompts.multiselect({
        message: input ? `Select ${input} tasks` : 'Select development tasks (reserved holdout sites excluded; or pass --suite baseline.json)',
        options: candidates.map(task => ({ value: task.id, label: `${task.id}: ${task.ques}` })),
        required: true,
    });
    if (prompts.isCancel(selected)) return [];
    return candidates.filter(task => selected.includes(task.id));
}

async function runWorker(script: string, runDir: string, taskId: string, timeoutMs: number) {
    return new Promise<{ error?: string; timedOut: boolean; exitCode: number | null; signal: string | null }>((resolveWorker) => {
        const child = spawn(process.execPath, [join(import.meta.dir, script), runDir, taskId], { stdio: 'inherit', env: process.env });
        let killed = false;
        let processError: string | undefined;
        const timer = setTimeout(() => {
            killed = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.once('error', error => { processError = error.message; });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            resolveWorker({ timedOut: killed, exitCode: code, signal, error: killed ? 'Worker exceeded process deadline' : processError ?? (code === 0 ? undefined : `Worker exited with code ${code}${signal ? ` (${signal})` : ''}`) });
        });
    });
}

async function runTask(task: Task, runDir: string, manifest: RunManifest) {
    const started = Date.now();
    const resultPath = join(runDir, `${task.id}.json`);
    writeJson(resultPath, { ...emptyUsage(), status: 'running', time: 0, actionCount: 0, memory: null } satisfies TaskResult);
    const worker = await runWorker('wv-runner.ts', runDir, task.id, manifest.timeoutMs + 15_000);
    const previous = readJson<TaskResult>(resultPath);
    if (worker.timedOut || previous.status === 'running' || (worker.error && previous.status === 'completed')) {
        writeJson(resultPath, {
            ...previous,
            status: worker.timedOut ? 'timeout' : 'error',
            timedOut: worker.timedOut,
            time: Date.now() - started,
            error: worker.error ?? 'Worker exited without a final result',
            worker: { exitCode: worker.exitCode, signal: worker.signal, savedStatus: previous.status },
        } satisfies TaskResult);
    }
}

async function scoreTask(task: Task, runDir: string, manifest: RunManifest) {
    const run = readOptional<TaskResult>(join(runDir, `${task.id}.json`));
    if (!run || run.status !== 'completed') return;
    const started = Date.now();
    const evalPath = join(runDir, `${task.id}.eval.json`);
    writeJson(evalPath, { time: 0, usage: emptyUsage() });
    const worker = await runWorker('judge.ts', runDir, task.id, manifest.judgeTimeoutMs);
    let evaluation = readJson<Evaluation>(evalPath);
    if (worker.error || (!evaluation.result && !evaluation.error)) {
        evaluation = { time: Date.now() - started, usage: emptyUsage(), error: worker.error ?? 'Judge exited without a verdict' };
        writeJson(evalPath, evaluation);
    }
    console.log(`${task.id}: ${evaluation.result ?? 'JUDGE ERROR'}`);
}

const program = new Command().name('webvoyager');

program.command('run [input]')
    .description('Run a task, selected category tasks, or a fixed suite')
    .option('--suite <path>', 'JSON file containing taskIds or explicit tasks; input can select a task/site within it')
    .option('--run-dir <path>', 'Results directory (default: a new timestamped directory)')
    .option('-w, --workers <number>', 'Parallel task workers', positiveInteger, 1)
    .option('--model <name>', 'Actor model (default: Haiku 4.5, OpenAI Luna, or Baseten DeepSeek V4.1 Flash)')
    .option('--judge-model <name>', 'Judge model, fixed for comparisons', defaultJudge)
    .option('--judge-max-tokens <number>', 'Judge output budget, including thinking (default: 32768 for Sonnet 5; otherwise transport default)', positiveInteger)
    .addOption(new Option('--provider <name>', 'Actor provider').choices(['anthropic', 'claude-code', 'openai', 'baseten']).default('anthropic'))
    .addOption(new Option('--judge-provider <name>', 'Judge provider (default: anthropic, or claude-code for a Claude Code actor)').choices(['anthropic', 'claude-code']))
    .option('--temperature <number>', 'Actor temperature (default: 0.2 for Claude; omitted for OpenAI and Baseten)', temperature)
    .addOption(new Option('--reasoning-effort <level>', 'OpenAI/Baseten reasoning effort (default: Luna medium, DeepSeek V4.1 Flash high; otherwise API default)').choices(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
    .option('--max-completion-tokens <number>', 'OpenAI actor output limit, including reasoning tokens (default: API default)', positiveInteger)
    .option('--max-tokens <number>', 'Baseten actor output limit, including reasoning tokens (default: API default)', positiveInteger)
    .option('--timeout <seconds>', 'Task timeout, including setup', positiveInteger, 1200)
    .option('--judge-timeout <seconds>', 'Judge process timeout', positiveInteger, 300)
    .option('--max-actions <number>', 'Fail tasks that cannot finish within this many actions', positiveInteger, DEFAULT_LIMITS.maxActions)
    .option('--max-judge-mb <number>', 'Fail saved traces over this many MiB without calling the judge', positiveInteger, DEFAULT_LIMITS.maxJudgeBytes / 1024 / 1024)
    .option('--eval', 'Score each completed task')
    .option('--dry-run', 'Print selected tasks and configuration without running or writing files')
    .option('--allow-holdout', 'Acknowledge one-shot holdout exposure; only use after freezing the candidate')
    .option('--failed', 'Resume unrun and unsuccessful tasks in an explicit --run-dir')
    .option('--failed-only', 'Resume only unsuccessful attempts in an explicit --run-dir')
    .option('--replace', 'Replace selected results in an explicit --run-dir')
    .action(async (input, options) => {
        const holdout = options.suite && readJson<{ partition?: string }>(resolve(options.suite)).partition === 'holdout';
        if (holdout) {
            if (!options.allowHoldout) throw new Error('Holdout is reserved. Freeze the candidate, then use --allow-holdout. See EXPERIMENTS.md.');
            if (input || options.failed || options.failedOnly || options.replace) throw new Error('Holdout runs require the complete suite without selective reruns.');
            if (!options.eval && !options.dryRun) throw new Error('Holdout runs require --eval.');
        }
        const tasks = await selectTasks(input, options.suite, !!holdout);
        if (!tasks.length) return;
        const runDir = resolve(options.runDir ?? join(import.meta.dir, 'results', new Date().toISOString().replaceAll(':', '-')));
        const manifestPath = join(runDir, 'manifest.json');
        if (options.provider !== 'openai' && options.provider !== 'baseten' && options.reasoningEffort !== undefined) {
            throw new Error('--reasoning-effort requires --provider openai or baseten.');
        }
        if (options.provider !== 'openai' && options.maxCompletionTokens !== undefined) {
            throw new Error('--max-completion-tokens requires --provider openai.');
        }
        if (options.provider !== 'baseten' && options.maxTokens !== undefined) {
            throw new Error('--max-tokens requires --provider baseten.');
        }
        const model = options.model ?? (options.provider === 'openai' ? 'gpt-5.6-luna'
            : options.provider === 'baseten' ? DEFAULT_BASETEN_MODEL : defaultActor);
        const reasoningEffort = options.reasoningEffort ?? (options.provider === 'openai' && model === 'gpt-5.6-luna' ? 'medium'
            : options.provider === 'baseten' && model === DEFAULT_BASETEN_MODEL ? 'high' : undefined);
        if (options.provider === 'baseten') validateBasetenOptions({ model, reasoningEffort });
        const actor: ModelConfig = options.provider === 'openai' || options.provider === 'baseten'
            ? { provider: options.provider, model,
                ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
                ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
                ...(options.maxCompletionTokens !== undefined ? { maxCompletionTokens: options.maxCompletionTokens } : {}),
                ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            }
            : { provider: options.provider, model, temperature: options.temperature ?? 0.2 };
        // Sonnet 5 only accepts the API's default sampling temperature (1).
        const judgeMaxTokens = options.judgeMaxTokens ?? (options.judgeModel === defaultJudge ? 32_768 : undefined);
        const judge: ModelConfig = {
            provider: options.judgeProvider ?? (options.provider === 'claude-code' ? 'claude-code' : 'anthropic'),
            model: options.judgeModel,
            temperature: options.judgeModel === 'claude-sonnet-5' ? 1 : 0,
            ...(judgeMaxTokens !== undefined ? { maxTokens: judgeMaxTokens } : {}),
        };
        let manifest: RunManifest = {
            partition: holdout ? 'holdout' : 'development',
            createdAt: new Date().toISOString(),
            revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dir, encoding: 'utf8' }).trim(),
            dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: import.meta.dir, encoding: 'utf8' }).trim(),
            sourceHash: sourceHash(), judgeVersion: JUDGE_VERSION, workers: options.workers,
            actor, judge, timeoutMs: options.timeout * 1000, judgeTimeoutMs: options.judgeTimeout * 1000, tasks,
            limits: { maxActions: options.maxActions, maxJudgeBytes: options.maxJudgeMb * 1024 * 1024 },
        };
        if (options.dryRun) {
            console.log(JSON.stringify({ runDir, ...manifest }, null, 2));
            return;
        }
        if ((options.failed || options.failedOnly || options.replace) && !options.runDir) throw new Error('Resume/replace flags require --run-dir. Omit them for a fresh first-attempt baseline.');
        const previous = readOptional<RunManifest>(manifestPath);
        if (previous?.partition === 'holdout') throw new Error('Holdout runs are immutable. Do not resume or replace their attempts.');
        if (holdout && (manifest.dirty || previous)) throw new Error('Holdout runs require a clean committed candidate and a fresh run directory.');
        if (previous) {
            if (JSON.stringify(previous.actor) !== JSON.stringify(actor) || JSON.stringify(previous.judge) !== JSON.stringify(judge) || previous.workers !== manifest.workers || previous.timeoutMs !== manifest.timeoutMs || previous.judgeTimeoutMs !== manifest.judgeTimeoutMs || previous.sourceHash !== manifest.sourceHash || JSON.stringify(previous.limits ?? DEFAULT_LIMITS) !== JSON.stringify(manifest.limits)) {
                throw new Error('Run configuration differs from its manifest. Use a new --run-dir.');
            }
            const savedTasks = new Set(previous.tasks.map(task => JSON.stringify(task)));
            if (tasks.some(task => !savedTasks.has(JSON.stringify(task)))) throw new Error('Tasks differ from the saved run. Use a new --run-dir.');
            manifest = previous;
        }
        const records = loadRecords(runDir, manifest);
        const selectedIds = new Set(tasks.map(task => task.id));
        const pending = records.filter(record => selectedIds.has(record.task.id) && (
            options.replace || (options.failedOnly ? !!record.run && outcome(record) !== 'success'
                : options.failed ? outcome(record) !== 'success' : !record.run)
        ));
        if (!pending.length) { console.log('No tasks to run. Use a new run directory for another baseline.'); return; }
        await checkCredentials(actor.provider);
        if (options.eval && judge.provider !== actor.provider) await checkCredentials(judge.provider);
        mkdirSync(runDir, { recursive: true });
        if (!previous) writeJson(manifestPath, manifest);
        console.log(`Run directory: ${runDir}\nRunning ${pending.length} tasks with ${options.workers} workers`);
        await parallel(pending, options.workers, async ({ task }) => {
            // An explicit rerun must not retain the previous verdict.
            writeJson(join(runDir, `${task.id}.eval.json`), { time: 0, usage: emptyUsage() });
            await runTask(task, runDir, manifest);
            if (options.eval) await scoreTask(task, runDir, manifest);
            writeJson(join(runDir, 'summary.json'), report(runDir, manifest));
        });
        const summary = report(runDir, manifest);
        console.log(JSON.stringify(summary, null, 2));
        if (summary.counts.error || summary.counts.timeout || summary.counts.blocked || summary.counts.judge_error || summary.counts.failure) process.exitCode = 1;
    });

program.command('eval [input]')
    .description('Score saved completed tasks using the run manifest’s judge')
    .requiredOption('--run-dir <path>', 'Run to evaluate')
    .option('-w, --workers <number>', 'Parallel judges', positiveInteger, 1)
    .option('--replace', 'Replace existing evaluations')
    .action(async (input, options) => {
        const runDir = resolve(options.runDir);
        const manifest = readJson<RunManifest>(join(runDir, 'manifest.json'));
        if (manifest.partition === 'holdout') throw new Error('Holdout evaluations are immutable. Score only during the original complete run --eval.');
        if (manifest.judgeVersion !== JUDGE_VERSION) throw new Error('Judge version differs from the saved run. Use its matching source revision, or start a new run.');
        const records = loadRecords(runDir, manifest).filter(record =>
            (!input || record.task.id === input || record.task.web_name === input)
            && record.run?.status === 'completed'
            && (options.replace || !record.evaluation?.result));
        if (!records.length) { console.log('No tasks to evaluate'); return; }
        await checkCredentials(manifest.judge.provider);
        await parallel(records, options.workers, async ({ task }) => { await scoreTask(task, runDir, manifest); });
        const summary = report(runDir, manifest);
        writeJson(join(runDir, 'summary.json'), summary);
        console.log(JSON.stringify(summary, null, 2));
        if (summary.counts.judge_error) process.exitCode = 1;
    });

program.command('stats')
    .description('Show all selected tasks, including unscored tasks and failures')
    .requiredOption('--run-dir <path>', 'Run to summarize')
    .option('-v, --verbose', 'Include individual task outcomes')
    .action(options => {
        const runDir = resolve(options.runDir);
        const manifest = readJson<RunManifest>(join(runDir, 'manifest.json'));
        const summary = report(runDir, manifest);
        const { tasks, ...totals } = summary;
        console.log(JSON.stringify(options.verbose ? summary : totals, null, 2));
    });

if (import.meta.main) {
    program.parseAsync().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
