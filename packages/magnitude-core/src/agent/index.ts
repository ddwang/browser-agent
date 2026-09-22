import logger from '@/logger';
import EventEmitter from "eventemitter3";
import z from "zod";

import { Action } from "@/actions/types";
import { ModelHarness } from "@/ai/modelHarness";
import { AgentEvents } from "@/common/events";
import { AgentConnector } from '@/connectors';
import { Observation, RenderableContent } from '@/memory/observation';
import { LLMClient } from "@/ai/types";
import { ActionLimitError, AgentBusyError, AgentError } from "@/agent/errors";
import {
    Operation, attachOperationDiagnostics, checkOperation, currentOperation, measureOperation,
    operationOptions, untilAborted, withoutOperation,
    type OperationDiagnostics, type OperationKind, type OperationOptions,
} from '@/common/operation';
import { AgentMemory, AgentMemoryOptions, MemoryRenderOptions } from "@/memory";
import { ActionDefinition } from "@/actions";
import { taskActions } from "@/actions/taskActions";
import { memoryActions } from '@/actions/memoryActions';
import { NOTEBOOK_INSTRUCTIONS, type NoteUpdate } from '@/memory/notebook';
import { ConnectorInstructions, AgentContext, traceAsync, MultiMediaContentPart } from "@/ai/baml_client";
import { telemetrifyAgent } from '@/telemetry/events';
import { isClaude } from '@/ai/util';
import { retryOnError } from '@/common';
import { renderContentParts } from '@/memory/rendering';
import { MultiModelHarness } from '@/ai/multiModelHarness';
import { GROUNDED_CLICK_REJECTED } from '@/web/groundedControls';


export interface AgentOptions {
    llm?: LLMClient | LLMClient[];
    connectors?: AgentConnector[];
    actions?: ActionDefinition<any>[]; // any additional actions not provided by connectors
    prompt?: string | null; // additional agent-level system prompt instructions
    telemetry?: boolean;
    maxActions?: number;
    //executor?: GroundingClient;
}

export interface ActOptions extends OperationOptions {
    prompt?: string // additional task-level system prompt instructions
    // TODO: reimpl, or maybe for tc agent specifically
	data?: RenderableContent,//string | Record<string, string>
    memory?: AgentMemory,// optional memory starting point
}

// Options for the startAgent helper function

const DEFAULT_CONFIG: Required<Omit<AgentOptions, 'actions'> & { actions: ActionDefinition<any>[] }> = {
    actions: [...taskActions], // Default to taskActions; other actions come from connectors
    connectors: [],
    llm: {
        provider: 'google-ai',
        options: {
            model: 'gemini-2.5-pro-preview-05-06',
            apiKey: process.env.GOOGLE_API_KEY || "YOUR_GOOGLE_API_KEY"
        }
    } as LLMClient,
    prompt: null,
    telemetry: true,
    maxActions: Infinity,
};

export class Agent {
    // maybe remove conns/actions from options since stored sep
    private options: Required<AgentOptions>//Omit<Required<AgentOptions>, 'actions'>;
    private connectors: AgentConnector[];
    private actions: ActionDefinition<any>[]; // actions from connectors + any other additional ones configured

    private memoryOptions: AgentMemoryOptions;

    public readonly models: MultiModelHarness;

    //public readonly model: ModelHarness;
    //public readonly micro: GroundingService;
    //public readonly events: EventEmitter<AgentEvents>;

    //protected readonly _emitter: EventEmitter<AgentEvents>;
    public readonly events: EventEmitter<AgentEvents> = new EventEmitter();
    
    //public readonly memory: AgentMemory;
    private doneActing: boolean;
    private _paused: boolean = false;
    private _pauseResolve: (() => void) | null = null;
    private activeOperation?: Operation;
    private latestOperation?: Operation;
    private idle: Promise<void> = Promise.resolve();
    private resolveIdle?: () => void;
    private pendingWork = 0;
    private lifecycleTail: Promise<void> = Promise.resolve();
    private lifecycleRequest?: { kind: 'start' | 'stop'; promise: Promise<void> };
    private lifecycleState: 'new' | 'starting' | 'ready' | 'stopping' | 'stopped' = 'new';
    private telemetryStarted = false;

