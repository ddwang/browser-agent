import { convertToBamlClientOptions } from "./util";
// Import ModularMemoryContext instead of old MemoryContext
import { b, AgentContext } from "@/ai/baml_client"; 
import { Image as BamlImage, Collector, ClientRegistry, BamlValidationError, BamlClientFinishReasonError, type FunctionLog } from "@boundaryml/baml";
import { Action, ActionIntent, Intent } from "@/actions/types";
import { TestStepDefinition } from "@/types";
import { BamlAsyncClient } from "./baml_client/async_client";
import logger from "@/logger";
import { Logger } from 'pino';
import { BugDetectedFailure, MisalignmentFailure } from "@/common";
import { LLMClient, ModelUsage } from "@/ai/types";
import { TabState } from "@/web/tabs";
import { ActionDefinition } from "@/actions";
import TypeBuilder from "./baml_client/type_builder";
import { Schema, z } from 'zod';
import { convertActionDefinitionsToBaml, convertZodToBaml } from "@/actions/util";
import { Image } from '@/memory/image';
import EventEmitter from "eventemitter3";
import { MultiMediaContentPart } from "@/memory/rendering";
import { parsePlannerResponse, PlannerResponseError } from './plannerResponse';

interface ModelHarnessOptions {
    llm: LLMClient;
    //promptCaching?: boolean;
}

// export interface ModelUsage {
//     provider: string,
//     model: string,
//     inputTokens: number,
//     outputTokens: number,
//     numCalls: number
// }

export interface ModelHarnessEvents {
    'tokensUsed': (usage: ModelUsage) => {}
}

export class ModelHarness {
    /**
     * Strong reasoning agent for high level strategy and planning.
     */
    public readonly events: EventEmitter<ModelHarnessEvents> = new EventEmitter();
    private options: Required<ModelHarnessOptions>;
    private cr!: ClientRegistry;
    private baml!: BamlAsyncClient;
    private logger: Logger;

    constructor(options: ModelHarnessOptions) {
        this.options = {
            llm: options.llm,
            //promptCaching: options.promptCaching ?? false
        };

        this.logger = logger.child({ name: 'llm' });
    }

    async setup() {
        // Must be called after constructor
        this.cr = new ClientRegistry();
        let bamlClientOptions = await convertToBamlClientOptions(this.options.llm);
        this.cr.addLlmClient(
            'Magnus', 
            this.options.llm.provider === 'claude-code' ? 'anthropic' : this.options.llm.provider,
            bamlClientOptions,
            'DefaultRetryPolicy'
        );
        this.cr.setPrimary('Magnus');

        this.baml = b.withOptions({ clientRegistry: this.cr });
    }

    describeModel(): string {
        return `${this.options.llm.provider}:${'model' in this.options.llm.options ? this.options.llm.options.model : 'unknown'}`;
    }

    private async _withUsage<T>(invoke: (collector: Collector) => Promise<T>): Promise<T> {
        // Scope usage to this invocation, including failed parses and provider
        // retries. A shared cumulative collector can double-count concurrent calls.
        const collector = new Collector('model-call');
        try {
            return await invoke(collector);
        } finally {
            for (const log of collector.logs) {
                for (const call of log.calls) {
                    try { this._reportCallUsage(call); }
                    catch { this.logger.warn('Unable to report model response usage'); }
                }
            }
        }
    }

