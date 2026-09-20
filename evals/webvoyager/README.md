# Browser performance evals

`baseline.json` is the main suite: 12 harder, explicit tasks on arXiv, Hugging Face,
and GitHub. Tasks require multi-constraint searches, cross-page comparisons,
stateful UI changes, or complete extraction. Each has acceptance criteria that
both the actor and Sonnet 5 judge receive. Finding a relevant page alone cannot pass.

Judge version 4 keeps saved actor instructions as labeled historical context, not
judge system instructions or additional grading criteria. The canonical task and
judge rules remain authoritative. Checkpoints are not rewritten. Earlier judge
versions remain historical results; use their matching source revision to judge
them again instead of changing a saved manifest's version.

The original 20-task baseline is preserved in `smoke.json`; the four-task scroll
suite is unchanged. The 590-task WebVoyager catalog is also unchanged. The new
suite uses distinct IDs and must not be compared directly with the old score.
It targets multi-step research workflows, not general browser coverage or an
official WebVoyager score. See [task coverage and reference checks](hard-suite.md).

All previously inspected suites are development data. The separate cross-site
holdout is reserved for a frozen candidate, not prompt tuning. Read the
[anti-overfitting protocol](EXPERIMENTS.md) before using `--allow-holdout`.

## Setup

From the repository root:

```sh
bun install --ignore-scripts
bun run --cwd packages/magnitude-extract build
bun run --cwd packages/magnitude-core build
```

Install Google Chrome. Set `ANTHROPIC_API_KEY` in your shell environment or a local,
gitignored `.env` file. The runner does not save credentials in result files.

The default actor is the project's Haiku 4.5 model; the judge is Sonnet 5
(`claude-sonnet-5`), with its required default temperature of 1 and default adaptive
thinking. New Sonnet 5 judge runs explicitly allow 32,768 output tokens, including
thinking and the verdict. Override this ceiling with `--judge-max-tokens`; it is
recorded as `judge.maxTokens` in the manifest. Other judge models retain their
transport's output limit unless overridden and use temperature 0. Override the actor with `--model`
and the judge with `--judge-model`.
`--provider` selects the actor provider independently of the judge. Existing
Magnitude Claude Code credentials can be used with `--provider claude-code`; this
also defaults the judge to Claude Code for backward compatibility. Override judge
authentication with `--judge-provider anthropic|claude-code`. Live Claude Code
authentication is not verified by the offline checks.

### OpenAI actor with Sonnet 5 judging

Add `OPENAI_API_KEY` alongside `ANTHROPIC_API_KEY` in `.env`, then run:

```sh
bun evals/webvoyager/wv.ts run --suite evals/webvoyager/baseline.json --provider openai --model gpt-5.6-luna --eval
```

With `--provider openai`, the actor defaults to `gpt-5.6-luna` and `medium`
reasoning effort; the judge remains Anthropic Sonnet 5 with temperature 1. Both
credentials are checked before starting a scored run. An unscored run only needs
the actor's key; separate `eval` only needs the saved judge's credentials.

Use `--reasoning-effort <level>` and `--max-completion-tokens <number>` to control
OpenAI reasoning and output limits. The latter includes reasoning tokens and
the visible plan. These options are saved in the manifest and cannot change
when resuming a run. No temperature is sent to OpenAI unless explicitly supplied
with `--temperature`; only set parameters supported by the selected model.
Other OpenAI models use API-default reasoning unless overridden. Add `--dry-run`
to inspect the exact configuration without credentials or model calls.

The OpenAI path uses the existing BAML Chat Completions adapter with screenshot
inputs and local schema validation. It does not yet enable OpenAI native
Structured Outputs. Plans still undergo strict whole-response validation and at
most one format-repair attempt. Refusals, content-filter stops, and output-token
truncation fail without executing a partial plan. Sonnet's native structured
output is unchanged by selecting an OpenAI actor; the shared judge contract is
described above.

