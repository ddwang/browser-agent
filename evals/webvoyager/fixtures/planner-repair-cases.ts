// Shared, site-independent failures for both real loopback provider transports.
export const rejectedValue = 'UNTRUSTED_PLAN_VALUE';
const plan = { reasoning: 'Use observed evidence.', memory_updates: [], actions: [{ variant: 'click', x: 12 }] };
const note = { key: 'record', text: 'An observed fact.', sources: [0], operation: 'add', expected_text: null };

export const plannerRepairCases = [
    { value: { ...plan, actions: [{ variant: 'click', x: rejectedValue }] }, diagnostic: '$.actions[0].x: invalid_type (expected number)' },
    { value: { ...plan, actions: [{ variant: rejectedValue }] }, diagnostic: '$.actions[0].variant: unknown action' },
    { value: { ...plan, memory_updates: [{ ...note, sources: Array(9).fill(0) }] }, diagnostic: '$.memory_updates[0].sources: too_big (maximum 8, inclusive)' },
    { value: { ...plan, memory_updates: [{ ...note, text: rejectedValue.repeat(1000) }] }, diagnostic: '$.memory_updates[0].text: too_big (maximum 2000, inclusive)' },
    { value: { ...plan, actions: [] }, diagnostic: '$.actions: too_small (minimum 1, inclusive)' },
];
