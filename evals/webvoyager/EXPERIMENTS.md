# Evaluation and anti-overfitting protocol

**Current status:** the holdout was consumed once on September 15, 2026 by frozen
candidate `09e24b0`. Recorded result: 9/12 passes, three failures, no replacements
or rejudging. See [results, evidence, and judging caveats](reports/2026-09-15-holdout.md).
Do not treat another run of this suite as a fresh holdout. No behavior changes
were made after seeing its outcomes.

## Partitions

`baseline.json` (12 hard tasks), `smoke.json` (20 legacy tasks), and
`scroll-baseline.json` are **development data**. Their prompts, traces, and scores
have been inspected. Never present improvements on these as held-out performance.

`holdout.json` freezes 12 previously unrun tasks, four each from Amazon, ESPN, and
Google Map. None of those sites appears in the development suites. Selection uses
SHA-256 ordering with the recorded seed, without inspecting selected questions or
running the candidate. It excludes tasks matching the recorded purchase/account-write
filter. It does not filter for expected success, observed access barriers, or model
behavior. The catalog and selected full task contents have recorded checksums.

These are existing WebVoyager tasks, not newly authored hard-suite equivalents.
The holdout measures transfer to different sites and workflows, not the same
difficulty distribution. Published benchmark tasks may also be in model pretraining;
this protocol controls development exposure, not pretraining contamination.
Booking/Google Flights were not selected because their old date-specific travel
requests need a separate validity study; no failed holdout task will be replaced.

## Before changing behavior

1. Freeze the holdout selection and protocol in Git before implementation changes.
2. Write down the general mechanism being tested and independent regression tests.
3. Do not add site names, task IDs, selectors, expected answers, filenames, counts,
   or task-specific browsing shortcuts to agent prompts or implementation.
4. Keep task wording, acceptance criteria, judge rubric/model, and failure budgets
   fixed while comparing candidates. Describe any unavoidable configuration change.
5. Prefer protocol/property tests with synthetic inputs over adding reminders that
   mirror particular development failures. Never use holdout outcomes to tune code.

## Candidate selection and final holdout

Use offline regression tests and the development suites for iteration. Record each
live experiment, including failures, cost, and its code/configuration hash. Do not
selectively rerun unsuccessful tasks and report the combined result as one run.
Keep previous artifacts unchanged. Development-suite gains are exploratory and may
reflect variance; do not infer broad gains from one small run.

Before the holdout, commit a clean candidate to local `main`. Record its revision,
run the complete holdout once, and freeze code, prompts, budgets, and judging for
the entire run. The CLI requires `--allow-holdout`, a clean worktree, a complete
suite, scoring, and a fresh directory. The flag acknowledges exposure; it does not
make repeated use statistically valid.

```sh
bun evals/webvoyager/wv.ts run --suite evals/webvoyager/holdout.json --allow-holdout --eval --workers 1
```

Do not inspect holdout traces until the candidate is frozen. After results are
visible, this holdout is **consumed**: report it, including blocked, timed-out,
budget-failed, and invalid tasks. If an evaluation problem makes a task ambiguous,
annotate it without dropping it or changing its criteria/score after seeing the
answer. No behavior changes based on those results may claim this as a fresh test.
A later development cycle needs a newly frozen, disjoint holdout.

## Current experiment sequence

1. Completed planner-contract development checkpoint: 5/12 passes. See
   [results and limitations](reports/2026-09-15-planner-recovery.md).
2. Freeze this protocol and the cross-site holdout.
3. Test provider-enforced output schemas, independently of browser-task content.
   Hypothesis: structural guarantees reduce malformed plans and verdicts without
   adding answer hints. Preserve local validation and failure/usage accounting.
4. Verify with randomized/synthetic schemas and provider fixtures, then a fresh
   complete development run. Investigate only general failures, not task answers.
5. Freeze the candidate before the one-shot holdout. Publish all outcomes and
   disclose limitations. Stop tuning against that holdout once consumed.

