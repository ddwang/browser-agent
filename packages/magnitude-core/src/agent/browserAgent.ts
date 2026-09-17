import { BrowserContext, Page } from "playwright";
import { Agent, AgentOptions } from ".";
import { BrowserConnector, BrowserConnectorOptions } from "@/connectors/browserConnector";
import { buildDefaultBrowserAgentOptions } from "@/ai/util";
import { LLMClient } from "@/ai/types";
import { Schema, ZodSchema } from "zod";
import z from "zod";
import { renderMinimalAccessibilityTree } from "@/web/util";
import { narrateAgent, narrateBrowserAgent } from "./narrator";
import { PartitionOptions, partitionHtml, MarkdownSerializerOptions, serializeToMarkdown } from 'magnitude-extract';
import EventEmitter from "eventemitter3";
import { retry } from "@/common/retry";
import { checkOperation, type OperationOptions } from '@/common/operation';
import { getVisiblePageContent } from '@/web/pageContent';

// export interface StartAgentWithWebOptions {
//     agentBaseOptions?: Partial<AgentOptions>;
//     webConnectorOptions?: BrowserConnectorOptions;
// }

const DEFAULT_BROWSER_AGENT_TEMP = 0.2;

// Helper function to start a web agent
export async function startBrowserAgent(
    options?: AgentOptions & BrowserConnectorOptions & { narrate?: boolean }//StartAgentWithWebOptions = {}
): Promise<BrowserAgent> {
    //console.log("sba options:", options);
    const { agentOptions, browserOptions } = buildDefaultBrowserAgentOptions({ agentOptions: options ?? {}, browserOptions: options ?? {} });

    const agent = new BrowserAgent({
        agentOptions: agentOptions,
        browserOptions: browserOptions,
    });

    if (options?.narrate || process.env.MAGNITUDE_NARRATE) {
        narrateBrowserAgent(agent);
        //agent.events.on('actionStarted', (action: any) => { console.log(action) })
    }

    //console.log('starting agent')
    await agent.start();
    //console.log('agent started');
    return agent;
}

// Anything that could be extracted with a zod schema
type ExtractedOutput =
    | string
    | number
    | boolean
    | bigint
    | Date
    | null
    | undefined
    | { [key: string]: ExtractedOutput }
    | ExtractedOutput[];

export interface BrowserAgentEvents {
    'nav': (url: string) => void;
    'extractStarted': (instructions: string, schema: ZodSchema) => void;
    'extractDone': (instructions: string, data: ExtractedOutput) => void;
}

export class BrowserAgent extends Agent {
    public readonly browserAgentEvents: EventEmitter<BrowserAgentEvents> = new EventEmitter();

    constructor({ agentOptions, browserOptions }: { agentOptions?: Partial<AgentOptions>, browserOptions?: BrowserConnectorOptions }) {
        //console.log("agent options:", agent);
        //console.log("browser options:", browserOptions);
        super({
            ...agentOptions,
            connectors: [new BrowserConnector(browserOptions || {}), ...(agentOptions?.connectors ?? [])]
        });
    }

    get page(): Page {
        return this.require(BrowserConnector).getHarness().page;
    }

    get context(): BrowserContext {
        return this.require(BrowserConnector).getHarness().context;
    }

    async nav(url: string, options: OperationOptions = {}): Promise<void> {
        return this.runOperation(options, async () => {
            this.browserAgentEvents.emit('nav', url);
            checkOperation();
            await this.require(BrowserConnector).getHarness().navigate(url);
        }, 'nav');
    }

    async extract<T extends Schema>(instructions: string, schema: T, options: OperationOptions = {}): Promise<z.infer<T>> {
        return this.runOperation(options, () => this._extract(instructions, schema), 'extract');
    }

    private async _extract<T extends Schema>(instructions: string, schema: T): Promise<z.infer<T>> {
        this.browserAgentEvents.emit('extractStarted', instructions, schema);
        const htmlContent = await retry(
            () => getVisiblePageContent(this.page),
            { retries: 5, delay: 200, exponential: true }
        );
        // const accessibilityTree = await this.page.accessibility.snapshot({ interestingOnly: true });
        // const pageRepr = renderMinimalAccessibilityTree(accessibilityTree);

        const partitionOptions: PartitionOptions = {
            extractImages: true,
            extractForms: true,
            extractLinks: true,
            skipNavigation: false, // NAVIGATION SKIPPING IS BROKEN
            minTextLength: 3,
            includeOriginalHtml: false,
            includeMetadata: true
        };

        // Process HTML
        const result = partitionHtml(htmlContent, partitionOptions);

        // Configure markdown serializer options
        const markdownOptions: MarkdownSerializerOptions = {
            includeMetadata: false,
            includePageNumbers: true,
            includeElementIds: false,
            includeCoordinates: false,
            preserveHierarchy: true,
            escapeSpecialChars: true,
            includeFormFields: true,
            includeImageMetadata: true
        };

        // Convert to markdown
        const markdown = serializeToMarkdown(result, markdownOptions);

        const screenshot = await this.require(BrowserConnector).getHarness().screenshot();
        checkOperation();
        const data = await this.models.extract(instructions, schema, screenshot, markdown);

        checkOperation();
        this.browserAgentEvents.emit('extractDone', instructions, data);

        return data;
    }

    // async check(description: string): Promise<boolean> {
    //     //const screenshot = await this.require(BrowserConnector).getHarness().screenshot();
    //     return await this.macro.check(description, screenshot);
    // }
}
