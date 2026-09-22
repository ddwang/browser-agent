# Integrate Magnitude into another agent

Read this guide when adding browser automation to a host agent such as Hermes or Ari. It tracks the current source of the `ddwang/browser-agent` fork, published as `@ddwang/magnitude-core`, not the upstream package. npm releases can lag behind source; verify that your installed package supports the features you use.

Magnitude executes browser tasks. Your host agent owns user intent, permissions, authentication, session isolation, and verification of business outcomes.

## Choose the integration boundary

Use the SDK to delegate a bounded browser task to Magnitude's model. The host model does not need to produce mouse coordinates. Magnitude's browser model must accept screenshots and ground actions in them.

- **JavaScript or TypeScript host:** import `@ddwang/magnitude-core` directly.
- **Python or another runtime:** wrap the SDK in a Node worker using your host's existing subprocess or service transport. Keep a worker alive only when you need browser-session reuse. This repository does not provide a Hermes plugin or a production worker protocol.
- **MCP host:** a thin MCP adapter around the SDK is an option, but must be implemented by the integrator. The existing [magnitude-mcp package](packages/magnitude-mcp/package.json) depends on upstream `magnitude-core`, not `@ddwang/magnitude-core`; do not assume it includes this fork's cancellation or diagnostics.

Start with task-level delegation. Add low-level browser tools only if the host needs to control individual actions. Do not copy Magnitude's planner, retry loop, or notebook into the host.

## Install

Use Node.js 22 or newer for the examples. Install this scoped package, not upstream `magnitude-core`:

```sh
npm install @ddwang/magnitude-core
npm install --save-dev tsx
npx --no-install patchright install chromium
```

The SDK uses Patchright through an npm dependency named `playwright`; its browser installer is named `patchright`. Use the installed binary so the browser matches the driver. On Linux, the installer may also need `--with-deps` and permission to install system packages. Commit your lockfile for reproducible installs, and update it deliberately when adopting new releases.

Provide model credentials through the worker environment or your secret manager. The SDK does not load a `.env` file for you. Import the SDK's `z` export for compatible schemas; do not assume a separately installed Zod major version is compatible.

## Run a bounded read-only example

Set `ANTHROPIC_API_KEY` and `BROWSER_MODEL` to a screenshot-capable model available to your account. Save this as `browser-task.mts`:

```ts
import { startBrowserAgent, z } from '@ddwang/magnitude-core';

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.BROWSER_MODEL;
if (!apiKey || !model) {
  throw new Error('Set ANTHROPIC_API_KEY and BROWSER_MODEL');
}

const agent = await startBrowserAgent({
  llm: { provider: 'anthropic', options: { model, apiKey } },
  browser: {
    launchOptions: { headless: true },
    contextOptions: { viewport: { width: 1280, height: 720 }, acceptDownloads: true },
  },
  telemetry: false,
  narrate: false,
  maxActions: 30,
  recovery: { noProgress: true, repeatedActionLimit: 6 },
  visuals: { animateCursor: false },
});

const controller = new AbortController();
const onInterrupt = () => controller.abort('Interrupted by caller');
process.once('SIGINT', onInterrupt);

try {
  // One absolute deadline for navigation and extraction together.
  const controls = { signal: controller.signal, deadline: Date.now() + 60_000 };
  await agent.nav('https://example.com', controls);
  const data = await agent.extract(
    'Read the page title and summarize its visible purpose.',
    z.object({ title: z.string(), summary: z.string() }),
    controls,
  );
  console.log(JSON.stringify({ outcome: 'observed', data }));
} finally {
  // Appropriate for a one-off worker, not a reusable-session request handler.
  try { await agent.stop(); }
  finally { process.off('SIGINT', onInterrupt); }
}
```

```sh
MAGNITUDE_LOG_LEVEL=silent MAGNITUDE_NARRATE= npx --no-install tsx browser-task.mts
```

This example makes a model request and can incur charges. It does not need an `act()` call to read a known page. Extraction is model-produced data, not independent proof that the data is correct.

The operation deadline starts **after startup**. `startBrowserAgent()`, `start()`, and `stop()` do not accept per-operation cancellation options. Bound worker startup and retirement separately in the host. For a JSON-lines or MCP adapter, reserve stdout for protocol messages: narration must stay off, and SDK logs must be disabled or routed separately. Account for `MAGNITUDE_NARRATE`, which can enable narration even with `narrate: false`.