Usage separates uncached input, cache reads, and cache writes. Completion-token
usage already includes reasoning tokens. Luna cost estimates use the
[documented standard pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
including cache-write and long-context rates; unknown model or cache prices remain
`null`. Offline transport/CLI checks establish compatibility, not task performance.
Do not reuse the consumed holdout to tune or claim a fresh model comparison.

### Baseten DeepSeek actor with Sonnet 5 judging

Add `BASETEN_API_KEY` alongside `ANTHROPIC_API_KEY` in your gitignored `.env`:

```sh
bun evals/webvoyager/wv.ts run --suite evals/webvoyager/baseline.json --provider baseten --eval
```

The Baseten actor defaults to `deepseek-ai/DeepSeek-V4.1-Flash` with `high`
reasoning effort. The judge remains Anthropic Sonnet 5. Both keys are checked
before a scored run; an unscored run only needs `BASETEN_API_KEY`. Baseten never
uses `OPENAI_API_KEY`. Add `--dry-run` to preview the manifest without credentials,
model calls, browser launches, or result files.

Use `--reasoning-effort none|low|high|max` for DeepSeek V4.1 Flash. Its default
matches [Baseten's reasoning API](https://docs.baseten.co/inference/model-apis/reasoning).
Use `--max-tokens <number>` to cap reasoning plus visible output (for example,
`--max-tokens 8192`). The OpenAI-specific `--max-completion-tokens` flag is not
accepted for Baseten. Temperature and token limits use API defaults unless set.
All explicit options are saved in the manifest and must match when resuming.
Other model slugs can be selected with `--model`; their supported reasoning
levels and image capabilities vary.

The Baseten path uses the shared BAML Chat Completions transport, screenshot
inputs, native JSON-schema output for supported schemas on the hosted Model API,
and strict local plan validation. The SDK's `structuredOutputs: false` opts out;
custom base URLs require `structuredOutputs: true` to enable native output.
Unsupported schema shapes retain prompt-only compatibility; provider errors do
not silently disable enforcement. Separate `reasoning_content` is not
parsed as a plan. Refusals and truncation fail without executing partial actions.
Native schema enforcement does not change prompts, notebook behavior, task
criteria, actor budgets, or judge settings. This output-mode change makes earlier prompt-only runs historical
comparisons, not measurements of the current candidate. Offline transport and CLI
tests do not establish live task performance.

An opt-in synthetic provider probe exercises typed extraction and a random action
vocabulary with notebook updates on DeepSeek V4.1 Flash and GLM 5.3 Flash:

```sh
bun evals/webvoyager/fixtures/structured-output-live.ts .context/baseten-structured-output-probe.json baseten
```

Use a new output path for every attempt. This checks API/schema compatibility,
not browser performance, and does not access the development or holdout sites.

DeepSeek V4.1 Flash cost estimates use Baseten's
[published Model API prices](https://www.baseten.co/library/deepseek-v41-flash/):
$0.30 per million uncached input tokens, $0.03 per million cached input tokens,
and $1.20 per million output tokens (verified September 15, 2026). Output usage
includes reasoning; cached input is not counted twice. Other Baseten model prices
remain unknown rather than inheriting another provider's rates. Use a fresh run
directory for each configuration; do not reuse the consumed holdout for tuning.

## Run a baseline

Preview the exact tasks and configuration without launching a browser, calling a
model, or creating files:

```sh
bun evals/webvoyager/wv.ts run --suite evals/webvoyager/baseline.json --dry-run
```

Run one harder task, including scoring:

```sh
bun evals/webvoyager/wv.ts run 'ArXiv Hard--0' --suite evals/webvoyager/baseline.json --eval
```

For scroll changes, start with the four scroll-heavy tasks (lasagna, both Apple
tasks, and GitHub storage):

```sh
bun evals/webvoyager/wv.ts run --suite evals/webvoyager/scroll-baseline.json --eval --workers 2
```

Run the main suite (one worker limits concurrent traffic to each site):

```sh
bun evals/webvoyager/wv.ts run --suite evals/webvoyager/baseline.json --eval --workers 1
```

Use `run ArXiv --suite ...` to select one site. For historical smoke comparisons,
use `--suite evals/webvoyager/smoke.json`. With no suite, task IDs and category
selection still refer to the original WebVoyager catalog.

Suites accept either `taskIds` from that catalog or explicit `tasks` objects, not
both. Explicit tasks contain `id`, `web_name`, `web`, and `ques`, plus optional
`criteria` and `capabilities`. Full tasks and criteria are saved in the manifest;
the viewer displays them. Invalid IDs, duplicate tasks, and malformed suites fail
before any browser or model starts.

The CLI prints a new timestamped run directory under `evals/webvoyager/results/`.
Use `--run-dir <path>` to name it explicitly. Each task gets one attempt; there are
no hidden browser-crash retries. `--timeout` sets the per-task limit in seconds
(default: 1200, including browser/model setup). The runner passes that same absolute
deadline and an abort signal into `act()`, so model calls, retries, and cooldowns
share the remaining time. A setup watchdog covers browser/model startup before
`act()` begins. After execution ends, the worker allows five seconds for cleanup
and in-flight work to settle. A final process watchdog kills workers that exceed
the task timeout plus 15 seconds and records a timeout.
Judges run in separate processes with a 300-second limit, configurable with
`--judge-timeout`. A judge timeout is recorded as `judge_error`.
The judge's output-token budget is separate from actor action limits, saved-trace
size limits, and both process deadlines. Raising it permits longer reasoning but
does not force the model to use the full allowance; actual usage is still counted.

To stop a run, press Ctrl+C or send SIGTERM to the coordinator. It stops taking
queued tasks and forwards SIGTERM to active workers, with a ten-second grace
period before a forced kill. Actor workers cancel their active operation and save
`cancelled` status, reported as `interrupted` in summaries. Already-saved completed
tasks and judge verdicts remain intact. Unstarted tasks remain `pending`.
Cancellation cannot undo a browser action already dispatched to a site.

Each run saves:

- `manifest.json`: selected task text and criteria, providers, models, sampling/reasoning options, timeouts, worker count,
  Git revision, dirty-worktree status, source/dependency hash, and judge version.
- `<task-id>.json`: observations, elapsed milliseconds, action count, model usage,
  execution status or error, operation diagnostics, and cleanup status/timing.
- `<task-id>.status.json`: a lightweight two-second heartbeat showing planning,
  actions, timed waits, detected barriers, recent HTTP diagnostics, agent lifecycle,
  busy state, and the latest operation snapshot.
- `<task-id>.eval.json`: judge verdict/reasoning, or a judge error, plus judge usage.
- `summary.json`: overall and per-site metrics, including all selected tasks.

Inspect or score a saved run:

```sh
bun evals/webvoyager/wv.ts stats --run-dir <run-directory> --verbose
bun evals/webvoyager/wv.ts eval --run-dir <run-directory> --workers 2
bun evals/webvoyager/viewer.ts <run-directory>
```

The viewer serves on port 8000. The `eval` command only scores completed executions;
runtime failures remain failures. Use `eval --replace` to replace saved judgments.
`eval` always uses the saved judge configuration, so historical manifests without
`judge.maxTokens` retain their original transport behavior. New judge defaults
do not silently change old runs. To compare a different judge configuration,
preserve the original artifacts and evaluate every completed trace into a separate
result set, not only traces with failed judgments. Rescoring saved traces is not
a new browser attempt or a complete benchmark when some tasks were never run.

### Operation diagnostics

New actor results save `operation`: the operation ID, outcome, current phase,
last action's dispatch state, phase counts/timings, and cancellation-to-drain/idle
timings when available. These snapshots contain no prompts, action inputs, page
content, or screenshots. Existing task memory and errors still contain task data.
The viewer displays these diagnostics alongside the execution status.

On failure or cancellation, `failureOperation` preserves the snapshot captured
at that point. The final `operation` snapshot is refreshed after bounded cleanup;
it can still be `draining` if underlying work did not settle. A resolver that
finishes after cancellation can change the final dispatch state without changing
the failure snapshot. Neither snapshot proves that a remote side effect succeeded.

`cleanup.status` is `pending` until cleanup ends, then `settled` or `timed_out`.
`settled` means cleanup attempts and tracked execution settled, not that every
cleanup call succeeded; cleanup errors are logged without replacing a saved task
outcome. `cleanup.elapsedMs` measures the runner's cleanup interval separately
from the library's cancellation-to-idle timing. No operation snapshot exists when
startup fails before `act()`.

`summary.json` and `stats` include `operations` overall and per site/capability:
measured/finished task counts, phase counts and total milliseconds, and per-task
median/p95 phase durations. They also summarize cancellation-to-drain/idle timings.
Timings are inclusive: nested or concurrent phases overlap, so do not sum them as
wall-clock time. Failed and partially drained operations contribute their observed
timings. Each distribution reports its sample count; missing metadata in older
runs is not treated as zero. These metrics cover actor operations, not judging.

## Compare results

Use fresh run directories and the same task suite, judge/version, actor temperature,
timeout, and worker count. Compare:

- Success rate: successful verdicts divided by **all selected tasks**.
- Median and p95 task duration: all attempted tasks, including failures/timeouts.
- Average actions per attempted task.
- Input/output tokens and cached input tokens (reported separately).
- Estimated actor and judge costs (reported separately).
- Per-capability results in `stats` and `summary.json`: constraints, comparison,
  stateful interaction, and extraction. Tags overlap, so do not add their totals.

`pending`, `running`, `unscored`, `interrupted`, `blocked`, `error`, `timeout`, and `judge_error` outcomes
remain in the denominator. A partial run is therefore not a finished benchmark.
Unknown model pricing is reported as `null`, not zero. Prices come from the core's
configured estimate table; failed requests without usage reports may incur costs
that the runner cannot measure.

Usage includes responses rejected by the parser and each provider retry that
returns token usage. Calls without reported usage are not counted as completions.
Older runs that counted only successfully parsed responses underreported cost;
do not compare their cost totals as if accounting were unchanged.

The judge checks the saved answer and full saved visual/action history, without
actor retention limits, screenshot deduplication, or notebook-write suppression.
Judge version 3 fixes those filters and removes planner-only notebook instructions
from query contexts. Saved runs with another judge version require their matching
source revision; the current evaluator does not silently replace their judgments.
Its verdict is an estimate: inspect a
sample of successes and failures in the viewer before
using the score to compare changes. The judge prompt in this harness is stricter
than the legacy evaluator, so old scores are not directly comparable.

Controlled cooldown, Escape, subscription, and no-progress fixtures remain a
separate offline test suite (`browser-recovery.test.ts`), not extra passes in the
live task-completion score. They test the browser implementation with scripted
actions, not whether a model chooses the right recovery. A live `blocked` outcome
still stays in the task-completion denominator; do not quietly drop blocked tasks.

### Task notebook checks

Every plan reviews current observations in a required `memory_updates` array;
the host saves these updates before acting. Empty reviews are valid. Actors can
save bounded, source-linked notes across screenshot eviction. Notes are
model-written summaries, not new evidence; the judge still receives the full audit.
See [memory behavior and limits](../../docs/advanced/memory.mdx).

Run the offline memory, lifecycle, and provider checks:

```sh
bun test packages/magnitude-core/src/memory evals/webvoyager/notebook.test.ts evals/webvoyager/notebook-metrics.test.ts evals/webvoyager/notebook-catalog.test.ts
```

To make paid Luna actor and Sonnet judge calls against fresh random local pages:

```sh
bun evals/webvoyager/fixtures/notebook-live.ts --live
```

This opt-in check requires both API keys and Chrome. It writes all attempts and
exact-answer checks to `.context/notebook-live-*`. It includes a one-record control,
a random 6–10-record collection, a random 22–28-record collection that exceeds
the default thought-retention window, and a random 6–10-record correction workflow
with an irrelevant page and a changed source. It also reports source-linked exact
note coverage before first departure and final-note coverage. These diagnostics
do not prove semantic correctness; final answers are checked separately. These
are synthetic mechanism checks, not additional benchmark passes or a fresh holdout.
No public websites are contacted by the browser tasks.

Add `--catalog` for a one-record serial control plus three nested-catalog checks.
Catalogs use overview rules, group directories, and return links instead of a
forward-only chain. Answers must also classify each record using the overview
rule and sum qualifying units. The correction case changes a randomly chosen
record. These are development mechanism checks, not a held-out benchmark.

Planner updates distinguish `add` from `correct`: adds cannot overwrite keys,
and corrections must match the target's exact current text. Omitted keys stay
unchanged. The guard does not prove factual accuracy or preserve omitted details
inside a corrected record. Stored note/checkpoint shapes and all bounds remain
unchanged; attempted writes, including rejected ones, still consume actions.

### Action and payload budgets

The eval allows **100 actions per task** by default. A task that still needs more
actions fails before executing another action or requesting another plan. A task
that finishes on its final allowed action can still pass. This is a hard execution
budget, separate from repeated-state detection and rate-limit waiting.

Saved judge history over **24 MiB** also fails immediately, without a judge call.
The size is measured as UTF-8 bytes of the serialized saved memory, leaving
headroom below the API's request-body limit. Existing saved runs over the action
cap fail the same preflight check. These are deliberate budget failures, not model
judgments that the answer is wrong. They count as failures in the overall score
and include a structured `budget` reason, actual size/count, and limit.

There is no compression, summarization, batching, or partial-history judging.
Under-budget completed runs receive the normal Sonnet 5 judgment against their
full saved evidence. Original histories are preserved.

Configure limits with `--max-actions <number>` and `--max-judge-mb <MiB>`. Limits
are recorded in the manifest; older manifests use the defaults. Compare runs with
matching judge versions and budgets, and preserve old
results when replaying histories.

### Blocking and recovery

The browser exposes Escape, plus `browser:blocked` for an observed rate limit,
subscription/sign-in requirement, or exhausted approaches. It does not add other
keyboard keys or bypass access controls.

- Main-document HTTP 429 and explicit visible rate-limit headings trigger a
  cooldown. A bare 403, an ordinary Subscribe button, or a background request's
  429 alone does not establish a page-wide barrier.
- Honor `Retry-After` when available; otherwise use a 60-second cooldown. If the
  required wait exceeds the remaining wait budget, stop as `blocked`, not by
  retrying early. The default rate-limit wait budget is two minutes per task.
- A subscription/sign-in barrier allows up to three attempted recovery actions
  before stopping if its page state remains unchanged. An explicit blocked action
  can stop sooner.
- Three occurrences of the same source-page/action-kind/destination-page transition
  in the last 30 counted actions trigger a recovery instruction. Six stop the task
  as `blocked/no_progress`. A state outside the 30 most recently seen distinct states
  clears transition history, so productive visits can reuse shared return paths.
  Waits, hovers, and passive observations do not add failures; new content observed
  during them still clears old history. Fingerprints include the URL, page-text hash,
  visible scroll offsets, and focused input value. This is a bounded heuristic, not
  proof of useful progress: novel noise and long cycles can escape detection, while
  unrepresented visual changes can look unchanged. The hard action budget remains
  the backstop. New tasks reset both histories and counters.

The eval runner explicitly enables heuristic loop detection with
`recovery: { noProgress: true }`. Library consumers must opt in; rate-limit and
access-barrier handling remain enabled by default. Configure limits with
`recovery: { noProgress: true, maxRateLimitWaitMs, repeatedActionLimit }`, or use
`recovery: false` to disable automatic guards. Guards apply to browser-owned
actions, not caller-defined or terminal actions. Custom actions that operate the
browser should delegate to the corresponding built-in browser action to retain
its guards. Every capture records current recovery state, including cleared warnings.
Core recovery errors carry a structured `block`; the eval records these separately
and keeps them in the overall success-rate denominator.

Diagnostics retain the latest 100 relevant document/error responses, with status,
timestamp, retry deadline, and URL origin/path. Userinfo, query strings, fragments,
and arbitrary headers are omitted. First-party fetch/XHR errors are recorded, but
unrelated third-party requests are ignored. Visible barrier detection uses headings
and dialogs; it can miss custom barriers and is not a complete access classifier.
The page text used for repetition hashing is not exposed as additional answer
evidence. The actor still uses screenshots to read page content.

`stats --verbose` and the viewer expose live progress. A recent heartbeat means
`running`; a running checkpoint whose heartbeat is over 15 seconds old is labeled
`interrupted` rather than automatically declared an agent loop. Large histories
use coalesced checkpoints: observation events schedule at most one full-memory
write per two-second interval, with no overlapping writes. Intermediate write
failures are logged and later writes can recover. Completion requires a final
durable save; cleanup failures cannot downgrade that saved outcome.

The actor prompt's date comes from `manifest.createdAt` so resumed or replaced
attempts use the recorded run date, even when their worker starts on another day.

An explicit existing `--run-dir` resumes unrun tasks. `--failed`, `--failed-only`,
or `--replace` also rerun selected unsuccessful/all tasks and overwrite their
previous results. Those diagnostic reruns are **not first-attempt baselines**.
The runner rejects a changed model, timeout, or source hash in an existing run.

### Planner format recovery

The planner must return one complete JSON object with `reasoning`, `memory_updates`
(possibly empty), and a non-empty `actions` array. A single JSON code fence is
accepted for compatibility; surrounding prose, XML tool calls, incomplete JSON,
unknown actions, and invalid action inputs are rejected before any action in the
batch executes.

An invalid plan gets one format-only retry using the same observations and a short
correction. The rejected response is not executed or added to browser memory. A
second invalid response fails the task. This is separate from provider transport
retries and does not restart the browser task. Both attempts' reported usage counts.

The correction and warning logs include bounded validation diagnostics: up to three
issue paths/codes, expected types, and numeric bounds when available, capped at
1,024 characters. For example, `$.memory_updates[0].sources: too_big (maximum 8,
inclusive)` identifies the failed field without echoing note text. Unknown keys,
dynamic record keys, received values, and custom refinement messages are omitted;
unsupported or deeply nested paths are abbreviated. The final task error retains
the second attempt's diagnostic. These diagnostics also apply when BAML rejects
the response first; passing local validation never overrides a BAML rejection.

No rejected raw response is added to memory, logs, or the repair prompt by this
path. Provider/BAML logging configured separately may have its own output policy.
Diagnostics do not change accepted schemas, retry counts, action limits, or usage
accounting, and do not establish that a live model will repair a given failure.

Known supporting direct Anthropic models also receive a provider-enforced JSON
schema derived from the same action/query/extraction definitions. Original Zod
constraints still validate the response locally. Unsupported schema shapes (such
as open-ended maps or recursion) keep the prompt-only path; older/unknown models
and other providers retain it too. Core Anthropic options accept
`structuredOutputs: false` to opt out, or `true` to opt in for another supported
model. There is no automatic fallback/retry on an API schema-configuration error.

A provider refusal or output-token truncation is terminal, even if BAML recovers
a syntactically valid object. Those responses are accounted but not executed or
retried as formatting mistakes. Output-token limits are not automatically raised.

## Local verification

```sh
bun test evals/webvoyager/results.test.ts evals/webvoyager/cli.test.ts evals/webvoyager/budget.test.ts evals/webvoyager/tasks.test.ts
# Requires the bundled browser: bunx patchright install chromium
bun test evals/webvoyager/browser-recovery.test.ts
bun test packages/magnitude-core/src/ai/plannerResponse.test.ts evals/webvoyager/model-harness.test.ts
bun x --no-install tsc -p evals/webvoyager/tsconfig.json
```

CLI integration tests use isolated fake browser/model processes. The browser
recovery fixtures use real Chromium against a loopback server in an isolated
subprocess. Together they verify scoring, budgets, costs, saved answers, cooldowns,
Escape, repeated actions, and failure accounting without contacting live sites or
consuming model tokens. They do not measure model task-completion performance.
