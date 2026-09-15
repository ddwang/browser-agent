import { expect, test } from 'bun:test';
import { checkpointWriter } from './checkpoint';

test('bursts coalesce and the final write includes the latest state', async () => {
    let state = 0;
    const snapshots: number[] = [];
    const writer = checkpointWriter(async () => { snapshots.push(state); }, () => {}, 1000);
    for (; state < 100; state++) writer.request();
    await writer.finish();
    writer.request(); // Late events after timeout/completion cannot overwrite the result.
    expect(snapshots).toEqual([100]);
});

test('an intermediate rejection does not poison later checkpoints or final persistence', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    let attempted = Promise.withResolvers<void>();
    const writer = checkpointWriter(async () => {
        calls++;
        attempted.resolve();
        if (calls === 1) throw new Error('Transient disk failure');
    }, error => { errors.push(error); }, 0);
    writer.request();
    await attempted.promise;
    attempted = Promise.withResolvers<void>();
    writer.request();
    await attempted.promise;
    await writer.finish();
    expect(calls).toBe(3);
    expect(errors).toHaveLength(1);
});

test('a slow checkpoint finishes before final persistence, without queuing every event', async () => {
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = checkpointWriter(async () => {
        calls++;
        if (calls === 1) { started.resolve(); await release.promise; }
    }, () => {}, 0);
    writer.request();
    await started.promise;
    for (let i = 0; i < 100; i++) writer.request();
    const finishing = writer.finish();
    expect(calls).toBe(1);
    release.resolve();
    await finishing;
    expect(calls).toBe(2);
});

test('a failed final write still rejects', async () => {
    const writer = checkpointWriter(async () => { throw new Error('Disk unavailable'); }, () => {});
    writer.request();
    await expect(writer.finish()).rejects.toThrow('Disk unavailable');
});
