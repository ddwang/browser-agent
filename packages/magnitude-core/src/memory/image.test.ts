import { expect, spyOn, test } from 'bun:test';
import sharp from 'sharp';
import { Image } from './image';
import { Observation } from './observation';
import { AgentMemory } from './agentMemory';

test('rendering, hashes and checkpoints share one in-flight encoding per image', async () => {
    const image = new Image(sharp({ create: { width: 3, height: 4, channels: 3, background: '#123456' } }).png());
    const observation = Observation.fromConnector('fixture', { screenshot: image });
    const memory = new AgentMemory();
    memory.recordObservation(observation);
    const encode = spyOn(sharp.prototype, 'toBuffer');
    try {
        const [json] = await Promise.all([image.toJson(), memory.render(), observation.hash(), memory.toJSON(), image.getDimensions(), image.toBase64()]);
        await Promise.all([memory.render(), observation.hash(), memory.toJSON(), image.toBaml()]);
        expect(encode).toHaveBeenCalledTimes(1);
        expect(await image.getDimensions()).toEqual({ width: 3, height: 4 });
        json.base64 = 'Caller mutation';
        expect((await image.toJson()).base64).not.toBe('Caller mutation');
    } finally { encode.mockRestore(); }
});

test('an Image owns its pipeline configuration and resizing returns an independent image', async () => {
    const pipeline = sharp({ create: { width: 3, height: 4, channels: 3, background: '#123456' } }).png();
    const image = new Image(pipeline);
    pipeline.resize(10, 20).jpeg();
    expect(await image.getDimensions()).toEqual({ width: 3, height: 4 });
    expect(await image.getFormat()).toBe('png');
    const saved = await image.toJson();
    const resized = await image.resize(8, 9);
    expect(await resized.getDimensions()).toEqual({ width: 8, height: 9 });
    expect(await image.toJson()).toEqual(saved);
});

test('failed image encodings are retryable rather than cached rejections', async () => {
    const image = new Image(sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png());
    const encode = spyOn(sharp.prototype, 'toBuffer').mockRejectedValueOnce(new Error('Transient encoding failure'));
    try {
        await expect(image.toJson()).rejects.toThrow('Transient encoding failure');
        expect((await image.toJson()).format).toBe('png');
        expect(encode).toHaveBeenCalledTimes(2);
    } finally { encode.mockRestore(); }
});
