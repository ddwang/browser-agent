#!/usr/bin/env bun
import { Command, Option, InvalidArgumentError } from 'commander';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_BASETEN_MODEL, validateBasetenOptions } from '../../packages/magnitude-core/src/ai/baseten';
import { writeJson, type ModelConfig } from '../webvoyager/results';
import { caseIds, suiteCases, checkSimulator, controlClient, loadSuite, localOrigin, portals, type PortalId, type SuiteName } from './portal';
import { checkHoldout, djevEndpoint, protocolHash } from './protocol';
import type { CaptureConfig, Episode, EpisodeJob } from './capture';
import { replay } from './replay';

interface Manifest extends CaptureConfig { synthetic: true; revision: string; dirty: boolean; protocolHash: string; episodes: string[]; }
const json = (filename: string) => JSON.parse(readFileSync(filename, 'utf8'));
function positive(value: string) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) throw new InvalidArgumentError('Expected a positive integer');
    return n;
}
async function interrupted<T>(work: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try { return await work(controller.signal); }
    finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

function worker(directory: string, timeoutMs: number, signal: AbortSignal) {
    return new Promise<{ code: number | null; timedOut: boolean }>((resolveWorker, reject) => {
        const child = spawn(process.execPath, [join(import.meta.dir, 'capture.ts'), directory], { stdio: 'inherit' });
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 10_000); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs + 5_000);
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', stop); };
        child.on('error', error => { cleanup(); reject(error); });
        child.on('exit', code => { cleanup(); resolveWorker({ code, timedOut }); });
    });
}

const program = new Command().name('portal-djev').description('Synthetic portal capture and offline Djev replay. No production SDK integration.');
const holdoutOptions = (command: Command) => command
    .option('--allow-holdout', 'Acknowledge Kaiser holdout exposure; run all cases without selective reruns')
    .option('--protocol <file>', 'Frozen protocol.json from a development replay');

