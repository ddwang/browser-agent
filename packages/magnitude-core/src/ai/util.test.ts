import { expect, test } from 'bun:test';
import { buildDefaultBrowserAgentOptions, convertToBamlClientOptions, tryDeriveUIGroundedClient } from './util';
import type { LLMClient } from './types';
import { DEFAULT_BASETEN_MODEL } from './baseten';

test('Anthropic output limits are explicit and omitted limits retain transport defaults', async () => {
    const options = { model: 'claude-sonnet-5', apiKey: 'fixture', temperature: 1 };
    expect(await convertToBamlClientOptions({ provider: 'anthropic', options }))
        .toEqual({ model: options.model, api_key: 'fixture', temperature: 1 });
    expect(await convertToBamlClientOptions({ provider: 'anthropic', options: { ...options, maxTokens: 32_768 } }))
        .toEqual({ model: options.model, api_key: 'fixture', temperature: 1, max_tokens: 32_768 });
});

test('OpenAI option conversion preserves explicit values without injecting sampling defaults', async () => {
    expect(await convertToBamlClientOptions({ provider: 'openai', options: { model: 'gpt-5.6-luna' } }))
        .toEqual({ model: 'gpt-5.6-luna' });
    expect(await convertToBamlClientOptions({ provider: 'openai', options: {
        model: 'gpt-5.6-luna', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:8080/v1',
        temperature: 0, reasoningEffort: 'none', maxCompletionTokens: 4096,
    } })).toEqual({ model: 'gpt-5.6-luna', api_key: 'fixture', base_url: 'http://127.0.0.1:8080/v1',
        temperature: 0, reasoning_effort: 'none', max_completion_tokens: 4096 });
});

test('Baseten uses its own credentials, endpoint and token parameter', async () => {
    const previous = process.env.BASETEN_API_KEY;
    try {
        process.env.BASETEN_API_KEY = 'fixture-baseten';
        expect(await convertToBamlClientOptions({ provider: 'baseten', options: { model: DEFAULT_BASETEN_MODEL } }))
            .toEqual({ model: DEFAULT_BASETEN_MODEL, api_key: 'fixture-baseten', base_url: 'https://inference.baseten.co/v1' });
        expect(await convertToBamlClientOptions({ provider: 'baseten', options: {
            model: DEFAULT_BASETEN_MODEL, apiKey: 'override', baseUrl: 'http://127.0.0.1:8080/v1',
            temperature: 0, reasoningEffort: 'none', maxTokens: 4096,
        } })).toEqual({ model: DEFAULT_BASETEN_MODEL, api_key: 'override', base_url: 'http://127.0.0.1:8080/v1',
            temperature: 0, reasoning_effort: 'none', max_tokens: 4096 });
        for (const reasoningEffort of ['minimal', 'medium', 'xhigh'] as const) {
            await expect(convertToBamlClientOptions({ provider: 'baseten', options: { model: DEFAULT_BASETEN_MODEL, reasoningEffort } }))
                .rejects.toThrow('reasoning effort must be none, low, high, or max');
        }
        delete process.env.BASETEN_API_KEY;
        await expect(convertToBamlClientOptions({ provider: 'baseten', options: { model: DEFAULT_BASETEN_MODEL } }))
            .rejects.toThrow('Set BASETEN_API_KEY');
    } finally {
        if (previous === undefined) delete process.env.BASETEN_API_KEY;
        else process.env.BASETEN_API_KEY = previous;
    }
});

test('browser defaults leave OpenAI and Baseten sampling unset while retaining Claude defaults', () => {
    const llm: LLMClient[] = [
        { provider: 'openai', options: { model: 'gpt-5.6-luna', reasoningEffort: 'high' } },
        { provider: 'anthropic', options: { model: 'claude-haiku-4-5-20251001' } },
        { provider: 'baseten', options: { model: DEFAULT_BASETEN_MODEL, reasoningEffort: 'high' } },
    ];
    const result = buildDefaultBrowserAgentOptions({ agentOptions: { llm }, browserOptions: {} });
    expect(llm[0].options).toEqual({ model: 'gpt-5.6-luna', reasoningEffort: 'high' });
    expect(llm[1].options).toEqual({ model: 'claude-haiku-4-5-20251001', temperature: 0.2 });
    expect(llm[2].options).toEqual({ model: DEFAULT_BASETEN_MODEL, reasoningEffort: 'high' });
    expect(result.browserOptions.virtualScreenDimensions).toEqual({ width: 1024, height: 768 });
});

test('environment discovery supports Baseten alone and preserves existing provider precedence', () => {
    const previous = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, baseten: process.env.BASETEN_API_KEY };
    try {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.BASETEN_API_KEY;
        expect(tryDeriveUIGroundedClient()).toBeNull();
        expect(() => buildDefaultBrowserAgentOptions({ agentOptions: {}, browserOptions: {} })).toThrow('OPENAI_API_KEY');
        process.env.BASETEN_API_KEY = 'fixture-baseten';
        const baseten = buildDefaultBrowserAgentOptions({ agentOptions: {}, browserOptions: {} });
        expect(baseten.agentOptions.llm).toEqual([{ provider: 'baseten', options: { model: DEFAULT_BASETEN_MODEL, apiKey: 'fixture-baseten' } }]);
        expect(baseten.browserOptions.virtualScreenDimensions).toBeUndefined();
        process.env.OPENAI_API_KEY = 'fixture-openai';
        expect(tryDeriveUIGroundedClient()).toEqual({ provider: 'openai', options: { model: 'gpt-5.6-luna', apiKey: 'fixture-openai' } });
        const defaults = buildDefaultBrowserAgentOptions({ agentOptions: {}, browserOptions: {} });
        expect(defaults.agentOptions.llm).toEqual([{ provider: 'openai', options: { model: 'gpt-5.6-luna', apiKey: 'fixture-openai' } }]);
        expect(defaults.browserOptions.virtualScreenDimensions).toBeUndefined();
        process.env.ANTHROPIC_API_KEY = 'fixture-anthropic';
        expect(tryDeriveUIGroundedClient()?.provider).toBe('anthropic');
        const explicit: LLMClient = { provider: 'openai', options: { model: 'gpt-5.6-luna', temperature: 0 } };
        expect(buildDefaultBrowserAgentOptions({ agentOptions: { llm: explicit }, browserOptions: {} }).agentOptions.llm).toEqual([explicit]);
        expect(explicit.options.temperature).toBe(0);
    } finally {
        if (previous.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previous.anthropic;
        if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous.openai;
        if (previous.baseten === undefined) delete process.env.BASETEN_API_KEY;
        else process.env.BASETEN_API_KEY = previous.baseten;
    }
});