### Pre-holdout infrastructure checks

The native-output development run completed at `d2ac92f`: 6/12 passes, five content
failures, one runner-finalization error, no planner/judge-format errors. See
[the complete result and limitations](reports/2026-09-15-native-output.md).

Before the still-unrun holdout, test these general mechanisms independently:

- Recovery fingerprints omit nested scroll offsets and textarea/select state.
  Reproduce with randomized local browser panels and controls; preserve genuine
  no-progress stops and ignore hidden/offscreen scroll changes. Do not change limits.
- Nested observation serialization omits an `await`, losing object values and
  affecting hashes. A synthetic nested-object round trip already reproduced this.
  Test primitives, arrays, objects, omission, media, and arbitrary own property names.
- Investigate finalization with synthetic large histories and delayed checkpoints.
  Do not modify the errored development attempt or infer its score from its answer.
- Prevent direct development selection of reserved holdout sites and prevent
  replacing/rejudging holdout outcomes through the separate CLI commands.

The recovery, serializer, and CLI issues were identified by code inspection before
holdout exposure. None justifies adding browser-task answers or site-specific agent
behavior. Commit a clean candidate after independent verification, then use the
complete holdout once. Keep this development checkpoint distinct from that candidate.

The nested-memory repair passed seven new synthetic tests, including 64 varied
object cases, own-property safety, media, checkpoint round trips, and deduplication.
Its media test also reproduced a format-label mismatch for converted images. Saved
images and model payloads now use the format of the emitted bytes, verified with
PNG/JPEG requests through the real model client to a loopback provider. This adds no
browser-task instructions and does not explain the separate runner-status error.

The CLI now blocks reserved sites from direct/development selection and prevents
resuming, replacing, or rejudging a saved holdout run. A 21 MiB synthetic history
with 96 actions and delayed checkpoints finalized correctly; it did **not**
reproduce the development runner error. Exit-zero-without-a-result remains an
error, with additional exit/signal/saved-status diagnostics for future failures.
Do not describe the unexplained development error as fixed or rescore it.

The recovery repair reproduced a false warning on the old implementation, then
passed all 14 real-browser loopback checks. It includes visible nested scroll
offsets and focused input/textarea/select state in the diagnostic hash. Vertical
and horizontal panel endpoints still trigger no-progress stops; hidden/offscreen
scroll changes do not conceal unchanged clicks. Thresholds and browser-task
instructions are unchanged. This is still a heuristic, not proof of a stall:
canvas-only or cross-frame state changes are not fully represented.

### OpenAI provider support (after holdout consumption)

The OpenAI actor option was added at the user's request, not in response to a
holdout failure. `--provider openai` selects `gpt-5.6-luna` with medium reasoning;
the judge remains Anthropic Sonnet 5. Existing Haiku defaults, prompts, task text,
criteria, recovery thresholds, and budgets are unchanged. The OpenAI adapter uses
Chat Completions with local schema validation, not native OpenAI Structured Outputs.

Verification used synthetic loopback provider responses, isolated CLI workers,
and the existing local-browser fixtures: 296 tests passed, both core/eval type
checks passed, and all five packages built. Checks cover separate actor/judge
configuration and credentials, image transport, reasoning/output limits, refusal
and truncation handling, bounded format retries, and cached-token cost accounting.
No live OpenAI API or website evaluation ran because `OPENAI_API_KEY` was absent.
This establishes offline integration coverage, not a Luna performance score.
The consumed holdout and its judgments were not rerun or changed.

The API key was subsequently added. The first complete Luna hard-development run
at `5d0f08f` scored 9/12, with two action-budget failures and one no-progress stop.
Before starting another test, the user requested an all-runs review. See the
[complete review and next-experiment requirements](reports/2026-09-15-all-runs-review.md).
No new model run or replacement judgment was started during that review. The
unfinished source-linked notebook draft is preserved separately in `.context`
and remains disconnected from production code.