    protected latestTaskMemory: AgentMemory;// | null = null;

    constructor(baseConfig: Partial<AgentOptions> = {}) {
        this.options = {
            ...DEFAULT_CONFIG,
            ...baseConfig,
            connectors: baseConfig.connectors ?? [],
            actions: [...(baseConfig.actions || DEFAULT_CONFIG.actions)], 
        } as Required<AgentOptions>;

        if (baseConfig.maxActions !== undefined && (!Number.isSafeInteger(baseConfig.maxActions) || baseConfig.maxActions < 1)) {
            throw new Error('maxActions must be a positive integer');
        }

        this.connectors = this.options.connectors;

        // Aggregate actions from connectors
        //const aggregatedActions = [...this.options.actions];
        this.actions = [...this.options.actions];
        for (const connector of this.connectors) {
            this.actions.push(...(connector.getActionSpace ? connector.getActionSpace() : []));
        }
        for (const action of memoryActions) {
            if (this.actions.some(existing => existing.name === action.name)) throw new Error(`Action name '${action.name}' is reserved for task memory.`);
            this.actions.push(action);
        }
        // Deduplicate actions by name
        // TODO: maybe error instead, or automatically differentiate them?
        //this.options.actions = Array.from(new Map(aggregatedActions.map(actDef => [actDef.name, actDef])).values());

        const llms = Array.isArray(this.options.llm) ? this.options.llm : [this.options.llm];

        let doPromptCaching = false;
        for (const client of llms ) {
            // If any LLM is prompt-caching compatible, turn on prompt caching overall for memory etc.
            if (isClaude(client) && (client.provider === 'anthropic' || client.provider === 'claude-code')) {
                // Prompt-caching compatible client

                if ('promptCaching' in client.options && client.options.promptCaching !== undefined) {
                    doPromptCaching = client.options.promptCaching;
                } else {
                    // Default to true if not specified, and override on client config to true
                    doPromptCaching = true;
                    client.options.promptCaching = true;
                }
            }
        }

        //this.model = new ModelHarness({ llm: this.options.llm });
        this.models = new MultiModelHarness(llms);
        this.models.events.on('tokensUsed', (usage) => this.events.emit('tokensUsed', usage), this);
        this.doneActing = false;
        this._paused = false;
        this._pauseResolve = null;

        this.memoryOptions = {
            // TODO: maybe do if Gemini or other prompt caching supported providers as well
            // Claude supports prompt caching but only via Anthropic, not on Bedrock
            promptCaching: doPromptCaching
        };

        // Empty memory will get replaced on first act(), but this prevents errors from having undefined memory
        this.latestTaskMemory = new AgentMemory(this.memoryOptions);
    }

    public getConnector<C extends AgentConnector>(
        connectorClass: new (...args: any[]) => C
    ): C | undefined {
        return this.connectors.find(c => c instanceof connectorClass) as C | undefined;
    }

    public require<C extends AgentConnector>(
        connectorClass: new (...args: any[]) => C
    ): C {
        const connector = this.getConnector(connectorClass);
        if (!connector) throw new Error(`Missing required connector ${connectorClass}`);
        return connector;
    }

    async start(): Promise<void> {
        return this.scheduleLifecycle('start', async () => {
            if (this.lifecycleState === 'ready') return;
            this.lifecycleState = 'starting';
            if (this.options.telemetry && !this.telemetryStarted) {
                telemetrifyAgent(this);
                this.telemetryStarted = true;
            }
            try {
                await this.models.setup();
                for (const connector of this.connectors) await connector.onStart?.();
            } catch (error) {
                await this.stopConnectors();
                this.lifecycleState = 'stopped';
                throw error;
            }
            this.lifecycleState = 'ready';
            this.events.emit('start');
        });
    }

