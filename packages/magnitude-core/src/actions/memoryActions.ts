import { createAction } from '.';
import { z } from 'zod';
import { NOTEBOOK_LIMITS, noteSchema } from '@/memory/notebook';

export const memoryActions = [
    createAction({
        name: 'memory:note',
        description: 'Save exact observed facts needed later BEFORE scrolling or navigating away. Notes survive screenshot eviction. Reuse a key to correct/replace it. Cite supporting observation numbers; URLs are attached by the host. This consumes one action but does not interact with the browser.',
        schema: noteSchema,
        resolver: async ({ input, agent, memory }) => {
            try {
                (memory ?? agent.memory).remember(input);
                return { saved: input.key };
            } catch (error) {
                return { saved: false, error: String(error), instruction: 'No notes changed. Correct the references or consolidate/forget notes before retrying.' };
            }
        },
        render: input => `note: ${input.key}`,
    }),
    createAction({
        name: 'memory:forget',
        description: 'Remove an obsolete task note after consolidating any facts still needed. This does not delete the captured observation history.',
        schema: z.object({ key: z.string().min(1).max(NOTEBOOK_LIMITS.key) }),
        resolver: async ({ input, agent, memory }) => {
            (memory ?? agent.memory).forget(input.key);
            return { forgotten: input.key };
        },
        render: input => `forget note: ${input.key}`,
    }),
];
