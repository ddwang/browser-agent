// Loaded only by CLI integration tests, in isolated subprocesses.
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { BrowserBlockedError } from '../../../packages/magnitude-core/src/web/recovery';
import { ActionLimitError } from '../../../packages/magnitude-core/src/agent/errors';
import hardSuite from '../baseline.json';
const spawnProcess = spawn;
const executeFile = execFileSync;

const usage = { llm: { provider: 'anthropic', model: 'fixture' }, inputTokens: 100, outputTokens: 10, inputCost: 0.01, outputCost: 0.07 };
class FakeAgent {
    events = new EventEmitter();
    observations: any[] = [];
    memory = {
        toJSON: async () => ({ observations: [...this.observations] }),
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
        checkCriteria(prompt);
        this.events.emit('planningStarted');
        if (process.env.EVAL_TEST_FAILURE === 'timeout') return new Promise<void>(() => {});
        if (process.env.EVAL_TEST_FAILURE === 'crash') throw new Error('Synthetic browser crash');
        if (process.env.EVAL_TEST_FAILURE === 'blocked') throw new BrowserBlockedError({ reason: 'rate_limit', evidence: 'HTTP 429 fixture' });
        if (process.env.EVAL_TEST_FAILURE === 'action-limit') throw new ActionLimitError(100);
        this.observations.push({ source: 'connector:web', data: 'Earlier evidence', options: { type: 'screenshot', limit: 3, dedupe: true } });
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

mock.module('../../../packages/magnitude-core/src/agent/browserAgent', () => ({ startBrowserAgent: async () => new FakeAgent() }));
mock.module('../../../packages/magnitude-core/src/agent', () => ({ Agent: FakeAgent }));
mock.module('patchright', () => ({ chromium: { launchPersistentContext: async () => ({ close: async () => {} }) } }));
mock.module('node:child_process', () => ({
    execFileSync: executeFile,
    spawn: (command: string, args: string[], options: any) => spawnProcess(command, ['--preload', import.meta.path, ...args], options),
}));