    get lifecycle(): 'new' | 'starting' | 'ready' | 'stopping' | 'stopped' {
        return this.lifecycleState;
    }

    private beginWork(): void {
        if (this.pendingWork++ === 0) this.idle = new Promise(resolve => { this.resolveIdle = resolve; });
    }

    private endWork(): void {
        if (--this.pendingWork === 0) {
            const resolve = this.resolveIdle;
            this.resolveIdle = undefined;
            withoutOperation(() => this.latestOperation?.markIdle());
            resolve?.();
        }
    }

    private scheduleLifecycle(kind: 'start' | 'stop', fn: () => Promise<void>): Promise<void> {
        checkOperation();
        if (kind === 'start' && this.activeOperation) throw new AgentBusyError();
        if (this.lifecycleRequest?.kind === kind) return this.lifecycleRequest.promise;
        this.beginWork();
        // Cleanup belongs to the agent, not the operation that requested stop().
        return withoutOperation(() => {
            const promise = this.lifecycleTail.then(fn).finally(() => {
                if (this.lifecycleRequest?.promise === promise) this.lifecycleRequest = undefined;
                this.endWork();
            });
            this.lifecycleRequest = { kind, promise };
            this.lifecycleTail = promise.catch(() => {});
            if (kind === 'stop') this.activeOperation?.cancel('Agent stopped');
            return promise;
        });
    }

    identifyAction(action: Action) {
        // Get definition corresponding to an action
        const actionDefinition = this.actions.find(def => def.name === action.variant);

        if (!actionDefinition) {
            // It's possible the action name was from a connector that is no longer active,
            // or the action space was not correctly aggregated.
            throw new AgentError(`Undefined action type '${action.variant}'. Ensure agent is configured with appropriate action definitions from connectors.`);
        }
        return actionDefinition;
    }
    
    /** True until underlying work settles, including after a cancelled caller returns. */
    get busy(): boolean {
        return this.pendingWork > 0;
    }

    whenIdle(): Promise<void> {
        return this.idle;
    }

    /** A payload-free snapshot of the active or most recent operation. */
    get operation(): OperationDiagnostics | undefined {
        return this.latestOperation?.snapshot();
    }

    protected async runOperation<T>(options: OperationOptions, fn: () => Promise<T>, kind: OperationKind = 'exec'): Promise<T> {
        const inherited = currentOperation();
        if (inherited?.owner === this) inherited.check();
        if (this.busy) {
            const error = new AgentBusyError();
            if (this.activeOperation) attachOperationDiagnostics(error, this.activeOperation.snapshot());
            throw error;
        }
        if (this.lifecycleState === 'stopped') throw new AgentError('Agent is stopped; call start() before using it');
        const operation = new Operation(this, options, kind, snapshot => {
            this.events.emit('operation', snapshot);
        });
        this.activeOperation = operation;
        this.latestOperation = operation;
        this.beginWork();
        operation.announce();
        const worker = operation.run(async () => {
            operation.check();
            try {
                return await fn();
            } finally {
                operation.check(); // Preserve the cancellation/deadline cause through downstream errors.
            }
        });
        const settled = worker.catch(error => {
            operation.fail(error);
            throw error;
        }).finally(() => {
            operation.finish();
            this.activeOperation = undefined;
            this.endWork();
        });
        return untilAborted(settled, operation.signal);
    }

    async exec(action: Action, memory?: AgentMemory, options: OperationOptions = {}): Promise<unknown> {
        return this.runOperation(options, () => this._exec(action, memory));
    }

