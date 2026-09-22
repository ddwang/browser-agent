import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { askDjev, labels, protocolRecord, type Label } from './protocol';
import { percentile, writeJson } from '../webvoyager/results';
import type { Episode } from './capture';

export interface Prediction {
    episode: string; image: string; truth: Label | null; elapsedMs: number;
    decision?: { choice: Label; model: string };
    error?: string;
}

export function summarizeReplay(predictions: Prediction[]) {
    const labelled = predictions.filter(row => row.truth !== null);
    const answered = labelled.filter(row => row.decision && row.decision.choice !== 'unclear');
    const correct = answered.filter(row => row.decision!.choice === row.truth);
    const confusion = Object.fromEntries(labels.map(label => [label, Object.fromEntries([...labels, 'error'].map(choice => [choice, 0]))]));
    for (const row of labelled) confusion[row.truth!][row.decision?.choice ?? 'error']++;
    const fraction = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
    return {
        attempted: predictions.length, labelled: labelled.length, unlabelled: predictions.length - labelled.length,
        errors: predictions.filter(row => row.error).length,
        abstentions: labelled.filter(row => row.decision?.choice === 'unclear').length,
        accuracyAllLabelled: fraction(correct.length, labelled.length),
        acceptedPrecision: fraction(correct.length, answered.length), coverage: fraction(answered.length, labelled.length),
        falseEmpty: labelled.filter(row => row.decision?.choice === 'empty_results' && row.truth !== 'empty_results').length,
        falseReady: labelled.filter(row => ['loading', 'load_error', 'login', 'verification'].includes(row.truth!)
            && ['results', 'result_detail', 'empty_results'].includes(row.decision?.choice ?? '')).length,
        statesNotCaptured: labels.filter(label => label !== 'unclear' && !labelled.some(row => row.truth === label)),
        latencyMs: { firstRequest: predictions[0]?.elapsedMs ?? null, median: percentile(predictions.map(row => row.elapsedMs), 0.5),
            p95: percentile(predictions.map(row => row.elapsedMs), 0.95), laterRequestsMedian: percentile(predictions.slice(1).map(row => row.elapsedMs), 0.5) },
        models: [...new Set(predictions.flatMap(row => row.decision ? [row.decision.model] : []))],
        confidenceMeaning: 'Uncalibrated concentration, not probability of correctness. No confidence threshold is used.',
        confusion,
    };
}

export async function replay(captureDir: string, outputDir: string, episodeIds: string[], endpoint: string, key: string, timeoutMs: number,
    signal: AbortSignal, request = fetch) {
    const episodes = episodeIds.map(id => {
        if (!/^[a-z-]+$/.test(id)) throw new Error('Invalid episode directory');
        const path = join(captureDir, id, 'episode.json');
        const episode: Episode = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))
            : { caseId: id, status: 'interrupted', passed: false, samples: [], cleanupErrors: [], error: 'No saved episode' };
        if (episode.caseId !== id || !Array.isArray(episode.samples) || episode.samples.some(sample =>
            sample.oracle?.label !== null && !labels.includes(sample.oracle?.label as Label))) throw new Error('Invalid episode metadata');
        return episode;
    });
    const manifest = JSON.parse(readFileSync(join(captureDir, 'manifest.json'), 'utf8'));
    mkdirSync(outputDir, { recursive: false }); // Refuse to overwrite or selectively resume a replay.
    writeJson(join(outputDir, 'protocol.json'), protocolRecord);
    const predictions: Prediction[] = [];
    const save = () => writeJson(join(outputDir, 'report.json'), {
        capture: manifest, protocolHash: protocolRecord.hash, endpoint, timeoutMs, interrupted: signal.aborted,
        expectedEpisodes: episodeIds.length,
        expectedScreenshots: episodes.reduce((sum, episode) => sum + episode.samples.length, 0),
        baseline: episodes.map(({ caseId, status, passed, elapsedMs, captureOverheadMs, actionCount, plannerCalls, usage, score, cleanupErrors }) =>
            ({ caseId, status, passed, elapsedMs, captureOverheadMs, actionCount, plannerCalls, usage, score, cleanupErrors })),
        ...summarizeReplay(predictions), predictions,
        limitations: ['Offline classification only; no task-speedup or live outcome comparison.',
            'Labels are fixture DOM oracles bracketed around the actor screenshot, not human-reviewed clinical judgments.',
            'Correlated frames from an episode are not independent trials. Seeds do not create new layouts.',
            'Observation-boundary sampling can miss transient loading/errors. Inspect statesNotCaptured.'],
    });
    save();
    for (const episode of episodes) {
        if (signal.aborted) break;
        const id = episode.caseId;
        for (const sample of episode.samples) {
            if (signal.aborted) break;
            const started = performance.now();
            const row: Prediction = { episode: id, image: sample.image, truth: sample.oracle.label, elapsedMs: 0 };
            try {
                if (!/^\d{4}\.png$/.test(sample.image)) throw new Error('Invalid screenshot path');
                const bytes = readFileSync(join(captureDir, id, sample.image));
                const metadata = await sharp(bytes).metadata();
                if (metadata.format !== 'png' || !metadata.width || !metadata.height || metadata.width > 2048 || metadata.height > 2048) {
                    throw new Error('Invalid screenshot format or dimensions');
                }
                row.decision = await askDjev(bytes, endpoint, key, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), request);
            } catch (error) {
                row.error = error instanceof Error && /^Djev HTTP \d+$/.test(error.message) ? error.message
                    : signal.aborted ? 'interrupted' : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'invalid_or_unavailable';
            }
            row.elapsedMs = performance.now() - started;
            predictions.push(row);
            save(); // Each first attempt survives interruption; no automatic retries.
        }
    }
    return summarizeReplay(predictions);
}
