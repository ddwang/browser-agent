import type { ModelUsage, OpenAIClient } from '../../packages/magnitude-core/src/ai/types';
import type { SerializedAgentMemory } from '../../packages/magnitude-core/src/memory/agentMemory';
import { renameSync, writeFileSync } from 'node:fs';
import type { BrowserBlock, HttpDiagnostic } from '../../packages/magnitude-core/src/web/recovery';
import type { OperationDiagnostics, OperationPhase } from '../../packages/magnitude-core/src/common/operation';
import type { Agent } from '../../packages/magnitude-core/src/agent';

export const JUDGE_VERSION = 4;

export function isTaskResultFile(file: string): boolean {
    return file.endsWith('.json') && !file.endsWith('.eval.json') && !file.endsWith('.status.json')
        && file !== 'manifest.json' && file !== 'summary.json';
}

// Readers can inspect a run while a worker saves a large screenshot history.
export function writeJson(filename: string, data: unknown) {
    const temporary = `${filename}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(data, null, 2));
    renameSync(temporary, filename);
}

export interface Task {
    web_name: string;
    id: string;
    ques: string;
    web: string;
    criteria?: string[];
    capabilities?: ('constraints' | 'comparison' | 'stateful' | 'extraction')[];
}

export interface ModelConfig {
    provider: 'anthropic' | 'claude-code' | 'openai' | 'baseten';
    model: string;
    temperature?: number;
    reasoningEffort?: OpenAIClient['options']['reasoningEffort'];
    maxCompletionTokens?: number;
    maxTokens?: number;
}

export interface RunManifest {
    partition?: 'development' | 'holdout';
    createdAt: string;
    revision: string;
    dirty: boolean;
    sourceHash: string;
    judgeVersion: number;
    workers: number;
    actor: ModelConfig;
    judge: ModelConfig;
    timeoutMs: number;
    judgeTimeoutMs: number;
    tasks: Task[];
    limits?: EvalLimits;
}

export interface EvalLimits { maxActions: number; maxJudgeBytes: number; }
export interface BudgetFailure { kind: 'actions' | 'payload_bytes'; actual: number; limit: number; }

export function emptyUsage() {
    return {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        totalInputCost: 0 as number | null,
        totalOutputCost: 0 as number | null,
        modelCalls: 0,
    };
}

export function addUsage(totals: ReturnType<typeof emptyUsage>, usage: ModelUsage) {
    totals.totalInputTokens += usage.inputTokens;
    totals.totalOutputTokens += usage.outputTokens;
    totals.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    totals.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
    totals.totalInputCost = totals.totalInputCost !== null && usage.inputCost !== undefined
        ? totals.totalInputCost + usage.inputCost : null;
    totals.totalOutputCost = totals.totalOutputCost !== null && usage.outputCost !== undefined
        ? totals.totalOutputCost + usage.outputCost : null;
    totals.modelCalls++;
}

export interface TaskResult extends ReturnType<typeof emptyUsage> {
    status: 'running' | 'completed' | 'error' | 'timeout' | 'blocked' | 'failed' | 'cancelled';
    time: number;
    actionCount: number;
    memory: SerializedAgentMemory | null;
    error?: string;
    timedOut?: boolean;
    progress?: TaskProgress;
    operation?: OperationDiagnostics;
    failureOperation?: OperationDiagnostics;
    cleanup?: { status: 'pending' | 'settled' | 'timed_out'; elapsedMs: number };
    block?: BrowserBlock;
    budget?: BudgetFailure;
    worker?: { exitCode: number | null; signal: string | null; savedStatus: TaskResult['status'] };
}

export interface TaskProgress {
    startedAt: number;
    updatedAt: number;
    phase: 'starting' | 'planning' | 'acting' | 'observing' | 'waiting' | 'finished';
    action?: string;
    phaseStartedAt: number;
    waitUntil?: number;
    block?: BrowserBlock;
    network: HttpDiagnostic[];
    operation?: OperationDiagnostics;
    lifecycle?: Agent['lifecycle'];
    busy?: boolean;
}

export interface Evaluation {
    result?: 'SUCCESS' | 'NOT SUCCESS';
    reasoning?: string;
    error?: string;
    time: number;
    usage: ReturnType<typeof emptyUsage>;
    budget?: BudgetFailure;
}

export interface TaskRecord {
    task: Task;
    run?: TaskResult;
    evaluation?: Evaluation;
}

export function outcome({ run, evaluation }: Pick<TaskRecord, 'run' | 'evaluation'>) {
    if (!run) return 'pending';
    if (run.status === 'cancelled') return 'interrupted';
    if (run.status === 'blocked') return 'blocked';
    if (run.status === 'failed') return 'failure';
    if (run.timedOut || run.status === 'timeout') return 'timeout';
    if (run.error || run.status === 'error') return 'error';
    if (run.status === 'running') return run.progress && Date.now() - run.progress.updatedAt < 15_000 ? 'running' : 'interrupted';
    if (evaluation?.error) return 'judge_error';
    if (evaluation?.result === 'SUCCESS') return 'success';
    if (evaluation?.result === 'NOT SUCCESS') return 'failure';
    return 'unscored';
}

// Nearest-rank percentile; include unsuccessful attempts in latency measurements.
export function percentile(values: number[], fraction: number): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarize(records: TaskRecord[]) {
    const counts = { success: 0, failure: 0, timeout: 0, error: 0, blocked: 0, running: 0, interrupted: 0, judge_error: 0, unscored: 0, pending: 0 };
    const times: number[] = [];
    let actions = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let actorCost: number | null = 0;
    let judgeCost: number | null = 0;
    for (const record of records) {
        counts[outcome(record)]++;
        if (record.run) {
            times.push(record.run.time);
            actions += record.run.actionCount;
            inputTokens += record.run.totalInputTokens;
            outputTokens += record.run.totalOutputTokens;
            cachedInputTokens += (record.run.cacheReadInputTokens ?? 0) + (record.run.cacheWriteInputTokens ?? 0);
            const { totalInputCost, totalOutputCost } = record.run;
            actorCost = actorCost !== null && totalInputCost != null && totalOutputCost != null
                ? actorCost + totalInputCost + totalOutputCost : null;
        }
        if (record.evaluation) {
            const usage = record.evaluation.usage;
            judgeCost = judgeCost !== null && usage?.totalInputCost != null && usage?.totalOutputCost != null
                ? judgeCost + usage.totalInputCost + usage.totalOutputCost : null;
        }
    }
    return {
        selected: records.length,
        attempted: times.length,
        counts,
        successRate: records.length ? counts.success / records.length : null,
        medianTimeMs: percentile(times, 0.5),
        p95TimeMs: percentile(times, 0.95),
        averageActions: times.length ? actions / times.length : null,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        estimatedActorCost: actorCost,
        estimatedJudgeCost: judgeCost,
        operations: summarizeOperations(records),
    };
}

function summarizeOperations(records: TaskRecord[]) {
    const operations = records.flatMap(({ run }) => {
        const operation = run?.operation ?? run?.progress?.operation;
        return operation ? [operation] : [];
    });
    const distribution = (values: number[]) => ({
        samples: values.length, totalMs: values.reduce((total, value) => total + value, 0),
        medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
    });
    const phases = [...new Set(operations.flatMap(operation => Object.keys(operation.timings)))] as OperationPhase[];
    return {
        measuredTasks: operations.length,
        finishedTasks: operations.filter(operation => operation.status === 'finished').length,
        // Inclusive per-task totals, including unsuccessful and partially drained operations.
        timings: Object.fromEntries(phases.map(phase => {
            const timings = operations.flatMap(operation => operation.timings[phase] ? [operation.timings[phase]!] : []);
            return [phase, { ...distribution(timings.map(timing => timing.totalMs)), count: timings.reduce((total, timing) => total + timing.count, 0) }];
        })),
        cancellationToDrain: distribution(operations.flatMap(operation => operation.cancellationToDrainMs === undefined ? [] : [operation.cancellationToDrainMs])),
        cancellationToIdle: distribution(operations.flatMap(operation => operation.cancellationToIdleMs === undefined ? [] : [operation.cancellationToIdleMs])),
    };
}