## Select the model explicitly

Supply `llm` even when credentials are already in the environment. Automatic selection prioritizes Anthropic, then OpenAI, then Baseten; an unrelated key can otherwise change the actor.

The following are alternative `llm` values, not additional agents or judge configurations:

```ts
import type { LLMClient } from '@ddwang/magnitude-core';

const openai: LLMClient = {
  provider: 'openai',
  options: {
    model: 'gpt-5.6-luna',
    apiKey: process.env.OPENAI_API_KEY,
    reasoningEffort: 'high',
  },
};

const baseten: LLMClient = {
  provider: 'baseten',
  options: {
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    apiKey: process.env.BASETEN_API_KEY,
    reasoningEffort: 'high',
  },
};
```

These identifiers are used by this fork; verify availability with your provider. Baseten defaults to `https://inference.baseten.co/v1`, not a deployment's predict endpoint, and never falls back to `OPENAI_API_KEY`. The SDK validates DeepSeek V4.1 Flash reasoning levels as `none`, `low`, `high`, or `max`; `medium` is rejected.

Output ceilings are `maxTokens` for Anthropic and Baseten, and `maxCompletionTokens` for OpenAI. They include reasoning where applicable. Omitted values use transport/provider defaults. Model-specific reasoning and sampling support varies; do not set a universal temperature or reasoning level across providers.

One `llm` covers `act`, `extract`, and `query`. An `llm` array can assign these `roles` separately; configure all three roles. There is no required judge in normal SDK use; benchmark judging is a separate evaluation workflow. See [provider types](packages/magnitude-core/src/ai/types.ts) and [configuration details](docs/reference/llm-providers.mdx).

## Map host tools to the public API

Use your host's existing tool registration and result format. These methods are SDK calls, not pre-registered Hermes or MCP tool names.

| SDK call | Purpose and return value |
| --- | --- |
| `agent.nav(url, controls)` | Navigate directly; returns `void`. |
| `agent.act(task, { ...controls, data, prompt, memory })` | Run a natural-language task; returns `void`, not a result object. Optional fields can be omitted. |
| `agent.extract(instructions, schema, controls)` | Read current page content and screenshot into a typed value. |
| `agent.query(question, schema, controls)` | Answer using task memory plus fresh connector observations; returns a typed value. Not the same DOM-extraction path as `extract()`. |
| `agent.exec(action, undefined, controls)` | Execute one registered action. Returns that action's result, often `undefined`. Does not run the planner. |
| `agent.page`, `agent.context` | Access Playwright directly. These calls bypass Magnitude's operation controls. |
| `agent.stop()` | Cancel active work and close the context. Not a per-request cancel or pause. |

For example, a host can call `act('Open the invoices page without changing any invoices', controls)`, then `extract()` with its invoice schema. Prefer short, verifiable tasks to a single open-ended instruction. Use the same absolute deadline across calls when they share one host request budget.

An `act()` resolution means the planner declared completion. Verify consequential actions against an authoritative receipt or application state before reporting success. A successful click, HTTP response, or model answer is not such verification.

If the host needs an explicit action, the action discriminator is `variant`:

```ts
await agent.exec(
  { variant: 'keyboard:escape' },
  undefined,
  { signal: controller.signal, deadline: Date.now() + 5_000 },
);
```

See [registered browser actions](packages/magnitude-core/src/actions/webActions.ts) for exact schemas. Mouse coordinates refer to the screenshot coordinate space used by the harness, which can differ from viewport coordinates. Use `act()` unless the host has the corresponding screenshot and understands that transformation.

## Bound execution and translate outcomes

There is no default deadline or finite action budget. Configure both. `maxActions` is an agent option, not an `act()` option; it counts planner actions, including notebook writes. The counter resets for each step in `act([...])`. It does not bound a host loop of direct `exec()` calls. The shared deadline bounds the whole multi-step call.

`recovery.noProgress` is opt-in. It detects repeated unchanged or previously seen states, but is a heuristic, not a timeout. Canvas or iframe workflows can need a different setting. Keep the deadline and action budget even when this guard is enabled.

Import error classes from `@ddwang/magnitude-core` and map them to your host's existing tool outcomes:

