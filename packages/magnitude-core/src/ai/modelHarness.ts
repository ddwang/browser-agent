import { convertToBamlClientOptions } from "./util";
// Import ModularMemoryContext instead of old MemoryContext
import { b, AgentContext } from "@/ai/baml_client"; 
import { Image as BamlImage, Collector, ClientRegistry, BamlValidationError, type FunctionLog } from "@boundaryml/baml";
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
import { parsePlannerResponse, PlannerResponseError, memoryUpdatesSchema, type PlannerResponse } from './plannerResponse';
import { anthropicOutputFormat, plannerSchema, usesStructuredOutput } from './structuredOutput';
import { ModelResponseError } from './modelResponseError';
import { DEFAULT_BASETEN_MODEL } from './baseten';

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
    private clientOptions!: Record<string, any>;
    private baml!: BamlAsyncClient;
    private logger: Logger;
    private planner?: {
        vocabulary: Pick<ActionDefinition<any>, 'name' | 'description' | 'schema'>[];
        tb: TypeBuilder;
        clientRegistry: ClientRegistry;
    };

    constructor(options: ModelHarnessOptions) {
        this.options = {
            llm: options.llm,
            //promptCaching: options.promptCaching ?? false
        };

        this.logger = logger.child({ name: 'llm' });
    }

    async setup() {
        // Must be called after constructor
        this.planner = undefined;
        this.clientOptions = await convertToBamlClientOptions(this.options.llm);
        this.cr = this.createClientRegistry(this.clientOptions);
        this.baml = b.withOptions({ clientRegistry: this.cr });
    }

    protected createClientRegistry(options: Record<string, any>): ClientRegistry {
        const registry = new ClientRegistry();
        registry.addLlmClient(
            'Magnus', 
            this.options.llm.provider === 'claude-code' ? 'anthropic'
                : this.options.llm.provider === 'baseten' ? 'openai-generic' : this.options.llm.provider,
            options,
            'DefaultRetryPolicy'
        );
        registry.setPrimary('Magnus');
        return registry;
    }

    private clientForSchema(schema: Schema): ClientRegistry {
        if (!usesStructuredOutput(this.options.llm)) return this.cr;
        // Reuse the conservative schema subset across providers; all original
        // value constraints and notebook semantics remain locally validated.
        const format = anthropicOutputFormat(schema);
        if (!format) {
            this.logger.debug('Schema requires prompt-only output; native structured output cannot represent it');
            return this.cr;
        }
        const outputOptions = this.options.llm.provider === 'baseten'
            ? { response_format: { type: 'json_schema', json_schema: { name: 'magnitude_response', strict: true, schema: format.schema } } }
            : { output_config: { format } };
        return this.createClientRegistry({ ...this.clientOptions, ...outputOptions });
    }

    describeModel(): string {
        return `${this.options.llm.provider}:${'model' in this.options.llm.options ? this.options.llm.options.model : 'unknown'}`;
    }

    private async _withUsage<T>(invoke: (collector: Collector) => Promise<T>): Promise<T> {
        // Scope usage to this invocation, including failed parses and provider
        // retries. A shared cumulative collector can double-count concurrent calls.
        const collector = new Collector('model-call');
        try {
            try {
                return await invoke(collector);
            } finally {
                // Even syntactically complete JSON must not hide a provider
                // refusal or a truncated batch. Neither gets a format retry.
                if (this.options.llm.provider === 'anthropic' || this.options.llm.provider === 'claude-code') {
                    let reason: unknown;
                    try { reason = collector.last?.calls.at(-1)?.httpResponse?.body.json()?.stop_reason; }
                    catch { /* A transport error may not contain JSON. */ }
                    if (reason === 'refusal' || reason === 'max_tokens') throw new ModelResponseError(reason);
                } else if (this.options.llm.provider === 'openai' || this.options.llm.provider === 'baseten') {
                    let choice: any;
                    try { choice = collector.last?.calls.at(-1)?.httpResponse?.body.json()?.choices?.[0]; }
                    catch { /* A transport error may not contain JSON. */ }
                    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new ModelResponseError('refusal');
                    if (choice?.finish_reason === 'length') throw new ModelResponseError('max_tokens');
                }
            }
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
        } else if (this.options.llm.provider === 'openai' || this.options.llm.provider === 'baseten') {
            try {
                const usage = call.httpResponse?.body.json()?.usage;
                if (usage) {
                    // Both providers include cached input in prompt_tokens and reasoning
                    // output in completion_tokens. Neither should be counted twice.
                    cacheReadInputTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
                    cacheWriteInputTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
                    const totalInputTokens = usage.prompt_tokens ?? inputTokens;
                    if (totalInputTokens != null) inputTokens = totalInputTokens - cacheReadInputTokens - cacheWriteInputTokens;
                    outputTokens = usage.completion_tokens ?? outputTokens;
                }
            } catch { /* Non-JSON error response; use per-call usage if available. */ }
        }
        // A transport failure with no usage is not a paid completion. In
        // particular, never reuse the preceding successful response's usage.
        if (inputTokens == null && outputTokens == null) return;
        inputTokens ??= 0;
        outputTokens ??= 0;

        const model = (this.options.llm.options as any).model ?? 'unknown';
        const isLuna = /^gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(model);

        // Get cost if known
        const knownCostMap: Record<string, { inputTokens: number, outputTokens: number, cacheWriteInputTokens?: number, cacheReadInputTokens?: number }> = this.options.llm.provider === 'baseten' ? {
            // Baseten Model API rates, verified 2026-09-15. Do not inherit other providers' prices.
            // https://www.baseten.co/library/deepseek-v41-flash/
            [DEFAULT_BASETEN_MODEL]: { inputTokens: 0.30, outputTokens: 1.20, cacheReadInputTokens: 0.03 },
        } : {
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
            // https://developers.openai.com/api/docs/models/gpt-5.6-luna
            'gpt-5.6-luna': { inputTokens: 0.20, outputTokens: 1.20, cacheWriteInputTokens: 0.25, cacheReadInputTokens: 0.02 },
            // Assuming Nebius prices, may be higher
            'qwen2.5-vl-72b': { inputTokens: 0.25, outputTokens: 0.75 }
        };

        let inputTokenCost: number | undefined;
        let outputTokenCost: number | undefined;
        let cacheWriteInputTokenCost: number | undefined;
        let cacheReadInputTokenCost: number | undefined;

        for (const [name, costs] of Object.entries(knownCostMap)) {
            if (this.options.llm.provider === 'baseten' ? model === name : name === 'gpt-5.6-luna' ? isLuna : model.includes(name)) {
                inputTokenCost = costs.inputTokens / 1_000_000;
                outputTokenCost = costs.outputTokens / 1_000_000;
                cacheReadInputTokenCost = costs.cacheReadInputTokens ? costs.cacheReadInputTokens / 1_000_000 : undefined;
                cacheWriteInputTokenCost = costs.cacheWriteInputTokens ? costs.cacheWriteInputTokens / 1_000_000 : undefined;
            }
        }

        // Luna long-context pricing applies to the entire request, including
        // cached input. Output usage already includes billed reasoning tokens.
        if (isLuna && inputTokens + cacheReadInputTokens + cacheWriteInputTokens > 272_000) {
            if (inputTokenCost !== undefined) inputTokenCost *= 2;
            if (cacheWriteInputTokenCost !== undefined) cacheWriteInputTokenCost *= 2;
            if (cacheReadInputTokenCost !== undefined) cacheReadInputTokenCost *= 2;
            if (outputTokenCost !== undefined) outputTokenCost *= 1.5;
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
            ...(inputTokenCost !== undefined && (!cacheWriteInputTokens || cacheWriteInputTokenCost !== undefined) && (!cacheReadInputTokens || cacheReadInputTokenCost !== undefined) ? {
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
    ): Promise<PlannerResponse> {
        // Notes have one planner path: a required review before browser actions.
        // Keep memory:note registered on Agent for execution and explicit callers.
        actionVocabulary = actionVocabulary.filter(action => action.name !== 'memory:note');
        if (!this.planner || this.planner.vocabulary.length !== actionVocabulary.length
            || actionVocabulary.some((action, index) => {
                const saved = this.planner!.vocabulary[index];
                return action.name !== saved.name || action.description !== saved.description || action.schema !== saved.schema;
            })) {
            const tb = new TypeBuilder();
            tb.PartialRecipe.addProperty('memory_updates', convertZodToBaml(tb, memoryUpdatesSchema)).description(memoryUpdatesSchema.description!);
            tb.PartialRecipe.addProperty('actions', tb.list(convertActionDefinitionsToBaml(tb, actionVocabulary))).description('Always provide at least one action');
            this.planner = {
                vocabulary: actionVocabulary.map(({ name, description, schema }) => ({ name, description, schema })),
                tb, clientRegistry: this.clientForSchema(plannerSchema(actionVocabulary)),
            };
        }
        const { tb, clientRegistry } = this.planner;

        for (let attempt = 0; ; attempt++) {
            try {
                return await this._withUsage(async collector => {
                    let bamlRejected = false;
                    try {
                        await this.baml.CreatePartialRecipe(
                            context, task, data,
                            this.options.llm.provider === 'claude-code',
                            { tb, collector, clientRegistry }
                        );
                    } catch (error) {
                        if (!(error instanceof BamlValidationError)) throw error;
                        bamlRejected = true;
                    }
                    // BAML can fail first or coerce invalid fields. Diagnose its
                    // raw response locally, but never bypass either validator.
                    const plan = parsePlannerResponse(collector.last?.rawLlmResponse ?? null, actionVocabulary);
                    if (bamlRejected) throw new PlannerResponseError('$: BAML parser rejected the response despite local validation; return a plan matching the supplied schema');
                    return plan;
                });
            } catch (error) {
                if (!(error instanceof PlannerResponseError)) throw error;
                this.logger.warn({ attempt: attempt + 1, diagnostic: error.diagnostic }, attempt === 0
                    ? 'Invalid planner response; retrying once with the same observations'
                    : 'Invalid planner response; no format retries remain');
                if (attempt === 1) throw new PlannerResponseError(error.diagnostic, 'Planner returned an invalid plan on both attempts');
                // No invalid output is appended to memory or executed. Keep the
                // correction short even when the rejected response is enormous.
                context = { ...context, observationContent: [...context.observationContent, {
                    role: 'user', cacheControl: false, content: [`Your previous response was rejected as an invalid plan. No actions were executed. Validation: ${error.diagnostic}. Correct the reported fields. Return only one complete JSON object with concise reasoning, a memory_updates array (empty when nothing new needs retaining), and a non-empty actions array matching the schema. No XML, prose, simulated tool calls, or imagined observations. Plan only the next batch from the observations above.`],
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

        const clientRegistry = this.clientForSchema(schema instanceof z.ZodObject ? schema : z.object({ data: schema }));
        const bamlScreenshot = await screenshot.toBaml();
        const resp = await this._withUsage(collector => this.baml.ExtractData(
            instructions,
            bamlScreenshot,
            domContent,
            this.options.llm.provider === 'claude-code',
            { tb, collector, clientRegistry }
        ));

        return schema.parse(schema instanceof z.ZodObject ? resp : resp.data);
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

        const clientRegistry = this.clientForSchema(schema instanceof z.ZodObject ? schema : z.object({ data: schema }));
        const resp = await this._withUsage(collector => this.baml.QueryMemory(
            context,
            query,
            this.options.llm.provider === 'claude-code',
            { tb, collector, clientRegistry }
        ));
        
        return schema.parse(schema instanceof z.ZodObject ? resp : resp.data);
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
