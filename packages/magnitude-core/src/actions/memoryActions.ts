import { createAction } from '.';
import { z } from 'zod';
import { NOTEBOOK_LIMITS, noteUpdateSchema } from '@/memory/notebook';

export const memoryActions = [
    createAction({
        name: 'memory:note',
        description: 'Add a new record or explicitly correct one existing record before leaving facts needed later. Adds never overwrite. Corrections must match the targeted note\'s current text. Cite supporting observations. This consumes one action without interacting with the browser.',
        schema: noteUpdateSchema,
        resolver: async ({ input, agent, memory }) => {
            try {
                const { operation, expected_text, ...note } = input;
                if (operation === 'add' ? expected_text !== null : expected_text === null) {
                    throw new Error('Use expected_text null for add; for correct, copy the targeted note\'s exact current text.');
                }
                (memory ?? agent.memory).remember(note, expected_text ?? undefined);
                return { saved: input.key };
            } catch (error) {
                return { saved: false, error: String(error), instruction: 'No notes changed. Review the error and notebook. New records need new keys; corrections need an exact current-text match. Preserve existing facts when addressing source or capacity errors.' };
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
