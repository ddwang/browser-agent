import type { Agent } from "@/agent"
import type { AgentMemory } from '@/memory/agentMemory';
import { RenderableContent } from "@/memory/observation";
import { z, Schema } from "zod"
import type { OperationOptions } from '@/common/operation';

export type ActionContext<T> = { input: T; agent: Agent; memory?: AgentMemory } & OperationOptions;

export interface ActionDefinition<T> {
    name: string;
    description?: string;
    schema: Schema<T>;
    resolver: (context: ActionContext<T>) => Promise<void | RenderableContent>;
    render: (action: T) => string
}

type ActionOptions<T> = Omit<ActionDefinition<T>, 'render'> & {
    render?: ActionDefinition<T>['render'];
};
type EmptyActionOptions = Omit<ActionOptions<Record<string, never>>, 'schema'> & { schema?: undefined };

export function createAction<T>(action: ActionOptions<T>): ActionDefinition<T>;
export function createAction(action: EmptyActionOptions): ActionDefinition<Record<string, never>>;
export function createAction<T>(action: ActionOptions<T> | EmptyActionOptions): ActionDefinition<T> | ActionDefinition<Record<string, never>> {
    if (action.schema !== undefined) {
        return { ...action, render: action.render ?? ((input: T) => JSON.stringify(input)) };
    }
    return { ...action, schema: z.object({}), render: action.render ?? ((input: Record<string, never>) => JSON.stringify(input)) };
}

// 2. Create a helper type to extract the payload structure for a single action
// This payload combines the 'name' (as a literal type) and the inferred schema.
export type ActionPayload<A extends ActionDefinition<any>> = { name: A['name'] } & z.infer<A['schema']>;