| Error | Host handling |
| --- | --- |
| `OperationCancelledError` | Report cancellation; do not assume an already-dispatched action was undone. |
| `OperationDeadlineError` | Report the deadline; preserve uncertainty about side effects. |
| `AgentBusyError` | The session has pending work. Queue or reject the request instead of issuing another action. |
| `ActionLimitError` | Report the action limit with available evidence. Do not automatically restart the task. |
| `BrowserBlockedError` | Inspect `block.reason`: `rate_limit`, `authentication`, `subscription`, or `no_progress`. Respect `block.retryAt` when present. |
| Other errors | Report a sanitized failure and diagnostics. Do not classify every failure as a rate limit. |

A cooldown that exceeds the remaining deadline returns `BrowserBlockedError` with its original `retryAt`; Magnitude does not retry early. A bare HTTP 403 or a slow model response does not establish a website rate limit.

For cancellation, call the request's `AbortController.abort()`. Magnitude rejects the call promptly and prevents subsequent action dispatch, but an already-sent browser command can still finish. Do not use `Promise.race()` with a timeout as a substitute for cancellation.

After cancellation, keep the session out of the pool while `agent.busy` is true. Use `await agent.whenIdle()` in the scheduler, **not** in a request handler that must return at its deadline. If work never settles, retire the session. The lock is per agent; it does not protect a browser context shared by multiple agents or processes. A finished operation snapshot is not a substitute for idle.

Cancellation, failure, and deadline are execution outcomes. If a submission might have reached the site and cannot be verified, the host must also report an **unknown business outcome**, rather than retrying it automatically. See [cancellation and lifecycle details](docs/advanced/cancellation.mdx).

## Own sessions, authentication, and memory

- Give each concurrent operation an exclusive agent/context. Do not share cookies or notebook memory across users or unrelated authorization scopes.
- Reuse one idle agent for a related workflow when useful. A new `act()` starts fresh task memory by default; browser cookies and page state are separate and persist with the context.
- To continue task memory, pass `memory: agent.memory` explicitly to the next `act()`. Steps in one `act([...])` share memory. Follow the checkpoint guidance below when restoring saved memory. Checkpoints do not restore browser tabs, cookies, or login state, and restoring one must not imply replaying a possibly completed action.
- Saved memory can contain screenshots, URLs, page text, and model-written notes. Store it as sensitive data, bound retention, and do not return the entire audit to the host model by default. `query(..., { history: 'full' })` can be large and costly.
- Manage login verification, 2FA, consent, and browser storage state in the host. Notebook notes are summaries with source references, not authentication evidence.

Browser configuration accepts `browser: { context }`, `{ instance }`, `{ cdp }`, or `{ launchOptions, contextOptions }`. Passing a context directly is the explicit choice when the host needs isolation. `instance` and `cdp` reuse the first existing context if one exists; `contextOptions` will not reconfigure it.

**`agent.stop()` closes even a caller-supplied context.** Do not attach a context that another application expects to remain open. Direct Playwright calls and browser-side activity are outside the operation lock; a download can continue after `whenIdle()`. Use a fresh context when that activity makes reuse unsafe. See [browser ownership](packages/magnitude-core/src/web/browserProvider.ts) and [memory behavior](docs/advanced/memory.mdx).

### Checkpoint restoration

Save `await agent.memory.toJSON()`. Restore only checkpoints trusted for the current user and workflow: saved planner instructions are executable model instructions, not merely page evidence.

With the current source, restore saved memory and pass it to `act()`:

```ts
import { AgentMemory } from '@ddwang/magnitude-core';

const memory = new AgentMemory();
await memory.loadJSON(saved);
await agent.act('Continue the same authorized workflow', {
  memory,
  deadline: Date.now() + 60_000,
});
```

- `loadJSON()` restores serialized instructions, observations, and notes atomically. An absent instruction field clears previous instructions. Caching and thought-retention settings remain runtime configuration, not checkpoint data.
- When `act()` receives memory, it applies the receiving agent's model-specific caching configuration. Changing instructions or caching policy resets frozen retention and cache markers, not saved evidence. Unchanged values preserve the cached history.
- Current agent and call prompts, when supplied, replace saved instructions as a group; they are not appended repeatedly. If both are omitted, saved instructions remain. An explicit empty call prompt clears saved instructions when there is no agent prompt. Updated instructions are saved with the next checkpoint.

