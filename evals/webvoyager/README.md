# Browser performance evals

`baseline.json` is the main suite: 12 harder, explicit tasks on arXiv, Hugging Face,
and GitHub. Tasks require multi-constraint searches, cross-page comparisons,
stateful UI changes, or complete extraction. Each has acceptance criteria that
both the actor and Sonnet 5 judge receive. Finding a relevant page alone cannot pass.

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
thinking. Other judge models use temperature 0. Override the actor with `--model`
and the judge with `--judge-model`.
Both use the same provider. Existing Magnitude Claude Code credentials can be used
with `--provider claude-code`; this path uses the project's existing authentication
implementation and is not verified by the offline checks.

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
(default: 1200, including browser/model setup). A worker that exceeds the deadline
plus its cleanup allowance is killed and recorded as a timeout.
Judges run in separate processes with a 300-second limit, configurable with
`--judge-timeout`. A judge timeout is recorded as `judge_error`.

Each run saves:

- `manifest.json`: selected task text and criteria, models, temperatures, timeouts, worker count,
  Git revision, dirty-worktree status, source/dependency hash, and judge version.
- `<task-id>.json`: observations, elapsed milliseconds, action count, model usage,
  and execution status or error.
- `<task-id>.status.json`: a lightweight two-second heartbeat showing planning,
  actions, timed waits, detected barriers, and recent HTTP diagnostics.
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
the actor's rolling retention limits. Its verdict is an estimate: inspect a
sample of successes and failures in the viewer before
using the score to compare changes. The judge prompt in this harness is stricter
than the legacy evaluator, so old scores are not directly comparable.

Controlled cooldown, Escape, subscription, and no-progress fixtures remain a
separate offline test suite (`browser-recovery.test.ts`), not extra passes in the
live task-completion score. They test the browser implementation with scripted
actions, not whether a model chooses the right recovery. A live `blocked` outcome
still stays in the task-completion denominator; do not quietly drop blocked tasks.

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
are recorded in the manifest; older manifests use the defaults. The numeric judge
version remains unchanged. Compare runs with matching budgets and preserve old
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
- Three occurrences of the same action kind producing the same page fingerprint
  in the last 30 non-wait actions trigger a recovery instruction. Six stop the task
  as `blocked/no_progress`. Waits and hovers do not count. Fingerprints include the
  URL, page-text hash, scroll position, and focused input value; this detects repeated
  states, not semantic proof that a task is making progress. New tasks reset counters.

Configure core browser options with `recovery: { maxRateLimitWaitMs,
repeatedActionLimit }`, or use `recovery: false` to disable automatic guards.
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
are checkpointed after observations, not rewritten on every heartbeat.

An explicit existing `--run-dir` resumes unrun tasks. `--failed`, `--failed-only`,
or `--replace` also rerun selected unsuccessful/all tasks and overwrite their
previous results. Those diagnostic reruns are **not first-attempt baselines**.
The runner rejects a changed model, timeout, or source hash in an existing run.

### Planner format recovery

The planner must return one complete JSON object with `reasoning` and a non-empty
`actions` array. A single JSON code fence is accepted for compatibility; surrounding
prose, XML tool calls, incomplete JSON, unknown actions, and invalid action inputs
are rejected before any action in the batch executes.

An invalid plan gets one format-only retry using the same observations and a short
correction. The rejected response is not executed or added to browser memory. A
second invalid response fails the task. This is separate from provider transport
retries and does not restart the browser task. Both attempts' reported usage counts.

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
