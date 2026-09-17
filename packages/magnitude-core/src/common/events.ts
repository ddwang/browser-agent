
// Common interfaces that can be used anywhere
// Goal is not to expose internals but provide all necessary info in events

import { Action } from "@/actions/types";
import { ActOptions } from "@/agent";
import { LLMClientIdentifier, ModelUsage } from "@/ai/types";
import { LLMClient } from "@/ai/types";
import type { OperationDiagnostics } from './operation';

export interface AgentEvents {
    /** Payload-free snapshots. Existing action/thought events retain their original payloads. */
    'operation': (diagnostics: OperationDiagnostics) => void;
    'start': () => void;
    'stop': () => void;

    'thought': (thought: string) => void;

    'actStarted': (task: string, options: ActOptions) => void;
    'actDone': (task: string,  options: ActOptions) => void;
    
    'actionStarted': (action: Action) => void;
    'actionDone': (action: Action) => void;
    'observationsRecorded': () => void;
    'planningStarted': () => void;

    'pause': () => void;
    'resume': () => void;

    'tokensUsed': (usage: ModelUsage) => void;
}