### Source-linked notebook candidate

The user authorized a complete Luna development rerun with the new memory system
after the all-runs review. The notebook now preserves bounded, model-written facts,
completed checks, and uncertainty with host-validated observation references and
captured URLs. Updates replace a key; forgetting is explicit; failures do not
silently evict existing facts. Notes serialize with task memory and survive the
screenshot and thought windows. Full note actions remain in the saved audit.

Notebook actions consume the existing action budget but do not capture another
browser image, run browser hooks, or clear recovery state. The planner now
distinguishes retained factual evidence from current UI grounding. No task-specific
URLs, item counts, answer hints, selectors, or filenames are added to the actor.

Pre-run verification covers both provider transports, normal task lifecycle,
checkpoint restoration, bounds, invalid source references, corrections after
changed evidence, the default 20-thought window, and preserving a real browser
no-progress stop across note actions. The opt-in live check draws random local
records before making model calls: one short control, 6–10 records across the image
window, and 22–28 records across the thought window. Preserve all attempts and
check exact records, ordering, totals, visits, and note usage independently of
Sonnet's verdict. These are mechanism checks, not benchmark passes.

Freeze a clean candidate before the complete 12-task development run. Keep Luna's
medium reasoning, Sonnet 5 judging, all task text/criteria, three screenshots,
100 actions, 24 MiB judge preflight, deadlines, and one worker unchanged. Do not
modify runtime code during the run or selectively replace failures. The consumed
holdout remains untouched; this development comparison cannot establish held-out
generalization.

Offline verification of the notebook candidate: 309 tests passed, zero failed
(1,979 assertions across 29 files). Core and evaluation type checks passed; all
five packages built. The existing circular-dependency, external-type placement,
and empty CLI/MCP chunk warnings remain. No live notebook outcome is implied by
these checks.

The frozen notebook candidate `a768d2d` then completed the full Luna development
rerun: **9/12**, unchanged from the previous Luna score. Actions fell 351 → 327,
but total estimated cost rose $0.83789 → $1.10220 and wall time rose 37.0 → 38.2
minutes. One prior budget failure now passes; the set comparison and milestone
audit remain unsuccessful; a Chrome-launch error replaces a prior passing task.
All 28 note writes succeeded, but incomplete notes still caused lost facts and
repeated checks. The random 25-record local check also failed after omitted notes.
See the [complete comparison, failure analysis, and judge qualifications](reports/2026-09-15-luna-notebook.md).
No candidate tuning, selective reruns, or rejudgments followed these results. The
consumed holdout remains untouched; this is not a general performance win.

### Required memory review experiment

At the user's request, test the smallest next mechanism: require `memory_updates`
in every plan and save them through the existing note action before executing
browser actions. Empty reviews are valid; fabricated filler is not required.
Each attempted update retains its existing action cost. Rejected updates stop
the batch without navigation and replan with the error. Do not change the model,
judge, memory bounds, retention windows, task criteria, or recovery thresholds.
Do not add a new fact schema, completion gate, retrieval tool, or extra model call
in this experiment. The hypothesis is improved capture, not merely more writes.

Predeclare live checks before calling models: fresh random short/image-window/
thought-window collections, plus a correction workflow with an irrelevant page
and a required revisit to a changed source. Measure exact final answers, record
coverage in source-linked notes before leaving pages, stale facts after correction,
repeated visits, actions, calls, and cost. Preserve every attempt and failed check.
The departure metric is intentionally stricter than eventual correctness; the
last page need not be noted if the answer can immediately use it. Capture and
correctness are separate from schema conformance.

Use these synthetic families for development only. Reserve unseen layouts and
workflow families (for example, nested catalogs with cross-page dependencies) for
a later frozen evaluation; do not call random values in a known template a fresh
held-out test. Do not reuse the consumed website holdout or selectively rerun the
website benchmark to select favorable outcomes.

