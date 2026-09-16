// Coalesce observation bursts and keep at most one full-history write in flight.
// Intermediate failures are diagnostic; the final durable write remains required.
export function checkpointWriter(save: () => Promise<void>, onError: (error: unknown) => void, intervalMs = 2000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void> | undefined;
    let pending = false;
    let closed = false;

    function request() {
        if (closed) return;
        pending = true;
        if (timer || active) return;
        timer = setTimeout(() => {
            timer = undefined;
            pending = false;
            active = save().catch(onError).finally(() => {
                active = undefined;
                if (pending) request();
            });
        }, intervalMs);
    }

    async function finish() {
        closed = true;
        clearTimeout(timer);
        await active;
        await save();
    }

    return { request, finish };
}
