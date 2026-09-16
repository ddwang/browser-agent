# Evaluation review before the next experiment

## Outcome

The first complete Luna hard-development run scored **9/12 (75%)**: nine judged
passes, two action-budget failures, and one model-reported no-progress stop.
No planner-format, judge-format, runner, or timeout error occurred. All 259 actor
calls produced recorded plans. The nine completed tasks each received one Sonnet
5 judgment; none of the three runtime failures was sent to the judge.

The main remaining bottleneck is maintaining facts and completed-work state across
observations, not output formatting. The same forget-and-revisit behavior appears
in several successful tasks. This review does not establish that notes alone will
fix it, nor that Luna is universally better than Haiku.

No new model experiment, selective rerun, or rejudgment was started for this review.
The draft notebook implementation remains disconnected from the actor. The
consumed holdout is not reused for tuning.

## Scope and comparability

Reviewed all nine saved evaluation-run manifests and their task outcomes, existing
historical diagnostic reports, and all twelve current Luna action/thought/answer
traces. Replayed selected memory masks and inspected representative screenshots
for the new failure diagnosis. This is not a blinded human rescore of every
screenshot or every favorable judgment. The separate random-token API smoke check
is an integration check, not an additional benchmark pass.

All run directories below are under `evals/webvoyager/results/`. Times identify
the September 15, 2026 UTC start. Failed, blocked, timed-out, and errored tasks stay
in the denominator. Do not combine the best attempt at each task across runs.

| Start | Suite / configuration | Passes | Other outcomes | Interpretation |
| --- | --- | ---: | --- | --- |
| `05-09-20.862Z` | Single Haiku smoke task | 0/1 | 1 judged failure | Found a recipe but assumed the serving count after ineffective scrolling. |
| `05-12-57.758Z` | Original Haiku smoke suite | 14/20 | 5 judged failures, 1 browser error | Tiny scrolls, incomplete evidence, source search, and interpretation mistakes. |
| `05-50-53.100Z` | Four-task scroll check | 4/4 | None | Same four tasks were 2/4 in the original smoke run; 168 actions fell to 48. Development-only evidence. |
| `05-54-16.100Z` | Haiku smoke after scroll guidance | 16/20 | 2 judged failures, 1 timeout, 1 judge error | Scroll behavior improved; real site barriers dominated the slow tail. |
| `07-45-07.006Z` | Original harder Haiku suite | 1/12 | 11 planner errors | Primarily a protocol failure, not a clean measure of task-solving ability. |
| `08-07-13.801Z` | Strict plan validation and bounded repair | 5/12 | 3 judged failures, 2 planner errors, 1 no-progress stop, 1 judge error | Protocol improved but remained unreliable. |
| `08-47-07.121Z` | Native structured-output Haiku | 6/12 | 5 judged failures, 1 runner error | No format errors; source selection and evidence verification became visible. |
| `09-49-40.611Z` | Frozen cross-site Haiku holdout | 9/12 | 3 judged failures | Different sites and shorter workflows; not comparable to the hard-suite score. Consumed. |
| `13-35-55.369Z` | Luna, medium reasoning, Sonnet 5 judge | 9/12 | 2 action-budget failures, 1 no-progress stop | No format errors; lost facts and repeated verification dominate failures. |

The original harder run undercounted paid responses that failed parsing. Its cost
must not be treated as complete. The smoke runs also predate persisted HTTP
diagnostics; missing network records are not evidence of no rate limiting.

The latest clean Haiku and Luna hard runs used the same twelve task definitions
and 100-action/24 MiB limits, but different actor providers and revisions. Memory
serialization and recovery fixes landed between them. These are exploratory
checkpoint comparisons, not a controlled model-only A/B experiment.

## Luna measurements

Candidate: `5d0f08fbdb3ed7e166b54714602d2066ebab426a`, clean at launch.
Source hash: `5aeadbf83fcd86eeeb2e3c1ca037db14b1c2136061fd7fb77762dea67a60826c`.
Actor: OpenAI `gpt-5.6-luna`, medium reasoning, no explicit temperature.
Judge: Anthropic `claude-sonnet-5`, temperature 1. One worker, 1,200/300-second
actor/judge deadlines. Runtime code remained unchanged through the complete run;
unconnected draft files and documentation were prepared while it ran.

| Metric | Previous native-output Haiku | Luna |
| --- | ---: | ---: |
| Passes | 6/12 | 9/12 |
| Actions | 362 | 351 |
| Actor calls | 289 | 259 |
| Judge calls | 11 | 9 |
| Actor cost estimate | $1.99275 | $0.33995 |
| Judge cost estimate | $1.15464 | $0.49793 |
| Total cost estimate | $3.14739 | $0.83789 |
| Nearest-rank p50 actor task time | 132.6 s | 82.7 s |
| p95 actor task time | 488.7 s | 707.4 s |