The frozen candidate `f65ab2f` completed all four local attempts: 3 passed and the
28-record collection blocked. Exact source-linked capture before departure reached
27/28 in the long task, but same-key replacements removed entries 1–12; one later
code was also miscopied. All 55 note writes succeeded. The correction workflow
passed, while the short control added two note actions. Total estimated cost was
$0.18607. Required review improves capture discipline in these attempts but does
not solve durable retention or transcription. See the [complete report and next
experiment](reports/2026-09-15-required-memory-review.md). No runtime tuning,
selective retries, rejudgments, or website/holdout reruns followed these outcomes.

### Guarded note updates experiment

The user approved a non-destructive update experiment. Keep the existing stored
key/text/sources format and bounds. Require `operation` and `expected_text` on
planner note updates: `add` rejects an existing key, while `correct` requires an
existing key and an exact current-text match. Change only the targeted key and
leave all omitted keys unchanged. Guide the actor to use separate records rather
than a growing collection summary. Retain explicit forget, audited action costs,
source validation, and stop-before-navigation on rejection. The guard cannot
prove that a correction is true or preserve omitted facts within the corrected
record; no semantic judge, extra model call, or automatic history retrieval is added.

Before live calls, predeclare one full four-case local run with `--catalog`: the
unchanged one-record serial control, randomized 6–10 and 22–28-record nested
catalogs, and a 6–10-record catalog with a changed source. Catalog tasks start
with an overview qualification rule, traverse group directories and return links,
and require per-record rule application plus both total and qualifying totals.
Draw all lengths, rules, values, groups, paths, and the correction target before
model calls. Offline checks cover new/duplicate keys, stale/targeted corrections,
source and capacity failures, checkpoint restoration, both provider transports,
action accounting, directory coverage, and unchanged unrelated records.

Freeze the candidate before this run. Keep Luna medium, Sonnet 5, retention windows,
100 actions, 24 MiB preflight, and existing deadlines. Measure every outcome,
exact answers, capture and final-note coverage, rejected writes, corrections,
revisits, actions, calls, and cost. Preserve all attempts; do not adjust the
candidate or retry selected cases in response. This workflow is new to the live
checks, but developer-authored and inspectable, not a blinded holdout. Do not
rerun the website development suite or consumed holdout. Reserve further unseen
workflow families for a separately approved frozen evaluation.

Candidate `5ed958b` completed all four attempts: 2 passed and 2 hit an existing
recovery false positive after five productive record visits and directory returns.
All 31 note writes succeeded (30 adds, one matching correction); no saved record
was overwritten or forgotten. The host stopped the long and changed-source cases
before they could validate their intended memory challenges. Capture still included
transcription errors and weak tab-list citations. Total estimated cost was $0.22129.
See the [full guarded-update report](reports/2026-09-15-guarded-note-updates.md).
No runtime tuning, selective retries, rejudgments, website benchmark, or consumed
holdout runs followed these results. The next proposed change is a general fix for
productive-return false positives, not a task-specific recovery threshold.

### Productive-return recovery experiment

The user approved fixing the general recovery false positive. Count repeated
source/action/destination transitions, not destination/action occurrences alone.
Clear repetition history when a page state outside the bounded recent-state cache
appears, including after a deliberate wait. This lets productive exploration reuse
shared navigation paths while still detecting unchanged actions and cycles through
known states. Keep the existing warning/stop thresholds, bounded history, rate-limit
handling, access barriers, and hard action budget. Fingerprints remain heuristic:
novel states do not prove useful progress, and unrepresented visual changes can
still look unchanged. The hard action budget remains the backstop.

Before model calls, reproduce the bug with independent synthetic graph walks:
multiple hubs, shared return paths, varied fan-out, no-op actions, multi-page cycles,
passive observations, and task resets. Exercise productive returns and real cycles
through the actual browser connector on loopback pages. Do not add site names,
catalog-specific paths, record counts, task hints, or threshold exceptions to runtime.