holdoutOptions(program.command('capture')
    .description('Run synthetic portal tasks with Magnitude; record screenshots and independent outcomes, without calling Djev')
    .requiredOption('--portal-root <path>', 'Trusted local MySimChart checkout, used only by the evaluator')
    .requiredOption('--out <directory>', 'New output directory; never overwritten')
    .addOption(new Option('--portal <name>').choices(Object.keys(portals)).default('ucsd'))
    .addOption(new Option('--suite <name>').choices(Object.keys(suiteCases)).default('retrieval'))
    .option('--case <id>', 'One development case for smoke testing; default: the complete selected suite')
    .option('--browser-url <origin>', 'Override the selected loopback browser origin')
    .option('--control-url <origin>', 'Override the selected loopback control origin')
    .addOption(new Option('--provider <provider>').choices(['baseten', 'openai', 'anthropic']).default('baseten'))
    .option('--model <name>', 'Actor model (default: Baseten DeepSeek V4.1 Flash)')
    .addOption(new Option('--reasoning-effort <level>').choices(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
    .option('--timeout <seconds>', 'Whole episode deadline, including login and extraction', positive, 600)
    .option('--max-actions <count>', 'Existing per-act action budget', positive, 80)
    .option('--seed <number>', 'Fixture seed; different seeds are not new layouts', positive, 42)
    .option('--grounded-controls', 'Enable PR #9 observed controls; recorded in the baseline manifest')
    .option('--trace-decisions', 'Save synthetic planner inputs/outputs and sidecar controls for offline decision analysis')
    .option('--dry-run', 'Validate and print configuration without creating runs or making model calls'))
    .action(async options => {
        const portal = options.portal as PortalId;
        const suiteName = options.suite as SuiteName;
        if (suiteName === 'writes' && portal !== 'ucsd') throw new Error('Write evaluation is development-only (UCSD); Kaiser remains held out.');
        checkHoldout(portal, !!options.allowHoldout, options.protocol);
        if (portal === 'kaiser-permanente' && options.case) throw new Error('Holdout capture requires all six cases.');
        if (options.case && !(suiteCases[suiteName] as readonly string[]).includes(options.case)) throw new Error(`Unknown ${suiteName} case`);
        if (options.seed > 1_000_000) throw new Error('Seed exceeds simulator limit');
        const suite = await loadSuite(options.portalRoot, portal, suiteName);
        const config = portals[portal];
        const browserOrigin = localOrigin(options.browserUrl ?? `http://127.0.0.1:${config.port}`);
        const controlOrigin = localOrigin(options.controlUrl ?? `http://127.0.0.1:${config.controlPort}`);
        if (browserOrigin === controlOrigin) throw new Error('Browser and control services must be separate origins');
        const model = options.model ?? (options.provider === 'baseten' ? DEFAULT_BASETEN_MODEL : undefined);
        if (!model) throw new Error('Supply --model for a non-Baseten actor');
        if (options.provider === 'anthropic' && options.reasoningEffort) throw new Error('Anthropic does not support this reasoning-effort option');
        const actor: ModelConfig = { provider: options.provider, model,
            ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort }
                : options.provider === 'baseten' && model === DEFAULT_BASETEN_MODEL ? { reasoningEffort: 'high' } : {}) };
        if (actor.provider === 'baseten') validateBasetenOptions(actor);
        const manifest: Manifest = { synthetic: true, portal, portalRoot: resolve(options.portalRoot), browserOrigin, controlOrigin,
            actor, timeoutMs: options.timeout * 1000, maxActions: options.maxActions, seed: options.seed, groundedControls: !!options.groundedControls,
            suite: suiteName, suiteHash: suite.hash, traceDecisions: !!options.traceDecisions,
            protocolHash, episodes: options.case ? [options.case] : [...suiteCases[suiteName]],
            revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dir, encoding: 'utf8' }).trim(),
            dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: import.meta.dir, encoding: 'utf8' }).trim() };
        if (options.dryRun) { console.log(JSON.stringify(manifest, null, 2)); return; }
        if (!process.env[`${actor.provider.toUpperCase()}_API_KEY`]) throw new Error(`Set ${actor.provider.toUpperCase()}_API_KEY`);
        const control = controlClient(controlOrigin, process.env.SIM_CONTROL_TOKEN ?? '');
        await checkSimulator(browserOrigin, portal, control);
        const directory = resolve(options.out);
        mkdirSync(directory, { recursive: false });
        writeJson(join(directory, 'manifest.json'), manifest);
        await interrupted(async signal => {
            for (const id of manifest.episodes) {
                if (signal.aborted) { process.exitCode = 130; break; }
                const episodeDir = join(directory, id);
                mkdirSync(episodeDir);
                let runId: string | undefined;
                try {
                    const test = suite.cases.find(test => test.id === id)!;
                    const run = await control('/runs', 'POST', { seed: manifest.seed, scenario: test.scenario ?? 'baseline', require2fa: true });
                    if (!/^[a-f0-9-]{36}$/.test(run.id) || typeof run.loginPath !== 'string') throw new Error('Invalid isolated run response');
                    runId = run.id;
                    const job: EpisodeJob = { ...manifest, caseId: id, runId: run.id, loginPath: run.loginPath };
                    writeJson(join(episodeDir, 'job.json'), job);
                    const exit = await worker(episodeDir, manifest.timeoutMs, signal);
                    const resultPath = join(episodeDir, 'episode.json');
                    const result = existsSync(resultPath) ? json(resultPath) as Episode : { caseId: id, status: 'running', passed: false, samples: [], cleanupErrors: [] } as unknown as Episode;
                    if (result.status === 'running') {
                        result.status = signal.aborted ? 'interrupted' : exit.timedOut ? 'timeout' : 'error';
                        result.error = 'Worker exited without a completed outcome';
                    }
                    if (exit.code !== 0) result.cleanupErrors.push('worker_exit');
                    writeJson(resultPath, result);
                    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${portal}/${id}: ${result.samples.length} screenshots`);
                    if (!result.passed || result.cleanupErrors.length) process.exitCode = 1;
                } catch (error) {
                    const saved = join(episodeDir, 'episode.json');
                    const result = existsSync(saved) ? json(saved) : { caseId: id, status: 'running', passed: false, samples: [], cleanupErrors: [] };
                    if (result.status === 'running') {
                        result.status = signal.aborted ? 'interrupted' : 'error';
                        result.error = error instanceof Error ? error.name : 'Unknown error';
                    }
                    writeJson(saved, result);
                    process.exitCode = 1;
                } finally {
                    // Delete only the run this evaluator created. Never reset or delete demo.
                    if (runId) try { await control(`/runs/${runId}`, 'DELETE'); }
                    catch {
                        writeJson(join(episodeDir, 'cleanup.json'), { error: 'isolated_run_delete', runId });
                        process.exitCode = 1;
                    }
                }
            }
        });
    });

holdoutOptions(program.command('replay')
    .description('Sequentially classify saved synthetic screenshots with Djev; no browser actions')
    .argument('<capture-directory>')
    .requiredOption('--out <directory>', 'New report directory; never overwritten')
    .option('--endpoint <url>', 'Pinned Baseten Djev deployment URL; defaults to DJEV_ENDPOINT')
    .option('--timeout <seconds>', 'Per-request deadline; no automatic retries or cold-start waiting', positive, 10))
    .action(async (input, options) => {
        const directory = resolve(input);
        const manifest = json(join(directory, 'manifest.json')) as Manifest;
        if (manifest.synthetic !== true || !Object.keys(portals).includes(manifest.portal)) throw new Error('Invalid capture');
        if (manifest.suite && manifest.suite !== 'retrieval') throw new Error('Djev replay currently labels retrieval screens only; write captures are actor outcome evaluations.');
        if (manifest.portal === 'kaiser-permanente' && manifest.protocolHash !== protocolHash) throw new Error('Holdout capture protocol changed');
        checkHoldout(manifest.portal, !!options.allowHoldout, options.protocol);
        if (!Array.isArray(manifest.episodes) || !manifest.episodes.length || new Set(manifest.episodes).size !== manifest.episodes.length
            || manifest.episodes.some(id => !caseIds.includes(id as typeof caseIds[number]))) throw new Error('Invalid capture episodes');
        if (manifest.portal === 'kaiser-permanente' && JSON.stringify(manifest.episodes) !== JSON.stringify(caseIds)) throw new Error('Holdout replay requires the complete suite');
        const endpoint = djevEndpoint(options.endpoint ?? process.env.DJEV_ENDPOINT ?? '');
        const key = process.env.BASETEN_API_KEY;
        if (!key) throw new Error('Set BASETEN_API_KEY');
        const summary = await interrupted(signal => replay(directory, resolve(options.out), manifest.episodes, endpoint, key, options.timeout * 1000, signal));
        console.log(JSON.stringify(summary, null, 2));
        if (summary.errors) process.exitCode = 1;
    });

if (import.meta.main) await program.parseAsync().catch(error => { console.error(error.message); process.exitCode = 1; });