**Older-package compatibility:** Packages without these restoration fixes load only observations and notes and ignore current agent/call prompts when memory is supplied. For those packages, construct `AgentMemory` with `instructions: saved.instructions` and the appropriate `promptCaching` option before calling `loadJSON()`. Use `true` for Anthropic/Claude Code models with caching enabled, otherwise `false`. If you need different instructions, choose them explicitly in the constructor. Check your installed package before relying on the current-source behavior.

For judging or auditing a different actor's checkpoint, do not adopt its instructions. This repository's judge clears the instruction field on a copy and exposes the original text as labeled historical data. The task and grading rules remain authoritative.

## Optional observed-control targeting

With current source, `groundedControls: true` in `startBrowserAgent()` lets the existing planner click references to observed native links and buttons. No Jev or other provider is involved. Leave it omitted to retain screenshot-only targeting. Check your installed package for support before enabling it.

References identify current nodes, not selectors or remembered coordinates. The executor checks identity, context, visibility, enabled state, and hit target before dispatch; rejected refs stop the remaining batch and return fresh evidence. References expire at the next observation and cannot be reused through a later `exec()` or a checkpoint. Visual actions remain available for unsupported or ambiguous controls. Input submission is not completion verification.

This opt-in sends bounded labels and nearby page text to the configured model and retains them in memory. Do not treat it as redaction, permission enforcement, or read-only execution. See [observed-control scope and limits](docs/core-concepts/browser-interaction.mdx#observed-control-clicks-opt-in). It changes the observation/action space and has not established a live task-completion improvement.

## Use diagnostics without treating them as proof

Read `agent.operation` or subscribe to `agent.events.on('operation', snapshot => { ... })`. Keep event listeners synchronous and nonblocking. Error snapshots describe the time of failure; later events and the getter can contain additional evidence after draining.

- `id`, `status`, `outcome`, `phase`, `elapsedMs`, and `lastAction` locate the failure. Action states `started` and `failed` can both have side effects.
- `timings` separates model, action, screenshot, stability, cooldown, and other work. Totals overlap: use `elapsedMs` for wall-clock duration, not their sum.
- `providerAttempts` contains at most the latest 100 SDK attempts, including retries, once each invocation settles. Deduplicate by `(operationId, attempt)`. Null HTTP status or duration means unknown, not a proven timeout. Provider HTTP errors are separate from website blocks.
- `lastClick` includes dispatched coordinates, dimensions, and pre-dispatch hit tag/explicit role where known. It does not prove activation or retarget a click. Normal planner context keeps only the latest click state outside cached history.
- `browser-downloads` observations report `started`, `completed`, or `failed`. Completion means browser transfer completion, not verified file contents. These observations do not save files or return paths. The host must arrange file saving and content checks, with `acceptDownloads: true` and an open context.
- `tokensUsed` events report model usage separately from operation timings.

Operation diagnostics omit prompts and response bodies, but that does **not** redact ordinary logs, action events, memory, errors, or screenshots. Use nonsensitive custom action names and redact host outputs. See [diagnostic fields](docs/advanced/cancellation.mdx#operation-diagnostics) and [click/download evidence](docs/core-concepts/browser-interaction.mdx).

## Keep application policy in the host

Treat web pages, extracted data, and model-written notes as untrusted data, not instructions that can override the user's request. Enforce allowed destinations, private-network access, credential scope, and approval requirements outside model prompts. Magnitude is not a network sandbox or a permissions system.

Keep API keys out of tasks and `data`. Browser screenshots and extraction content are sent to the configured model provider; `telemetry: false` disables Magnitude telemetry, not model requests. Require the host's normal approval before purchases, messages, uploads, deletions, or other consequential changes. Do not bypass login barriers, CAPTCHAs, subscriptions, or site rate limits.

## Verify your adapter before deployment

Use local pages and stubbed model responses first. Test successful reading, typed limits, cancellation during a delayed model response, cancellation after action dispatch, busy-session rejection, reuse only after idle, and cleanup. Check that a cancelled submission is reported as uncertain and is not replayed. Test storage-state isolation and stdout framing if your transport uses it.

The repository's [offline verification commands](README.md#offline-verification) cover SDK regressions without live model credentials. They do not validate your host's permissions, session scheduler, or application success criteria. After offline checks, run a small read-only smoke test with your chosen live model; evaluate it on representative tasks, not only examples from the benchmark.
