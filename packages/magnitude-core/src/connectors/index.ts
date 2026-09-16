import { ActionDefinition } from '@/actions';
import { Observation } from '@/memory/observation';
import type { Action } from '@/actions/types';
import type { OperationOptions } from '@/common/operation';

export interface AgentConnector {
    // Unique connector ID (required)
    id: string;
    // Event handlers (optional)
    onStart?(): Promise<void>;
    onStop?(): Promise<void>;
    beforeAction?(action: Action, options?: OperationOptions): Promise<void>;
    onTaskStart?(options?: OperationOptions): void;
    // Action space (optional)
    getActionSpace?(): ActionDefinition<any>[];
    // State retrieval (WIP)
    //viewState?(): Promise<Observation>;
    // Observation retrieval (WIP)
    collectObservations?(options?: OperationOptions): Promise<Observation[]>;
    // TODO: unify ^ prob return ObservableData from both viewState/collectObservations? or union/option of either
    getInstructions?(options?: OperationOptions): Promise<void | string>;
}

//export { BrowserConnector, BrowserConnectorOptions } from './browserConnector';
