import { 
    MultiMediaMessage
} from '@/ai/baml_client';
import { Observation, ObservationRetentionOptions, ObservationRole, ObservationSource } from './observation';
import z from 'zod';
import EventEmitter from 'eventemitter3';
import { jsonToObservableData, MultiMediaJson, observableDataToJson } from './serde';
import { applyMask, maskObservations } from './masking';
import { mergeMessages } from './util';
import { Image as BamlImage} from '@boundaryml/baml';
import { TaskNotebook, type NoteInput, type NoteSource } from './notebook';

// export interface AgentMemoryEvents {
//     'thought': (thought: string) => void;
// }

export interface SerializedAgentMemory {
    instructions?: string;
    notes?: NoteInput[];
    observations: {
        source: ObservationSource,
        role: ObservationRole,
        timestamp: number,
        data: MultiMediaJson,
        options?: ObservationRetentionOptions,
    }[];
}

export interface AgentMemoryOptions {
    instructions?: string | null,
    promptCaching?: boolean,
    thoughtLimit?: number, // TTL for thoughts
}

export interface MemoryRenderOptions {
    /** Full audit history bypasses actor retention without changing actor visibility or cache state. */
    history?: 'retained' | 'full';
}

// export interface FreezeState {
//     //lastFrozenObservationIndex: number,
//     // ^ just use length of mask
//     visibilityMask: boolean[],
// }

const CACHE_CONTROL_LIMIT = 3; // Anthropic allows max of 4, we use static one on system, 3 can be cyclic

export class AgentMemory {
    //public readonly events: EventEmitter<AgentMemoryEvents> = new EventEmitter();
    private options: Required<AgentMemoryOptions>;

    // Custom instructions relating to this memory instance (e.g. agent-level and/or task-level instructions)
    //public readonly instructions: string | null;

    private observations: Observation[] = [];
    private notebook = new TaskNotebook();
    private visibleSourceIds = new Set<number>();

    //private freezeState?: FreezeState;
    private freezeMask?: boolean[];
    private cacheControlIndices: number[] = [];

    constructor(options?: AgentMemoryOptions) {
        //this.instructions = instructions ?? null;
        this.options = {
            instructions: options?.instructions ?? null,
            promptCaching: options?.promptCaching ?? false,
            //optimizeForPromptCaching: false,
            thoughtLimit: options?.thoughtLimit ?? 20
        };
    }

    public get instructions() {
        // why is this on memory? prob should just be on agent
        return this.options.instructions;
    }

    public async render(options?: MemoryRenderOptions): Promise<MultiMediaMessage[]> {
        if (options?.history === 'full') {
            const messages: MultiMediaMessage[] = [];
            for (const [index, observation] of this.observations.entries()) {
                messages.push(await observation.render({ prefix: this.observationPrefix(observation, index) }));
            }
            const notes = this.notebook.render();
            if (notes) messages.push({ role: 'user', cacheControl: false, content: [notes] });
            return messages;
        }
        if (this.options.promptCaching && this.cacheControlIndices.length >= CACHE_CONTROL_LIMIT) {
            this.freezeMask = undefined;
            this.cacheControlIndices = [];
        }
        const mask = await maskObservations(this.observations, this.freezeMask);
        // Preserve complete note actions in the audit, not obsolete facts in actor context.
        this.observations.forEach((observation, index) => {
            if (observation.retention?.type === 'notebook-write') mask[index] = false;
        });

        const visibleObservations = applyMask(this.observations, mask);
        this.visibleSourceIds = new Set([
            ...visibleObservations.filter(({ observation }) => observation.source.startsWith('connector:')).map(({ index }) => index),
            ...this.notebook.sourceIds(),
        ]);

        const lastVisible = visibleObservations.at(-1);
        if (lastVisible) this.cacheControlIndices.push(lastVisible.index); // index WRT full observation list
        
        let messages: MultiMediaMessage[] = [];
        for (const { observation, index } of visibleObservations) {
            const message = await observation.render({
                prefix: this.observationPrefix(observation, index),
                cacheControl: this.options.promptCaching && this.cacheControlIndices.includes(index)
            });
            messages.push(message);
        }
        
        if (this.options.promptCaching) {
            this.freezeMask = mask;   
        }
        const notes = this.notebook.render();
        if (notes) messages.push({ role: 'user', cacheControl: false, content: [notes] });

        return messages;
    }

