import type { BudgetFailure, EvalLimits, TaskResult } from './results';

export const DEFAULT_LIMITS: EvalLimits = { maxActions: 100, maxJudgeBytes: 24 * 1024 * 1024 };

// A policy failure, not an LLM verdict. Leave headroom below the API's 32 MB body
// limit and do not summarize, truncate, or spend judge tokens on oversized runs.
export function checkBudget(run: TaskResult, limits = DEFAULT_LIMITS): BudgetFailure | undefined {
    if (run.actionCount > limits.maxActions) return { kind: 'actions', actual: run.actionCount, limit: limits.maxActions };
    const bytes = Buffer.byteLength(JSON.stringify(run.memory));
    if (bytes > limits.maxJudgeBytes) return { kind: 'payload_bytes', actual: bytes, limit: limits.maxJudgeBytes };
}
