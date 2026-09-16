#!/usr/bin/env bun
import { startBrowserAgent, type BrowserAgent } from '../../packages/magnitude-core/src/agent/browserAgent';
import { createAction } from '../../packages/magnitude-core/src/actions';
import { chromium, type BrowserContext } from 'patchright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import z from 'zod';
import { addUsage, emptyUsage, writeJson, type RunManifest, type TaskResult, type TaskProgress } from './results';
import { BrowserConnector } from '../../packages/magnitude-core/src/connectors/browserConnector';
import { BrowserBlockedError, type BrowserBlock } from '../../packages/magnitude-core/src/web/recovery';
import { ActionLimitError } from '../../packages/magnitude-core/src/agent/errors';
import { DEFAULT_LIMITS } from './budget';
import { taskPrompt } from './tasks';
import { checkpointWriter } from './checkpoint';

// One process and one attempt per task. The parent enforces a final process deadline.
async function main() {
    const [runDir, taskId] = process.argv.slice(2);
    if (!runDir || !taskId) throw new Error('Run directory and task ID are required');
    const manifest: RunManifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    const selectedTask = manifest.tasks.find(task => task.id === taskId);
    if (!selectedTask) throw new Error(`Unknown task: ${taskId}`);
    const task = selectedTask;

    const started = Date.now();
    const usage = emptyUsage();
    let context: BrowserContext | undefined;
    let agent: BrowserAgent | undefined;
    let actionCount = 0;
    let status: TaskResult['status'] = 'running';
    let error: string | undefined;
    let block: BrowserBlock | undefined;
    let budget: TaskResult['budget'];
    let progress: TaskProgress = { startedAt: started, updatedAt: started, phase: 'starting', phaseStartedAt: started, network: [] };
    let lastLog = '';

    function setPhase(phase: TaskProgress['phase'], action?: string) {
        progress = { ...progress, phase, action, phaseStartedAt: Date.now(), waitUntil: undefined };
        saveProgress();
    }

    function saveProgress() {
        const connector = agent?.getConnector(BrowserConnector);
        const waitUntil = status === 'running' ? connector?.recovery.waitUntil : undefined;
        const snapshot: TaskProgress = {
            ...progress, updatedAt: Date.now(),
            phase: waitUntil ? 'waiting' : progress.phase,
            waitUntil,
            block: block ?? connector?.recovery.block,
            network: [...(connector?.network ?? [])],
        };
        writeJson(join(runDir, `${task.id}.status.json`), snapshot);
        const label = `${snapshot.phase}${snapshot.action ? ` (${snapshot.action})` : ''}${waitUntil ? ` until ${new Date(waitUntil).toISOString()}` : ''}${snapshot.block ? ` [${snapshot.block.reason}]` : ''}`;
        if (label !== lastLog) { console.log(`[${task.id}] ${label}`); lastLog = label; }
        return snapshot;
    }

    async function save() {
        const memory = agent ? await agent.memory.toJSON() : null;
        const result: TaskResult = {
            ...usage,
            status,
            time: Date.now() - started,
            actionCount,
            memory,
            progress: saveProgress(),
            ...(block ? { block } : {}),
            ...(budget ? { budget } : {}),
            ...(error ? { error, timedOut: status === 'timeout' } : {}),
        };
        writeJson(join(runDir, `${task.id}.json`), result);
    }

    const checkpoints = checkpointWriter(save, err => console.error(`[${task.id}] Checkpoint write failed: ${err}`));

    async function execute() {
        context = await chromium.launchPersistentContext('', {
            channel: 'chrome',
            headless: false,
            viewport: { width: 1024, height: 768 },
            deviceScaleFactor: process.platform === 'darwin' ? 2 : 1,
        });
        const { provider, ...modelOptions } = manifest.actor;
        agent = await startBrowserAgent({
            browser: { context },
            llm: { provider, options: modelOptions },
            telemetry: false,
            url: task.web,
            actions: [createAction({
                name: 'answer',
                description: 'Give the final answer, supported by what you observed on the website',
                schema: z.string(),
                resolver: async ({ agent }) => { await agent.queueDone(); },
            })],
            narrate: true,
            prompt: `Satisfy the task criteria precisely. If a sequence fails, try one action at a time. Today is ${manifest.createdAt.slice(0, 10)}.`,
            minScreenshots: 3,
            recovery: { noProgress: true },
            maxActions: (manifest.limits ?? DEFAULT_LIMITS).maxActions,
        });
        agent.events.on('tokensUsed', (event) => addUsage(usage, event));
        agent.events.on('planningStarted', () => setPhase('planning'));
        agent.events.on('actionStarted', action => setPhase('acting', action.variant));
        agent.events.on('actionDone', () => {
            actionCount++;
            setPhase('observing');
        });
        agent.events.on('observationsRecorded', checkpoints.request);
        await agent.act(taskPrompt(task));
    }

    await save(); // Even a launch failure is an attempted task.
    // A small sidecar avoids repeatedly serializing a growing screenshot history.
    const heartbeat = setInterval(() => {
        try { saveProgress(); } catch (err) { console.error(`[${task.id}] Status write failed: ${err}`); }
    }, 2000);
    const timeoutError = new Error(`Task timed out after ${manifest.timeoutMs / 1000} seconds`);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            execute(),
            new Promise<never>((_, reject) => {
                deadline = setTimeout(() => {
                    reject(timeoutError);
                }, manifest.timeoutMs);
            }),
        ]);
        status = 'completed';
    } catch (err) {
        block = err instanceof BrowserBlockedError ? err.block : undefined;
        budget = err instanceof ActionLimitError ? { kind: 'actions', actual: actionCount, limit: err.limit } : undefined;
        status = budget ? 'failed' : block ? 'blocked' : err === timeoutError ? 'timeout' : 'error';
        error = err instanceof Error ? err.message : String(err);
        console.error(`[${task.id}] ${error}`);
    } finally {
        clearTimeout(deadline);
        clearInterval(heartbeat);
        try {
            setPhase('finished');
            await checkpoints.finish();
        } finally {
            // Cleanup cannot change a durably saved task outcome. Attempt both
            // resources even if one rejects or hangs, including after save failure.
            let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
            try {
                const clean = async (name: string, stop: () => Promise<unknown>) => {
                    try { await stop(); }
                    catch (err) { console.error(`[${task.id}] ${name} cleanup failed: ${err}`); }
                };
                await Promise.race([
                    Promise.all([clean('Agent', async () => agent?.stop()), clean('Browser', async () => context?.close())]),
                    new Promise<void>(resolve => { cleanupDeadline = setTimeout(() => {
                        console.error(`[${task.id}] Cleanup exceeded 5 seconds`);
                        resolve();
                    }, 5000); }),
                ]);
            } finally { clearTimeout(cleanupDeadline); }
        }
    }
    return status === 'completed' ? 0 : 1;
}

if (import.meta.main) {
    main().then(code => process.exit(code)).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