    public async simpleRender(): Promise<(BamlImage | string)[]> {
        return (await this.render({ history: 'full' })).flatMap(message => message.content);
    }

    private observationPrefix(observation: Observation, index: number): string[] {
        if (observation.source.startsWith('connector:')) return [`[Observation ${index}] ${observation.source}\n`];
        return observation.source.startsWith('action:taken') || observation.source === 'thought'
            ? [`[${new Date(observation.timestamp).toTimeString().split(' ')[0]}]: `] : [];
    }

    private resolveNoteSource(observations: Observation[], id: number): NoteSource {
        const observation = observations[id];
        if (!observation?.source.startsWith('connector:')) throw new Error(`Observation ${id} is not a captured connector source.`);
        const data = observation.content;
        const url = data && typeof data === 'object' && 'url' in data && typeof data.url === 'string' ? data.url : undefined;
        return { observation: id, capturedAt: observation.timestamp, ...(url !== undefined ? { url } : {}) };
    }

    public remember(note: NoteInput, expectedText?: string): void {
        this.notebook.put(note, id => {
            if (!this.visibleSourceIds.has(id)) throw new Error(`Observation ${id} is not shown in the current context or notebook.`);
            return this.resolveNoteSource(this.observations, id);
        }, expectedText);
    }

    public forget(key: string): void {
        this.notebook.forget(key);
    }

    public isEmpty(): boolean {
        return this.observations.length === 0;
    }

    public recordThought(content: string): void {
        this.observations.push(
            Observation.fromThought(content, { type: 'thought', limit: this.options.thoughtLimit })
        );
        //this.events.emit('thought', content);
    }

    public recordObservation(obs: Observation): void {
        this.observations.push(obs);
    }

    public getLastThoughtMessage(): string | null {
        for (let i = this.observations.length - 1; i >= 0; i--) {
            const obs = this.observations[i];
            // toString() is a little funky here, or the idea that thought might not just be text
            if (obs.source.startsWith('thought')) return obs.toString();
        }
        return null;
    }

    public async toJSON(): Promise<SerializedAgentMemory> {
        const observations = [];
        for (const observation of this.observations) {
            observations.push({
                source: observation.source,
                role: observation.role,
                timestamp: observation.timestamp,
                data: await observableDataToJson(observation.content),
                options: observation.retention,
            });
        }
        const notes = this.notebook.toJSON();
        return {
            // TODO: include other options as well
            ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
            ...(notes.length ? { notes } : {}),
            observations: observations
        };
    }

    // TODO: turn into class static method / rework cons
    public async loadJSON(data: SerializedAgentMemory) {
        //jsonToObservableData(data);
        const observations: Observation[] = [];
        for (const observation of data.observations) {
            observations.push(new Observation(
                observation.source,
                observation.role,
                await jsonToObservableData(observation.data),
                observation.options,
                observation.timestamp
            ));
            
        }
        // nvm
        //this.instructions = this.instructions;

        const notebook = new TaskNotebook();
        for (const note of data.notes ?? []) notebook.put(note, id => this.resolveNoteSource(observations, id));
        this.observations = observations;
        this.notebook = notebook;
        this.visibleSourceIds.clear();
        this.freezeMask = undefined;
        this.cacheControlIndices = [];


        // return {
        //     ...(this.instructions ? { instructions: this.instructions } : {}),
        //     observations: observations
        // };
    }
}