Luna's reported actor cost is 83% lower, and total cost is 73% lower. The latter
also reflects fewer judge calls and different history sizes, not just actor
pricing. These are recorded-usage estimates, not billing reconciliation.

The three unsuccessful tasks used **230/351 actions (65.5%)** and **1,403/2,077
seconds of actor task time (67.6%)**. The nine passes used 121 actions in total.
Overall wall time, including judging, was about 37 minutes. Improving median
latency alone will not remove this long tail.

## Every Luna task

| Task | Verdict | Actions / actor calls | Trace assessment |
| --- | --- | ---: | --- |
| ArXiv Hard--0 | Action cap | 100 / 38 | Repeated the search-and-inspection workflow six times after losing earlier facts and the complete search URL. |
| ArXiv Hard--1 | No progress | 30 / 23 | Alternated between two complete result sets as each displaced the other's screenshots; never retained both exact ID sets. |
| ArXiv Hard--2 | Pass | 15 / 15 | Correct final comparison, but opened each of the three paper pages three times. Thoughts repeatedly said older evidence needed to be observed again. |
| ArXiv Hard--3 | Pass | 5 / 5 | Short direct workflow; both complete histories fit the useful context window. |
| Huggingface Hard--0 | Pass | 28 / 22 | Eventually selected the right configuration source and distinguished the required metrics. Long search for one field and one later recheck were avoidable overhead. |
| Huggingface Hard--1 | Pass | 15 / 15 | Opened all six required sources. Earlier thoughts retained concrete values and pooling facts; no full-workflow restart. |
| Huggingface Hard--2 | Pass | 8 / 8 | Checked exact counts rather than rounded labels, preserved the split sequence, and ended on the required split. |
| Huggingface Hard--3 | Pass | 5 / 5 | Used pagination across the preview boundary; returned the complete requested row set. |
| GitHub Hard--0 | Pass | 7 / 7 | Traced distinct issue-to-PR relationships and observed merge state without cycling through sources. |
| GitHub Hard--1 | Pass | 12 / 12 | Correct answer, but reopened release pages and PRs. One PR was visited three times; the other required pages twice. |
| GitHub Hard--2 | Action cap | 100 / 90 | Repeated inventory scans and reclassified already-verified items; no durable completed-item record. |
| GitHub Hard--3 | Pass | 26 / 19 | Correct tagged-file comparison and final state, but issued four direct navigations to each version, plus another tab. Explicitly forgot the older file's lines. |

Passing verdicts establish task completion according to this judge, not efficient
execution. The repeated work in ArXiv Hard--2 and GitHub Hard--1/3 is visible in
actions and thoughts even though the judge described it as verification.

## Failure mechanisms and confidence

### Facts disappear before cross-page comparison

ArXiv Hard--0 had already seen the result list and qualifying records by action
15. The screenshot containing the top results then left the three-image context;
tab retention also removed the complete search URL. Thoughts retained claims of
verification but not the exact values. It reopened the blank search form and
repeated the workflow instead of finishing. The saved document responses were
all HTTP 200 (25 responses); no final answer or judge call occurred.

ArXiv Hard--1 independently reproduces the mechanism. The Abstract result set is
complete in screenshot observations 57 and 61. Before plan 63, the actor sees
screenshots `[53, 57, 61]`. After reopening and scrolling the Title results, plan
75 sees `[65, 69, 73]`: the Abstract screenshots are gone. The thought explicitly
says those IDs were previously observed but are no longer available. It then
reverses the process repeatedly and ultimately reports no progress. All ten saved
document responses were HTTP 200. This is an agent-context limitation, not a
website access barrier.

### Completed work expires during a long audit

GitHub Hard--2 repeatedly claims the inventory is recorded, without retaining a
complete inventory/status table. At action 71 it finally writes the full list into
a thought, but the item classifications remain scattered across expiring thoughts
and screenshots. Before plan 348 (after action 88), a prior explicit classification
of item 5633 has just left the 20-thought window; the model says that item has not
been classified in the current evidence and opens it again.

The run directly navigates to the closed inventory seven times and to one PR four
times. Twenty distinct item pages appear among its direct navigation targets,
while the recorded inventory contains 23 items. It spends its budget revisiting
completed items rather than finishing the remaining audit. Saved screenshots show
normal pages and explicit merge badges, not a site block.

The final network buffer contains normal document successes/redirects and
background 401/404 responses. No 429 is recorded, but this buffer is capped at
100 entries, so it is not a complete network capture. Background messaging and
agent-feature failures do not establish that the content page was rate-limited.