Freeze and commit the candidate after offline verification, then run the unchanged
complete four-case `notebook-live.ts --live --catalog` workflow once with fresh
random data. Keep Luna medium, Sonnet 5, prompts, criteria, generator distributions,
100 actions, 24 MiB preflight, and deadlines unchanged. Preserve all four outcomes;
report exact answers, note quality, visits, actions, calls, cost, and any remaining
false stops. Do not tune or retry after results, rerun the website benchmark, or
reuse the consumed holdout. This known workflow is development data, not a fresh
holdout or a paired comparison using identical random inputs.

Offline verification passed 321 tests with 4,403 assertions across 31 files,
including all 16 real-browser fixture cases. Both type checks and all five package
builds passed. Three new unit checks reproduced old-history false positives before
the fix. The expanded browser suite exceeded its previous 90-second wrapper limit;
only that offline timeout was extended to 180 seconds (the passing suite took
96.7 seconds). Live task deadlines and recovery/action budgets are unchanged.

Frozen candidate `14b82ef` completed all four local attempts: 3 passed, one had a
runner-finalization error, and none produced a recovery warning or stop. Every
required page was visited, and the six-entry correction group completed its
changed-source check. The 22-record case retained all records but propagated three
label errors and one code error into its answer. It remains an unjudged runner
error, not a rescued pass. Two duplicate adds were safely rejected; both explicit
corrections succeeded. Total estimated cost was $0.40952. See the
[complete productive-return report](reports/2026-09-15-productive-return-recovery.md).
No runtime changes, selective reruns, rejudgments, website benchmark, or consumed
holdout runs followed. Investigate finalization reliability independently before
another benchmark; transcription remains a separate limitation.

### Full Luna and Haiku comparison

The user explicitly requested complete development runs with Luna/Sonnet and
Haiku/Sonnet. Run the unchanged 12-task `baseline.json` once per actor, Luna first,
then Haiku, on the same frozen candidate. The previously observed finalization
error remains unfixed; preserve any recurrence in the denominator. This request
authorizes evaluation, not runtime tuning between runs.

Use OpenAI `gpt-5.6-luna` with medium reasoning and Anthropic
`claude-haiku-4-5-20251001` with temperature 0.2. Both use Anthropic
`claude-sonnet-5` at temperature 1, judge version 2, one worker, 100 actions,
24 MiB preflight, 1,200/300-second deadlines, and unchanged prompts, criteria,
memory bounds, retention windows, and recovery settings. Provider transports and
actor sampling settings differ by design; compare the configured agents, not an
isolated model-only effect.

Commit this protocol before model calls. Use fresh run directories, verify matching
source hashes and task definitions, and make no code/configuration changes between
the runs. Review every Luna outcome before starting Haiku without acting on the
findings. Preserve all 24 attempts, including access blocks, runner errors, budget
failures, and judge errors. Existing within-attempt format retries remain counted;
do not selectively rerun tasks or replace judgments.

Report per-task outcomes, aggregate success, actions, calls, latency, actor/judge
costs, note errors, network evidence, and judging limitations. Inspect failures
and a sample of successes. Keep the website runs separate from local fixture
scores. The repeated development suite is not a holdout; sequential runs can also
differ because of time-dependent site state or shared-IP rate limits. Do not use
the consumed holdout or claim held-out generalization.

Frozen revision `5987bb1` completed both full runs: Luna/Sonnet passed 10/12 and
Haiku/Sonnet passed 6/12. All 24 attempts remain counted. Luna had one content
failure and one planner error; Haiku had four content failures, one planner error,
and one unexplained browser-closure error. No task recorded HTTP 429, and neither
run hit a timeout, access stop, or action/payload budget. The earlier runner-
finalization error did not recur. Both source hashes and all non-actor manifest
fields matched, and the worktree stayed unchanged through both runs.