    private async _exec(action: Action, memory?: AgentMemory): Promise<unknown> {
        checkOperation();
        /**
         * Execute an action that belongs to this Agent's action space.
         * Provide memory to record the action taken, its results, and any connector observations to that memory.
         */
        let actionDefinition = this.identifyAction(action);
        
        let input: any;
        if (actionDefinition.schema instanceof z.ZodObject) {
            let variant: string;
            ({ variant, ...input } = action);
        } else {
            input = (action as any).input; 
        }

        let parsed = actionDefinition.schema.safeParse(input);

        if (!parsed.success) {
            throw new AgentError(`Generated action '${action.variant}' violates input schema: ${parsed.error.message}`, { adaptable: true });
        }

        const operation = currentOperation();
        operation?.prepareAction(actionDefinition.name);
        checkOperation();
        const memoryOnly = memoryActions.includes(actionDefinition);
        if (!memoryOnly) for (const connector of this.connectors) {
            await connector.beforeAction?.(action, operationOptions());
            checkOperation();
        }
        this.events.emit('actionStarted', action);
        checkOperation();
        
        const data = await measureOperation('action', async () => {
            const options = operationOptions();
            operation?.actionState('started');
            try {
                const result = await actionDefinition.resolver({ input: parsed.data, agent: this, memory, ...options });
                operation?.actionState('completed');
                return result;
            } catch (error) {
                operation?.actionState('failed');
                throw error;
            }
        });

        checkOperation();
        this.events.emit('actionDone', action);
        checkOperation();

        if (memory) {
            // Record action taken
            memory.recordObservation(Observation.fromActionTaken(actionDefinition.name, JSON.stringify(action),
                memoryOnly ? { type: 'notebook-write' } : undefined));

            // Record results of action
            if (data) {
                memory.recordObservation(Observation.fromActionResult(actionDefinition.name, data,
                    memoryOnly ? { type: 'notebook-result', limit: 1 } : undefined));
            }

            // Collect and record observations from connectors
            if (memoryOnly) this.events.emit('observationsRecorded'); // Checkpoint notes without another browser capture.
            else await this._recordConnectorObservations(memory);
        }
        return data;
    }

    protected async _recordConnectorObservations(memory: AgentMemory) {
        return measureOperation('observations', async () => {
            for (const connector of this.connectors) {
                const connObservations = connector.collectObservations ? await connector.collectObservations(operationOptions()) : [];
                checkOperation();
                for (const obs of connObservations) {
                    memory.recordObservation(obs);
                }
            }
            this.events.emit('observationsRecorded');
        });
    }

    get memory(): AgentMemory {
        //if (!this.latestTaskMemory) throw new Error("No memory available");
        return this.latestTaskMemory;
    }

    async act(taskOrSteps: string | string[], options: ActOptions = {}): Promise<void> {
        return this.runOperation(options, () => this._runAct(taskOrSteps, options), 'act');
    }

    private async _runAct(taskOrSteps: string | string[], options: ActOptions): Promise<void> {
        const instructions = [
            ...(this.options.prompt ? [this.options.prompt] : []),
            ...(options.prompt ? [options.prompt] : []),
        ].join('\n');
        const taskMemory = options.memory ?? new AgentMemory();
        taskMemory.configure({
            ...this.memoryOptions,
            // Current prompts replace checkpoint instructions; omitted prompts preserve them.
            ...(this.options.prompt != null || options.prompt !== undefined ? { instructions: instructions || null } : {}),
        });

        if (Array.isArray(taskOrSteps)) {
            const steps = taskOrSteps;

            //this.events.emit('actStarted', steps.join(', '));

            // trace overall task
            await (traceAsync('multistep', async (steps: string[], options: ActOptions) => {
                for (const step of steps) {
                    checkOperation();
                    this.events.emit('actStarted', step, options);
                    await this._traceAct(step, taskMemory, options);
                    checkOperation();
                    this.events.emit('actDone', step, options);
                }
            })(steps, options));

            //this.events.emit('actDone', steps.join(', '));
        } else {
            const task = taskOrSteps;

            this.events.emit('actStarted', task, options);

            await this._traceAct(task, taskMemory, options);
            checkOperation();
            this.events.emit('actDone', task, options);
        }
    }

    private async _traceAct(task: string, memory: AgentMemory, options: ActOptions = {}) {
        // memory not serializable to trace so bake it
        await (traceAsync('act', async (task: string) => {
            await this._act(task, memory, options);
        })(task));
    }

