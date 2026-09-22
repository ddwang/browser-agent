import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserAgent } from '../../packages/magnitude-core/src/agent/browserAgent';
import { GroundedControls } from '../../packages/magnitude-core/src/web/groundedControls';
import type { PlannerResponse } from '../../packages/magnitude-core/src/ai/plannerResponse';
import { checkOperation } from '../../packages/magnitude-core/src/common/operation';

export interface PlannerDecision {
    index: number;
    phase: 'login' | 'task';
    task: string;
    image?: string;
    context: {
        instructions?: string | null;
        connectorInstructions: { connectorId: string; instructions: string }[];
        observationContent: { role: string; content: (string | { image: 'omitted' })[] }[];
    };
    controls?: Awaited<ReturnType<GroundedControls['observe']>>;
    controlsError?: string;
    elapsedMs: number;
    response?: PlannerResponse;
    error?: string;
}

/** Synthetic evaluator only. Sidecar controls never enter the actor's prompt or execute input. */
export function tracePlanner(agent: BrowserAgent, directory: string, latestImage: () => string | undefined,
    phase: () => PlannerDecision['phase'], overhead: (ms: number) => void) {
    const plan = agent.models.partialAct.bind(agent.models);
    let index = 0;
    agent.models.partialAct = async (...args) => {
        const [context, task] = args;
        let started = performance.now();
        const row: PlannerDecision = {
            index: index++, phase: phase(), task, image: latestImage(), elapsedMs: 0,
            context: {
                instructions: context.instructions, connectorInstructions: context.connectorInstructions,
                observationContent: context.observationContent.map(message => ({ role: message.role,
                    // Native BAML images are opaque under Bun. Keep the text intact;
                    // the current screenshot is linked separately, not reconstructed.
                    content: message.content.map(part => typeof part === 'string' ? part : { image: 'omitted' }),
                })),
            },
        };
        const controls = new GroundedControls();
        try { row.controls = await controls.observe(agent.page); }
        catch (error) { row.controlsError = error instanceof Error ? error.name : 'Unknown error'; }
        finally { await controls.clear().catch(() => { row.controlsError ??= 'dispose_failed'; }); }
        // Persist inputs before inference; killed/failed attempts remain in the audit.
        appendFileSync(join(directory, 'decisions.jsonl'), JSON.stringify({ event: 'started', ...row }) + '\n');
        overhead(performance.now() - started);
        started = performance.now();
        try {
            checkOperation();
            const response = await plan(...args);
            row.response = response;
            return response;
        } catch (error) {
            row.error = error instanceof Error ? error.name : 'Unknown error';
            throw error;
        } finally {
            row.elapsedMs = performance.now() - started;
            const savedAt = performance.now();
            appendFileSync(join(directory, 'decisions.jsonl'), JSON.stringify({ event: 'finished', index: row.index,
                elapsedMs: row.elapsedMs, response: row.response, error: row.error }) + '\n');
            overhead(performance.now() - savedAt);
        }
    };
}