    private _reportCallUsage(call: FunctionLog['calls'][number]): void {
        let inputTokens = call.usage?.inputTokens;
        let outputTokens = call.usage?.outputTokens;
        let cacheWriteInputTokens: number = 0;
        let cacheReadInputTokens: number = 0;

        if (this.options.llm.provider === 'anthropic' || this.options.llm.provider === 'claude-code') {
            // Anthropic's input_tokens excludes cache reads/writes. BAML's
            // normalized usage does not expose that breakdown.
            try {
                const usage = call.httpResponse?.body.json()?.usage;
                if (usage) {
                    inputTokens = usage.input_tokens ?? inputTokens;
                    outputTokens = usage.output_tokens ?? outputTokens;
                    cacheWriteInputTokens = usage.cache_creation_input_tokens ?? 0;
                    cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
                }
            } catch { /* Non-JSON error response; use per-call usage if available. */ }
        }
        // A transport failure with no usage is not a paid completion. In
        // particular, never reuse the preceding successful response's usage.
        if (inputTokens == null && outputTokens == null) return;
        inputTokens ??= 0;
        outputTokens ??= 0;

        const model = (this.options.llm.options as any).model ?? 'unknown';

        // Get cost if known
        const knownCostMap: Record<string, { inputTokens: number, outputTokens: number, cacheWriteInputTokens?: number, cacheReadInputTokens?: number }> = {
            // TODO: track cached savings on Gemini
            'gemini-2.5-pro': { inputTokens: 1.25, outputTokens: 10.0 },
            'gemini-2.5-flash': { inputTokens: 0.30, outputTokens: 2.50 },
            'gemini-2.5-flash-lite': { inputTokens: 0.10, outputTokens: 0.40 },
            'claude-3.5-sonnet': { inputTokens: 3.00, outputTokens: 15.00, cacheWriteInputTokens: 3.75, cacheReadInputTokens: 0.30 },
            'claude-3.7-sonnet': { inputTokens: 3.00, outputTokens: 15.00, cacheWriteInputTokens: 3.75, cacheReadInputTokens: 0.30 },
            'claude-sonnet-4': { inputTokens: 3.00, outputTokens: 15.00, cacheWriteInputTokens: 3.75, cacheReadInputTokens: 0.30 },
            // Standard API pricing, using the default 5-minute cache TTL:
            // https://platform.claude.com/docs/en/models/sonnet-5/overview#pricing
            'claude-sonnet-5': { inputTokens: 2.00, outputTokens: 10.00, cacheWriteInputTokens: 2.50, cacheReadInputTokens: 0.20 },
            'claude-haiku-4-5': { inputTokens: 1.00, outputTokens: 5.00, cacheWriteInputTokens: 1.25, cacheReadInputTokens: 0.10 },
            'claude-opus-4': { inputTokens: 15.00, outputTokens: 75.00, cacheWriteInputTokens: 18.75, cacheReadInputTokens: 1.50 },
            'gpt-4.1': { inputTokens: 2.00, outputTokens: 8.00 },
            'gpt-4.1-mini': { inputTokens: 0.40, outputTokens: 1.60 },
            'gpt-4.1-nano': { inputTokens: 0.10, outputTokens: 0.40 },
            'gpt-4o': { inputTokens: 3.75, outputTokens: 15.00 },
            // Assuming Nebius prices, may be higher
            'qwen2.5-vl-72b': { inputTokens: 0.25, outputTokens: 0.75 }
        };

        let inputTokenCost: number | undefined;
        let outputTokenCost: number | undefined;
        let cacheWriteInputTokenCost: number | undefined;
        let cacheReadInputTokenCost: number | undefined;

        for (const [name, costs] of Object.entries(knownCostMap)) {
            if (model.includes(name)) {
                inputTokenCost = costs.inputTokens / 1_000_000;
                outputTokenCost = costs.outputTokens / 1_000_000;
                cacheReadInputTokenCost = costs.cacheReadInputTokens ? costs.cacheReadInputTokens / 1_000_000 : undefined;
                cacheWriteInputTokenCost = costs.cacheWriteInputTokens ? costs.cacheWriteInputTokens / 1_000_000 : undefined;
            }
        }

        // console.log("cacheWriteInputTokenCost:", cacheWriteInputTokenCost);
        // console.log("cacheWriteInputTokens:", cacheWriteInputTokens);

        const usage: ModelUsage = {
            llm: {
                provider: this.options.llm.provider,
                model: model
            },//this.options.llm,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            ...(cacheWriteInputTokens ? { cacheWriteInputTokens } : {}),
            ...(cacheReadInputTokens ? { cacheReadInputTokens } : {}),
            ...(inputTokenCost ? {
                inputCost: inputTokens * inputTokenCost +
                    ( cacheWriteInputTokenCost ? cacheWriteInputTokenCost * cacheWriteInputTokens : 0.0 ) +
                    ( cacheReadInputTokenCost ? cacheReadInputTokenCost * cacheReadInputTokens : 0.0 )
            } : {}),
            ...(outputTokenCost ? { outputCost: outputTokens * outputTokenCost } : {}),
            // ...(cacheWriteInputTokenCost ? { : inputTokens * inputTokenCost } : {}),
            // ...(cacheReadInputTokenCost ? { outputCost: outputTokens * outputTokenCost } : {})
        };

        this.events.emit('tokensUsed', usage);
        //console.log("Usage:", usage);

    }

    async partialAct<T>(
        context: AgentContext, // Changed to ModularMemoryContext
        task: string,
        data: MultiMediaContentPart[],
        actionVocabulary: ActionDefinition<T>[]
    ): Promise<{ reasoning: string, actions: Action[] }> {
        const tb = new TypeBuilder();

        tb.PartialRecipe.addProperty('actions', tb.list(convertActionDefinitionsToBaml(tb, actionVocabulary))).description('Always provide at least one action');

        for (let attempt = 0; ; attempt++) {
            try {
                return await this._withUsage(async collector => {
                    await this.baml.CreatePartialRecipe(
                        context, task, data,
                        this.options.llm.provider === 'claude-code',
                        { tb, collector }
                    );
                    return parsePlannerResponse(collector.last?.rawLlmResponse ?? null, actionVocabulary);
                });
            } catch (error) {
                if (!(error instanceof PlannerResponseError || error instanceof BamlValidationError || error instanceof BamlClientFinishReasonError)) throw error;
                if (attempt === 1) throw new PlannerResponseError('Planner returned an invalid plan on both attempts');
                this.logger.warn('Invalid planner response; retrying once with the same observations');
                // No invalid output is appended to memory or executed. Keep the
                // correction short even when the rejected response is enormous.
                context = { ...context, observationContent: [...context.observationContent, {
                    role: 'user', cacheControl: false, content: ['Your previous response was rejected as an invalid plan. No actions were executed. Return only one complete JSON object with concise reasoning and a non-empty actions array matching the schema. No XML, prose, simulated tool calls, or imagined observations. Plan only the next batch from the observations above.'],
                }] };
            }
        }
    }