### Prompt wording may reinforce unnecessary re-observation

The planner says, “Use only the current observations to plan this batch.” Its
intended purpose is to prevent invented future tool results. Several traces
instead insist that previously observed facts must be visible again before they
can be used. This is a plausible contributing interaction, not proven causality.
A future change should distinguish using prior recorded evidence for stable facts
from using the latest screenshot for coordinates and current UI state.

### Recovery and payload bounds limit damage but do not preserve progress

The repetition heuristic checks page/action fingerprints in a 30-action window
and stops at six repetitions. Long workflow cycles can escape it. Tightening it
blindly could punish legitimate revisits and merely turn a late failure into an
earlier failure; it does not supply missing facts.

GitHub Hard--2's final saved memory is 26,013,846 bytes, above 24 MiB. Reconstructing
prefix sizes shows it first crossed that threshold after action 98. The byte cap
is currently a judge preflight, not an execution-time checkpoint guard. The run
therefore continued to the action cap, but correctly made no judge call. Early
size enforcement is a separate efficiency improvement, not evidence of a memory
fix or the cause of this loop.

## What the older runs add

- **Scrolling was a concrete action-semantics problem.** The original full smoke
  run used 202 scrolls, all under 100 pixels. The description change eliminated
  those tiny scrolls in both follow-up runs. It did not solve search, evidence,
  or site-access problems.
- **Some historical delays really were site barriers.** In the later smoke run,
  GitHub screenshots showed a secondary rate-limit message; completed waits
  totaled 935 seconds before timeout. BBC spent about 17 minutes searching, then
  encountered a visible subscription wall. The actor tried to dismiss it and
  substituted general knowledge for inaccessible source content. Its judge request
  failed separately with HTTP 413 after 152 actions. Old telemetry cannot exclude
  silent throttling, but the visible BBC barrier was a subscription requirement,
  not an observed rate-limit notice.
- **The protocol repairs addressed a separate failure class.** Eleven original
  hard-suite runs failed parsing. Bounded repair reduced this to two actor-format
  failures plus one judge-format failure. Native schemas eliminated observed
  format failures in the next run; Luna also produced valid plans throughout its
  run without native OpenAI Structured Outputs.
- **Content verification and task compliance still matter.** Prior hard runs
  confused different length metrics, omitted required files, reported rounded
  counts as exact, missed a revision, or used the wrong required viewer. The
  current Luna run passed those particular tasks, but this is one inspected
  development run, not proof that those failure classes are solved.
- **Judges are not ground truth.** The consumed holdout's published report already
  records a likely temporal false negative and a favorable verdict with an
  evidence gap. Keep those verdicts unchanged. This review does not use those
  task answers to design the actor improvement.
- **A runner error remains unexplained.** The native-output run recorded “Worker
  exited without a final result” despite a saved answer. It did not recur here;
  absence of recurrence is not a demonstrated fix.

## Next experiment, not yet started

The evidence supports prioritizing **durable, source-linked facts and a record of
completed work**, rather than increasing screenshots, raising action limits, or
adding reminders that match individual benchmark tasks.

Before a new live run:

1. Freeze the hypothesis and candidate. Keep task text, judge, recovery limits,
   and scoring unchanged. Clearly separate fact recall from current-UI grounding.
2. Verify note updates, provenance, bounds, task isolation, and checkpoint restore
   independently. Notes are model summaries linked to observations, not newly
   verified evidence. Preserve uncertainty and allow corrections.
3. Use randomized local multi-page workflows that exceed both screenshot and
   thought-retention windows. Check exact values, completed-item tracking,
   ordering, and unresolved items. The prepared six-/nine-page checks alone are
   insufficient to cover the 20-thought expiration seen in the long audit.
4. Include negative controls: short tasks that should not need notes, legitimately
   changed source values that require revisiting, and real no-progress behavior
   that must not be hidden by note actions. Predeclare mechanism checks and retain
   failed attempts rather than selecting favorable seeds.
5. Measure repeated source visits, completed-work coverage, actions, latency tails,
   and cost alongside pass rate. Do not treat every repeated URL as an error.

A later full development run can measure exploratory improvement, but the
diagnosed tasks must not be used as a fresh holdout. Any generalization claim
requires a newly frozen, disjoint harder holdout. Do not expose that holdout while
iterating on the mechanism. No such run has started.

Historical supporting reports: [planner recovery](2026-09-15-planner-recovery.md),
[native outputs](2026-09-15-native-output.md), and the existing
[consumed holdout report](2026-09-15-holdout.md). Earlier smoke/scroll diagnostics
remain local in `.context/sonnet5-baseline-2026-09-15.md` and
`.context/scroll-guidance-comparison-2026-09-15.md`.
