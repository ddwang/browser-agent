// Loaded only by CLI integration tests, in isolated subprocesses.
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { BrowserBlockedError } from '../../../packages/magnitude-core/src/web/recovery';
import { ActionLimitError } from '../../../packages/magnitude-core/src/agent/errors';
import hardSuite from '../baseline.json';
import assert from 'node:assert/strict';
const spawnProcess = spawn;
const executeFile = execFileSync;

const usage = { llm: { provider: 'anthropic', model: 'fixture' }, inputTokens: 100, outputTokens: 10, inputCost: 0.01, outputCost: 0.07 };
class FakeAgent {
    constructor(private options?: any) {}
    events = new EventEmitter();
    observations: any[] = [];
    memory = {
        toJSON: async () => {
            const observations = [...this.observations];
            if (process.env.EVAL_TEST_FAILURE === 'long-history') await Bun.sleep(2);
            return { observations };
        },
        loadJSON: async (memory: { observations: any[] }) => {
            if (memory.observations.some(observation => observation.options?.limit !== undefined)) {
                throw new Error('Judge inherited actor retention limits');
            }
            if (!JSON.stringify(memory.observations[0]?.data).includes('Earlier evidence')) throw new Error('Judge lost earlier evidence');
        },
    };
    async start() {}
    getConnector() { return undefined; }
    async stop() {}
    async act(prompt: string) {
        if (process.env.EVAL_TEST_FAILURE === 'mixed-providers') assert.deepEqual(this.options.llm, {
            provider: 'openai', options: { model: 'gpt-5.6-luna', reasoningEffort: 'medium', maxCompletionTokens: 8192 },
        });
        checkCriteria(prompt);
        this.events.emit('planningStarted');
        if (process.env.EVAL_TEST_FAILURE === 'timeout') return new Promise<void>(() => {});
        if (process.env.EVAL_TEST_FAILURE === 'crash') throw new Error('Synthetic browser crash');
        if (process.env.EVAL_TEST_FAILURE === 'unfinished') process.exit(0);
        if (process.env.EVAL_TEST_FAILURE === 'blocked') throw new BrowserBlockedError({ reason: 'rate_limit', evidence: 'HTTP 429 fixture' });
        if (process.env.EVAL_TEST_FAILURE === 'action-limit') throw new ActionLimitError(100);
        this.observations.push({ source: 'connector:web', data: 'Earlier evidence', options: { type: 'screenshot', limit: 3, dedupe: true } });
        if (process.env.EVAL_TEST_FAILURE === 'long-history') {
            this.observations.push({ source: 'connector:web', data: { type: 'primitive', content: 'x'.repeat(21 * 1024 * 1024) } });
            for (let i = 0; i < 95; i++) {
                this.events.emit('actionStarted', { variant: 'fixture:tick' });
                this.events.emit('actionDone');
                this.observations.push({ source: 'action:taken:fixture:tick', data: `Synthetic step ${i}` });
                this.events.emit('observationsRecorded');
                await Bun.sleep(1);
            }
        }
        if (process.env.EVAL_TEST_FAILURE === 'payload-limit') {
            this.observations.push({ source: 'connector:web', role: 'user', timestamp: 0, data: { type: 'primitive', content: 'x'.repeat(2 * 1024 * 1024) } });
        }
        this.events.emit('tokensUsed', usage);
        this.events.emit('actionStarted', { variant: 'answer' });
        this.events.emit('actionDone');
        // Match the real agent: observations are recorded after actionDone fires.
        this.observations.push({ source: 'action:taken:answer', data: 'Observed answer' });
        this.events.emit('observationsRecorded');
    }
    async query(prompt: string) {
        if (process.env.EVAL_TEST_FAILURE === 'mixed-providers') assert.deepEqual(this.options.llm, {
            provider: 'anthropic', options: { model: 'claude-sonnet-5', temperature: 1 },
        });
        checkCriteria(prompt);
        if (process.env.EVAL_TEST_FAILURE === 'judge-timeout') return new Promise<void>(() => {});
        if (process.env.EVAL_TEST_FAILURE === 'judge') throw new Error('Synthetic judge failure');
        this.events.emit('tokensUsed', usage);
        return { result: 'SUCCESS', reasoning: 'Synthetic evidence' };
    }
}

function checkCriteria(prompt: string) {
    if (process.env.EVAL_TEST_FAILURE === 'criteria' && !hardSuite.tasks[0].criteria.every(criterion => prompt.includes(criterion))) {
        throw new Error('Acceptance criteria did not reach the model');
    }
}

mock.module('../../../packages/magnitude-core/src/agent/browserAgent', () => ({ startBrowserAgent: async (options: any) => new FakeAgent(options) }));
mock.module('../../../packages/magnitude-core/src/agent', () => ({ Agent: FakeAgent }));
mock.module('patchright', () => ({ chromium: { launchPersistentContext: async () => ({ close: async () => {} }) } }));
mock.module('node:child_process', () => ({
    execFileSync: executeFile,
    spawn: (command: string, args: string[], options: any) => spawnProcess(command, ['--preload', import.meta.path, ...args], options),
}));
