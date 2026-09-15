# Native structured-output experiment

## Hypothesis fixed before evaluation

Provider-enforced JSON schemas should remove prose/XML output failures without
adding task-specific reasoning hints. This tests a protocol mechanism, not better
knowledge of the development task answers. The cross-site holdout was frozen in
commit `e81b521` before this implementation, and has not been run.

## Implementation

- Reuse the action definitions for both BAML's prompt and the native JSON schema.
- Use `output_config.format` for known supporting direct Anthropic models, including
  the configured Haiku actor and Sonnet 5 judge. Keep an explicit opt-out and the
  existing path for other providers, older models, and unsupported schema shapes.
- Keep original Zod validation. Schema conversion does not silently close arbitrary
  maps or truncate recursive types. Unsupported value constraints remain described
  to the model and validated locally.
- Keep invocation-local usage, including failures and retries. Per-call client
  registries isolate different concurrent output schemas.
- Fail on provider refusal or output-token exhaustion, even if the parser can
  recover an object. Do not execute a partial batch, retry a refusal, or raise limits.

No browser-task text, acceptance criteria, site-specific instructions, model IDs,
temperatures, action limits, payload limits, or judge rubric changed. The judge's
output format is now provider-enforced; the numeric judge version remains unchanged
as requested. Compare source hashes, not just the numeric version.

References: [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
and [BAML provider option pass-through](https://docs.boundaryml.com/ref/llm-client-providers/anthropic).
The project retains BAML 0.202 and Zod 3; no SDK or dependency upgrade was needed.

## Independent checks

276 offline tests pass, including 64 generated action/schema variants, full browser
action-vocabulary conversion, reused definitions, unsupported shapes, local value
constraints, usage on failed responses, concurrent schema isolation, and terminal
refusal/truncation behavior. Core build and both type checks pass.

Live synthetic API probes, unrelated to browser tasks:

- Random token extraction with Haiku and Sonnet 5: passed.
- Random action name with one-action vocabulary: passed without a format retry.
- Full browser vocabulary plus random record action: valid JSON, but the first
  probe's single-action assertion failed because its wording requested waiting and
  the model added a valid wait action. This was not a format failure or a browser
  benchmark attempt. The diagnostic is preserved in `.context`.
- Clarified synthetic one-action request with full vocabulary: all three checks
  passed. Only probe wording changed; agent prompts and benchmark criteria did not.

Probe artifacts are in `.context/structured-output-*.json`. The initial failed
probe did not persist usage on failure; that diagnostic limitation was fixed, and
its small unrecorded cost must not be represented as zero.

## Browser evaluation

Complete first-attempt development run, with no mid-run code/configuration changes:

- Directory: `results/2026-09-15T08-47-07.121Z` (raw evidence is local/gitignored).
- Revision: `d2ac92f136391e7a29a9743a15ea955a287c4f18`, clean worktree.
- Source hash: `662ad5fa54865a2669d51d9c455a582f034f0e3afd37bfc826dc767e175f5f36`.
- Same Haiku actor (temperature 0.2), Sonnet 5 judge (temperature 1), one worker,
  100-action limit, 24 MiB saved-memory limit, and 1,200/300-second deadlines.

| Task | Outcome | Actions | Actor calls |
| --- | --- | ---: | ---: |
| ArXiv Hard--0 | Fail: author count contradicts the visible list | 19 | 13 |
| ArXiv Hard--1 | Pass | 25 | 15 |
| ArXiv Hard--2 | Fail: missed a later version before the cutoff | 34 | 20 |
| ArXiv Hard--3 | Pass | 11 | 9 |
| Huggingface Hard--0 | Fail: capacity substituted for truncation length | 27 | 18 |
| Huggingface Hard--1 | Fail: required configuration file not inspected | 39 | 36 |
| Huggingface Hard--2 | Pass | 10 | 10 |
| Huggingface Hard--3 | Pass | 12 | 12 |
| GitHub Hard--0 | Pass | 15 | 14 |
| GitHub Hard--1 | Runner error after final answer; not scored | 86 | 72 |
| GitHub Hard--2 | Fail: ambiguous closed item not verified | 72 | 58 |
| GitHub Hard--3 | Pass | 12 | 12 |

Totals: **6/12 passes (50%)**, five judged failures, one runner error, 362 actions,
287 actor calls, and 11 judge calls. Every actor call corresponds to a recorded
plan: no extra format retries or malformed plans. No judge-format errors, recorded
HTTP 429s, timeouts, access-block outcomes, or budget failures occurred. Background
401/404 responses were recorded; those are not proof of a page rate limit.

Reported cost: $1.99275245 actor + $1.15463650 judge = **$3.14738895**. Median actor
time was 132.602 seconds; p95 was 488.727 seconds. Histories stayed below 24 MiB.

The runner error was `Worker exited without a final result`. The worker printed
its final answer, finished, and stopped; its saved history includes all 86 actions,
but the parent classified its status as unfinished. Preserve this attempt as an
error, not a retrospectively repaired pass. A read-only file watcher confirmed
that the following two workers wrote completed statuses normally. The cause needs
an independent large-history/checkpoint reproduction.

## Interpretation and limits

The protocol mechanism worked in this run. Overall task success moved from 5/12
to 6/12, but actions, latency, and cost increased. This is **not evidence of a broad
efficiency gain**. The same small development suite has been inspected repeatedly;
single-run differences can reflect actor and judge variance. For example, the
tagged-file task changed verdict across runs with related viewing workflows.
The milestone judge also inferred a likely item-type error from an icon; its
reasoning is not an independently verified ground-truth label. Keep the recorded
verdicts and these limitations, rather than adjusting the rubric after seeing them.

Before exposing the untouched holdout, investigate generic recovery-state capture,
nested memory serialization, runner finalization, and holdout CLI protections with
synthetic tests. No task-specific hints or answer substitutions are planned.
