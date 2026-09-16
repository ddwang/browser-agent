import { ActionDefinition } from '@/actions';
import { Observation } from '@/memory/observation';
import type { Action } from '@/actions/types';

export interface AgentConnector {
    // Unique connector ID (required)
    id: string;
    // Event handlers (optional)
    onStart?(): Promise<void>;
    onStop?(): Promise<void>;
    beforeAction?(action: Action): Promise<void>;
    onTaskStart?(): void;
    // Action space (optional)
    getActionSpace?(): ActionDefinition<any>[];
    // State retrieval (WIP)
    //viewState?(): Promise<Observation>;
    // Observation retrieval (WIP)
    collectObservations?(): Promise<Observation[]>;
    // TODO: unify ^ prob return ObservableData from both viewState/collectObservations? or union/option of either
    getInstructions?(): Promise<void | string>;
}

//export { BrowserConnector, BrowserConnectorOptions } from './browserConnector';
