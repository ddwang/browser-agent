import type { BasetenClient } from './types';

export const DEFAULT_BASETEN_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash';
export const DEFAULT_BASETEN_BASE_URL = 'https://inference.baseten.co/v1';

export function validateBasetenOptions({ model, reasoningEffort }: BasetenClient['options']): void {
    // https://docs.baseten.co/inference/model-apis/reasoning
    // Other models have different supported levels; leave those to the provider.
    if (model === DEFAULT_BASETEN_MODEL && reasoningEffort !== undefined
        && !['none', 'low', 'high', 'max'].includes(reasoningEffort)) {
        throw new Error(`${model} reasoning effort must be none, low, high, or max.`);
    }
}