    private async _buildContext(memory: AgentMemory, options?: MemoryRenderOptions): Promise<AgentContext> {
        return measureOperation('context', async () => {
            const messages = await memory.render(options);
            checkOperation();

            const connectorInstructions: ConnectorInstructions[] = [];
            for (const connector of this.connectors) {
                if (connector.getInstructions) {
                    const instructions = await connector.getInstructions(operationOptions());
                    checkOperation();
                    if (instructions) {
                        connectorInstructions.push({ connectorId: connector.id, instructions });
                    }
                }
            }

            return {
                instructions: memory.instructions,
                observationContent: messages,
                connectorInstructions,
            };
        });
    }

    private async _act(description: string, memory: AgentMemory, options: ActOptions = {}): Promise<void> {
        checkOperation();
        this.doneActing = false;
        for (const connector of this.connectors) {
            connector.onTaskStart?.(operationOptions());
            checkOperation();
        }
        logger.info(`Act: ${description}`);

        // for now simply add data to task
        let dataContentParts: MultiMediaContentPart[] = [];
        if (options.data) {
            //description += "\nUse the following data where appropriate:\n";
            // description += "\n<data>\n";
            // // if (typeof options.data === 'string') {
            // //     description += options.data;
            // // } else {
            // //     description += Object.entries(options.data).map(([k, v]) => `${k}: ${v}`).join("\n");
            // // }
            // const parts = renderParts(options.data);
            // description += "\n</data>";
            dataContentParts = await renderContentParts(options.data, { mode: 'json', indent: 2 });
        }
        //this.events.emit('stepStart', description);

        //const testData = convertOptionsToTestData(options);

        // Initialize task memory and record initial observations
        // Combine any agent-level and task-level instructions
        
        checkOperation();
        this.latestTaskMemory = memory;

        // record initial observations
        logger.info("Making initial observations...");
        await this._recordConnectorObservations(memory);
        logger.info("Initial observations recorded");

        let actionCount = 0;
        while (true) {
            checkOperation();
            if (actionCount >= this.options.maxActions) throw new ActionLimitError(this.options.maxActions);
            // Removed direct screenshot/tabState access here; it's part of memoryContext via connectors
            logger.info(`Creating partial recipe`);

            let reasoning: string = "";
            let actions: Action[] = [];
            let memoryUpdates: NoteUpdate[] = [];

            try {
                this.events.emit('planningStarted');
                const memoryContext = await this._buildContext(memory);
                memoryContext.connectorInstructions.unshift({ connectorId: 'task_memory', instructions: NOTEBOOK_INSTRUCTIONS });
                await retryOnError(
                    async () => {
                        ({ reasoning, actions, memory_updates: memoryUpdates } = await this.models.partialAct(
                            memoryContext,
                            description,
                            dataContentParts,
                            this.actions 
                        ));
                        checkOperation();
                        if (actions.length === 0) {
                            // Empty action list behavior - default wait else ... err? what if not in action space?
                            //actions.push()
                            throw new AgentError(`No actions generated`);
                        }
                    },
                    // HTTP body is not JSON - comes from Anthropic sometimes, weird error
                    // Sometimes Anthropic will give 401 Unauthorized randomly even when authorized
                    {
                        mode: 'retry_on_partial_message',
                        errorSubstrings: ['HTTP body is not JSON', '401 Unauthorized', 'No actions generated'],
                        retryLimit: 3,
                        delayMs: 1000,
                        showWarnOnRetry: true
                    }
                );
            } catch (error: unknown) {
                checkOperation();
                logger.error(`Error planning actions: ${error instanceof Error ? error.message : String(error)}`);
                /**
                 * (1) Failure to conform to JSON
                 * (2) Misconfigured BAML client / bad API key
                 * (3) Network error (past max retries)
                 */
                // this.fail({
                //     variant: 'misalignment',
                //     message: `Could not create partial recipe -> ${(error as Error).message}`
                // });
                throw new AgentError(
                    `Error planning actions: ${(error as Error).message}`, { variant: 'misalignment' }
                )
            }

            logger.info({ reasoning, actions }, `Partial recipe created`);
            
            // Could be emitted in memory and bubbled up instead of recordThought was called in more places
            this.events.emit('thought', reasoning);
            checkOperation();
            memory.recordThought(reasoning);

            // Persist the review using the existing audited, budgeted note action.
            // Empty reviews are free; each attempted write consumes one action.
            const batch = [...memoryUpdates.map(note => ({ variant: 'memory:note', ...note })), ...actions];
            for (const action of batch) {
                await this._waitIfPaused();
                checkOperation();
                if (this.doneActing) break;
                if (actionCount >= this.options.maxActions) throw new ActionLimitError(this.options.maxActions);
                const result = await this._exec(action, memory);
                actionCount++;
                // Preserve the current page when an update fails. Successful
                // earlier writes remain; the next plan sees the failure result.
                if (action.variant === 'memory:note' && (result as { saved?: unknown })?.saved === false) break;
                if (result === GROUNDED_CLICK_REJECTED) break;

                // const postActionScreenshot = await this.screenshot();
                // const actionDescriptor: ActionDescriptor = { ...action, screenshot: postActionScreenshot.image } as ActionDescriptor;
                // this.events.emit('action', actionDescriptor);
                logger.info({ action }, `Action taken`);
            }

            // If macro expects these actions should complete the step, break
            // if (finished) {
            //     break;
            // }
            await this._waitIfPaused();
            if (this.doneActing) {
                break;
            }
        }

        logger.info(`Done with step`);
        //this.events.emit('stepSuccess');
        //this.currentTaskMemory = null;
    }

