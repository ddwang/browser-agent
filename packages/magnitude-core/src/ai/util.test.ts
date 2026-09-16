import { expect, test } from 'bun:test';
import { buildDefaultBrowserAgentOptions, convertToBamlClientOptions, tryDeriveUIGroundedClient } from './util';
import type { LLMClient } from './types';

test('OpenAI option conversion preserves explicit values without injecting sampling defaults', async () => {
    expect(await convertToBamlClientOptions({ provider: 'openai', options: { model: 'gpt-5.6-luna' } }))
        .toEqual({ model: 'gpt-5.6-luna' });
    expect(await convertToBamlClientOptions({ provider: 'openai', options: {
        model: 'gpt-5.6-luna', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:8080/v1',
        temperature: 0, reasoningEffort: 'none', maxCompletionTokens: 4096,
    } })).toEqual({ model: 'gpt-5.6-luna', api_key: 'fixture', base_url: 'http://127.0.0.1:8080/v1',
        temperature: 0, reasoning_effort: 'none', max_completion_tokens: 4096 });
});

test('browser defaults leave OpenAI sampling unset while retaining Claude defaults', () => {
    const llm: LLMClient[] = [
        { provider: 'openai', options: { model: 'gpt-5.6-luna', reasoningEffort: 'high' } },
        { provider: 'anthropic', options: { model: 'claude-haiku-4-5-20251001' } },
    ];
    const result = buildDefaultBrowserAgentOptions({ agentOptions: { llm }, browserOptions: {} });
    expect(llm[0].options).toEqual({ model: 'gpt-5.6-luna', reasoningEffort: 'high' });
    expect(llm[1].options).toEqual({ model: 'claude-haiku-4-5-20251001', temperature: 0.2 });
    expect(result.browserOptions.virtualScreenDimensions).toEqual({ width: 1024, height: 768 });
});

test('environment discovery supports OpenAI alone and preserves Anthropic precedence', () => {
    const previous = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
    try {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
        expect(tryDeriveUIGroundedClient()).toBeNull();
        expect(() => buildDefaultBrowserAgentOptions({ agentOptions: {}, browserOptions: {} })).toThrow('OPENAI_API_KEY');
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
    }
});