    async extract<T extends Schema>(instructions: string, schema: T, screenshot: Image, domContent: string): Promise<z.infer<T>> {
        const tb = new TypeBuilder();

        if (schema instanceof z.ZodObject) {
            // populate ExtractedData with schema KVs instead of wrapping in data key unnecessarily
            for (const [key, fieldSchema] of Object.entries(schema.shape)) {
                tb.ExtractedData.addProperty(key, convertZodToBaml(tb, fieldSchema as any));
            }
        } else {
            // for array or primitive have to wrap data key
            tb.ExtractedData.addProperty('data', convertZodToBaml(tb, schema));
        }
        // } else if (schema instanceof z.ZodArray) {

        // }

        const bamlScreenshot = await screenshot.toBaml();
        const resp = await this._withUsage(collector => this.baml.ExtractData(
            instructions,
            bamlScreenshot,
            domContent,
            this.options.llm.provider === 'claude-code',
            { tb, collector }
        ));

        if (schema instanceof z.ZodObject) {
            return resp;
        } else {
            return resp.data;
        }
    }
    // ^ extract could prob be a subset of query w trimmed mem

    async query<T extends Schema>(context: AgentContext, query: string, schema: T): Promise<z.infer<T>> {
        const tb = new TypeBuilder();

        if (schema instanceof z.ZodObject) {
            // populate ExtractedData with schema KVs instead of wrapping in data key unnecessarily
            for (const [key, fieldSchema] of Object.entries(schema.shape)) {
                tb.QueryResponse.addProperty(key, convertZodToBaml(tb, fieldSchema as any));
            }
        } else {
            // for array or primitive have to wrap data key
            tb.QueryResponse.addProperty('data', convertZodToBaml(tb, schema));
        }

        const resp = await this._withUsage(collector => this.baml.QueryMemory(
            context,
            query,
            this.options.llm.provider === 'claude-code',
            { tb, collector }
        ));
        
        if (schema instanceof z.ZodObject) {
            return resp;
        } else {
            return resp.data;
        }
    }

    // async classifyCheckFailure(screenshot: Image, check: string, existingRecipe: Action[], tabState: TabState): Promise<BugDetectedFailure | MisalignmentFailure> {
    //     const stringifiedExistingRecipe = [];
    //     for (const action of existingRecipe) {
    //         stringifiedExistingRecipe.push(JSON.stringify(action, null, 4))
    //     }

    //     const start = Date.now();
    //     const response = await this.baml.ClassifyCheckFailure(
    //         {
    //             screenshot: await screenshot.toBaml(),//Image.fromBase64('image/png', screenshot.image),
    //             actionHistory: stringifiedExistingRecipe,
    //             tabState: tabState
    //         },
    //         check
    //     );
    //     this.logger.trace(`classifyCheckFailure took ${Date.now()-start}ms`);
    //     //return response.check;

    //     if (response.classification === 'bug') {
    //         return {
    //             variant: 'bug',
    //             title: response.title,
    //             expectedResult: response.expectedResult,
    //             actualResult: response.actualResult,
    //             severity: response.severity
    //         }
    //     }
    //     else {
    //         return {
    //             variant: 'misalignment',
    //             message: response.message
    //         }
    //     }
    // }

    

    // async diagnoseTargetNotFound(
    //     screenshot: Screenshot,
    //     step: TestStepDefinition,
    //     target: string,
    //     existingRecipe: ActionIngredient[]
    // ): Promise<BugDetectedFailure | MisalignmentFailure> {
    //     const downscaledScreenshot = await this.transformScreenshot(screenshot);

    //     const stringifiedExistingRecipe = [];
    //     for (const action of existingRecipe) {
    //         stringifiedExistingRecipe.push(JSON.stringify(action, null, 4))
    //     }

    //     const start = Date.now();
    //     const response = await this.baml.DiagnoseTargetNotFound(
    //         Image.fromBase64('image/png', downscaledScreenshot.image),
    //         step,
    //         target,
    //         //action.target,
    //         //JSON.stringify(action, null, 4),//action,
    //         stringifiedExistingRecipe
    //     );
    //     this.logger.trace(`classifyStepActionFailure took ${Date.now()-start}ms`);

    //     if (response.classification === 'bug') {
    //         return {
    //             variant: 'bug',
    //             title: response.title,
    //             expectedResult: response.expectedResult,
    //             actualResult: response.actualResult,
    //             severity: response.severity
    //         }
    //     }
    //     else {
    //         return {
    //             variant: 'misalignment',
    //             message: response.message
    //         }
    //     }
    // }
}