    async query<T extends z.Schema>(query: string, schema: T, options: MemoryRenderOptions & OperationOptions = {}): Promise<z.infer<T>> {
        return this.runOperation(options, async () => {
            // Record observations in case no act() was used beforehand
            await this._recordConnectorObservations(this.latestTaskMemory);
            const memoryContext = await this._buildContext(this.memory, options);
            return await this.models.query(memoryContext, query, schema);
        }, 'query');
    }

    async queueDone() {
        checkOperation();
        this.doneActing = true;
    }

    private async _waitIfPaused(): Promise<void> {
        checkOperation();
        if (!this._paused) return;
        this.events.emit('pause');
        checkOperation();
        if (!this._paused) return; // A pause listener may have resumed synchronously.
        logger.info("Agent: Paused");
        try {
            await measureOperation('paused', async () => {
                if (!this._paused) return; // A diagnostic listener may have resumed.
                await untilAborted(new Promise<void>((resolve) => {
                    this._pauseResolve = resolve;
                }), currentOperation()?.signal);
            });
        } finally {
            this._pauseResolve = null;
        }
    }

    pause(): void {
        checkOperation();
        this._paused = true;
    }

    resume(): void {
        checkOperation();
        this._paused = false;
        if (this._pauseResolve) {
            this._pauseResolve();
            this._pauseResolve = null;
        }
        this.events.emit('resume');
        logger.info("Agent: Resumed");
    }

    get paused(): boolean {
        return this._paused;
    }

    async stop() {
        return this.scheduleLifecycle('stop', async () => {
            if (this.lifecycleState === 'stopped') return;
            this.lifecycleState = 'stopping';
            this.doneActing = true;
            this._paused = false;
            this._pauseResolve?.();
            this._pauseResolve = null;
            await this.stopConnectors();
            this.lifecycleState = 'stopped';
            this.events.emit('stop');
        });
    }

    private async stopConnectors(): Promise<void> {
        logger.info("Agent: Stopping connectors...");
        for (const connector of this.connectors) {
            try {
                if (connector.onStop) await connector.onStop();
            } catch (error) {
                logger.warn(`Agent: Error stopping connector ${connector.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        logger.info("Agent: All connectors stopped.");
        logger.info("Agent: Stopped successfully.");
    }

    // async dumpMemoryJSON() {
    //     return await this.memory.toJSON();
    // }
}