Luna used 336 actions/207 actor calls and an estimated $1.20597 in 28.2 minutes;
Haiku used 414 actions/217 calls and $2.66327 in 44.1 minutes. Every notebook
replayed exactly. Haiku made 97 corrections, including 21 identical rewrites,
and 18 rejected note attempts; Luna made two corrections and had three
rejections. Both failed exact dataset-count verification, and Haiku also showed
unreconciled version facts, an unsupported final value, and filename substitution.
See the [full paired report and evidence caveats](reports/2026-09-15-luna-haiku-comparison.md).
No runtime tuning, selective retries, rejudgments, or holdout runs followed.

### Bounded planner diagnostics

After reviewing Luna's failure modes, the user approved starting with planner
diagnostics and the existing bounded repair. Preserve local field-level validation
issues instead of collapsing every rejection into a generic format error. Include
up to three safe schema paths/codes, expected types, and numeric limits, capped at
1,024 characters, in warning logs and the same one-retry correction. Retain the
last diagnostic in the terminal task error. Do not echo rejected output values,
unknown keys, dynamic record keys, or custom refinement messages. BAML parse errors
also receive local diagnosis, without bypassing either validator.

This change does not alter models, provider transport settings, accepted schemas,
notebook semantics, action/payload budgets, or task/judge prompts. Refusal and token
truncation remain terminal. No note or browser action from an invalid plan may
execute, and both attempts' usage remains counted. Use site-independent parser
tests and real BAML transport checks against loopback fake providers; do not rerun
website tasks or the consumed holdout for this implementation step. The old Luna
and Haiku rejected payloads were not retained, so their exact defects cannot be
reconstructed or claimed fixed from this change.

Offline verification passed 326 tests with 4,433 assertions across 31 files.
The five new parser tests failed before implementation and passed afterward.
Both real provider adapters passed all five shared repair cases; an agent-level
check confirmed that an invalid trailing action prevents both a valid leading
note and a valid leading action from executing. Terminal diagnostics, bounded
retry counts, usage accounting, and omission of rejected values also passed.
Core and evaluation type checks and all five package builds passed. No live model
calls, website reruns, selective rejudgments, or holdout runs followed; live success
rate improvement remains unmeasured.

### Haiku rerun after planner diagnostics

The user requested another Haiku run after the bounded-diagnostics change
(`9fffb29`). Run the complete, unchanged 12-task development suite once in a fresh
directory. Keep Anthropic `claude-haiku-4-5-20251001` at temperature 0.2 as actor
and `claude-sonnet-5` at temperature 1 as judge, judge version 2, one worker,
100 actions, 24 MiB judge preflight, and 1,200/300-second task/judge deadlines.
Freeze and commit this protocol before calls. Do not tune runtime behavior during
the run, selectively retry failures, replace judgments, or reuse the holdout.

Compare every outcome, usage, latency, and planner diagnostic with the previous
Haiku development run at `5987bb1` (6/12). Preserve errors in the denominator.
Check source/configuration consistency and replay notebooks before reporting.
This is one repeated development run, not a controlled causal estimate or held-out
evidence. Better diagnostics may expose causes without improving the score.

Frozen revision `e3df27b` completed all 12 attempts: 8 passes, two content failures,
one 100-action failure, and one Sonnet output-token-limit judge error. Both live
format repairs identified more than eight note sources and succeeded on the next
attempt. No terminal planner error recurred. The two newly passing tasks used no
format retry, so the 6/12 to 8/12 score change cannot be attributed to diagnostics.
All notebooks replayed exactly; the source hash and configuration checks passed.
The run used 544 actions, 260 actor calls, and an estimated $3.21765 in 43.3 minutes.
See the [full Haiku rerun report](reports/2026-09-15-haiku-planner-diagnostics.md).
No selective retries, replacement judgments, runtime changes, or holdout runs followed.
