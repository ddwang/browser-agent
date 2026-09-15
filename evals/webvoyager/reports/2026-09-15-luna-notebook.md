# Luna with source-linked task memory

## Result

The complete development rerun scored **9/12 (75%)**, unchanged from the previous
Luna run. One former action-budget failure now passes, one former pass failed
before the actor started, and the other two unsuccessful tasks remain unsuccessful.
There were nine judged passes, one judged factual failure, one action-budget
failure, and one Chrome-launch error. No attempt was replaced or rejudged.

The notebook helped some cross-page comparisons but did **not** solve completed-work
retention. All 28 note writes succeeded; Luna often failed to write the facts it
later needed. This is not a demonstrated overall performance improvement.

## Frozen comparison

| Setting | Previous Luna | Luna with notebook |
| --- | --- | --- |
| Run directory under `results/` | `2026-09-15T13-35-55.369Z` | `2026-09-15T14-32-12.819Z` |
| Revision | `5d0f08fbdb3ed7e166b54714602d2066ebab426a` | `a768d2dd6f7d8b604aa0ef224b8e0add7157615b` |
| Clean at launch | Yes | Yes |
| Actor | OpenAI `gpt-5.6-luna`, medium reasoning | Unchanged |
| Judge | Anthropic `claude-sonnet-5`, temperature 1 | Unchanged |
| Suite | Complete 12-task hard development suite | Identical task text, criteria, and order |
| Limits | 100 actions, 24 MiB judge preflight, 1,200/300-second deadlines | Unchanged |
| Workers / retained screenshots | 1 / 3 | Unchanged |

Candidate source hash:
`75d6f9f2c2ebe437de831b2855887afae684b2efa0f54f9175b72feaf65c2635`.
The source hash and clean status were checked again after completion and matched.
The run used an isolated detached checkout with its own dependency install and
build because an unrelated untracked live-probe file appeared in the working
workspace. That file was neither included nor changed.

The candidate adds bounded source-linked notes, observation labels and captured
URLs, and generic guidance distinguishing retained facts from current UI evidence.
It does not add site-specific behavior or answer hints. The judge model, rubric,
and numeric version remain unchanged; the audit it receives naturally includes
the new note actions and observation metadata. This comparison does not isolate
the notebook from the accompanying generic prompt clarification.

Reproduction command, from the frozen candidate with credentials in the environment:

```sh
bun evals/webvoyager/wv.ts run --suite evals/webvoyager/baseline.json \
  --provider openai --model gpt-5.6-luna --eval --workers 1
```

## Measurements

| Metric, including unsuccessful attempts | Previous | Notebook |
| --- | ---: | ---: |
| Passes | 9/12 | 9/12 |
| Actions, including notes and waits | 351 | 327 |
| Actor calls | 259 | 209 |
| Judge calls | 9 | 10 |
| Actor cost estimate | $0.33995 | $0.31588 |
| Judge cost estimate | $0.49793 | $0.78633 |
| Total cost estimate | $0.83789 | $1.10220 |
| Median actor-task time, nearest rank | 82.7 s | 111.1 s |
| p95 actor-task time | 707.4 s | 503.6 s |
| Sum of actor-task times | 2,077.0 s | 2,116.4 s |
| Sum of judge times | 128.2 s | 162.2 s |
| Approximate wall time | 37.0 min | 38.2 min |

Actions fell 6.8% and actor calls fell 19.3%, but total estimated cost rose 31.5%.
Actor cost fell 7.1%; judge cost rose 57.9%, reflecting ten judgments instead of
nine and different history sizes. These are recorded-usage estimates, not billing
reconciliation. The browser-launch error consumed three minutes and zero model
calls; its zero actions must not be interpreted as an efficiency improvement.

The eight tasks that passed in both runs used **113 → 154 actions (+36.3%)**,
100 → 113 actor calls, and 620.4 → 904.9 seconds of actor-task time. This descriptive
subset helps expose regressions but does not replace the complete-suite score.
The tail also remains a failure: the milestone audit reaches its limit sooner,
not a correct answer. Its 100 actions include 41 two-second wait actions.

Full numeric results are in [the comparison JSON](2026-09-15-luna-notebook.json).
Raw screenshots, notes, judgments, and checkpoints remain local/gitignored in the
run directories. The benchmark exited 1 because the complete suite was not all-pass.

## Every task

| Task | Previous → notebook outcome | Actions before → after | Actor calls after / note writes | Assessment |
| --- | --- | ---: | ---: | --- |
| ArXiv Hard--0 | Action cap → pass | 100 → 20 | 10 / 3 | Saved the complete result list and author counts before opening qualifying papers. No repeated search cycle. |
| ArXiv Hard--1 | No-progress stop → factual failure | 30 → 53 | 31 / 2 | Retained partial sets, revisited sources, then miscopied IDs and computed inconsistent differences. |
| ArXiv Hard--2 | Pass → pass | 15 → 16 | 12 / 3 | Retained earlier paper metadata and avoided repeat paper visits; extra search work and latency offset that benefit. |
| ArXiv Hard--3 | Pass → pass | 5 → 7 | 5 / 2 | Same short workflow, with two additional note actions. |
| Huggingface Hard--0 | Pass → pass | 28 → 50 | 28 / 3 | All writes updated one partial MiniLM note; repeated other source checks. Judge qualification below. |
| Huggingface Hard--1 | Pass → pass | 15 → 46 | 41 / 3 | Config values stayed in notes; locating model-card statements required 28 scroll actions and repeated source visits. |
| Huggingface Hard--2 | Pass → launch error | 8 → 0 | 0 / 0 | Chrome startup timed out before any actor call or task navigation. |
| Huggingface Hard--3 | Pass → pass | 5 → 9 | 7 / 2 | Correct cross-page dataset extraction; notes and extra scrolling added overhead. |
| GitHub Hard--0 | Pass → pass | 7 → 10 | 7 / 3 | Correct distinct issue-to-PR mappings; three additional note actions. |
| GitHub Hard--1 | Pass → pass | 12 → 10 | 8 / 2 | Retained the first release's facts and avoided repeated direct source navigations. |
| GitHub Hard--2 | Action cap → action cap | 100 → 100 | 55 / 4 | Kept the inventory but not the per-item classifications; repeated most checks. |
| GitHub Hard--3 | Pass → pass | 26 → 6 | 5 / 1 | Kept the older tag's exact metadata in one note and completed the comparison without reopening it. |

All 209 actor calls produced recorded plans. There were no planner-format errors,
judge-format errors, model-reported blocks, or 1,200-second task deadline failures.
The 28 note writes left 25 keys across eleven started actors, with no rejected
writes and no forget actions. The remaining actor never started.

## Unsuccessful tasks and evidence

### Partial notes do not preserve complete comparison sets

ArXiv Hard--1 wrote only `title_search_setup` and `abstract_search_setup`. They
retained two or three visible IDs, not both complete sets, and were never updated.
One note already miscopied `2312.09086` as `2401.09086`. The final answer introduced
incorrect Title IDs, labeled an intersection as three while listing two, and
reported incorrect set differences. Saved screenshots 35 and 61 independently
confirm the discrepancy; the judge correctly failed the central comparison.

All 17 saved document responses were HTTP 200. The observed problem was fact
capture, retention, and reconciliation, not a visible site-access barrier.

### The item inventory survives, but the completion record does not

GitHub Hard--2 saved the complete 23-item number inventory early. By action 60 it
had visited every item's page, including the first item through a click. However,
its four notes remained inventory/metadata notes; it never stored a classification
ledger or updated the milestone note's unresolved closure-date claim.

Before plan observation 213, the three visible screenshots were 197, 204, and 211,
and the 20-thought window began at observation 82. Early classifications were gone.
The next plan said classifications were incomplete, then reopened items. At action
100 it still had no answer. Direct navigation repeats fell from 26 to 21, but most
items were opened twice and one three times. The inventory benefit was real; it
was insufficient without completed-check notes.

The final 100-entry network buffer contained normal document successes/redirects
and background 401/404 responses, with no recorded 429. It is not a complete network
capture. No screenshot evidence established a site block.

Saved memory ended at 25,691,213 bytes and first exceeded 24 MiB after action 99.
The byte bound is still a judge preflight, not an execution-time guard. The action
cap ended the attempt, and no oversized judge request was sent.

### Browser startup failed independently of the actor

Huggingface Hard--2 recorded `persistentContext: Timeout 180000ms exceeded` after
180.098 seconds. Chrome was launched with `about:blank`, but persistent-context
startup did not complete. No agent, task navigation, memory, or model call existed.
The next task launched normally. The underlying Chrome/Playwright startup cause is
unresolved; allocator and background registration warnings do not prove causality.
The attempt remains an error, not an inferred pass or a selectively retried task.

## Judge qualifications

Keep all original verdicts. This review inspected every task's saved outcome and
action/note/answer trace, replayed the long audit's memory window, and checked
selected screenshots. It is not an independent blinded rescore of all evidence.

- Huggingface Hard--0 has the correct table and qualifying model set, but its prose
  does not explicitly identify MPNet's 384-token limit as failing the 512-token
  requirement. The judge incorrectly says MPNet satisfies that length constraint.
  This qualifies the favorable rationale; it is not grounds to silently rewrite
  the verdict or loosen the rubric.
- ArXiv Hard--1's failure rationale also incorrectly says abstract-only paper
  `2312.09086` was visited at observation 199. That saved screenshot's URL is
  `2401.00755`. The central ID/set-comparison failure is independently supported.

## Independent checks and limitations

Before the benchmark, 309 tests passed with zero failures (1,979 assertions in
29 files); core/evaluation type checks and all five package builds passed. Coverage
includes both provider transports, note bounds/provenance, correction, checkpoint
restore, task isolation, thought/image eviction, action accounting, and preserving
real no-progress stops across note writes.

The predeclared live local check drew fresh records and workflow lengths before
model calls. All attempts were retained; no candidate adjustment followed failures:

| Random-record workflow | Outcome | Actions / calls / notes | Limitation |
| --- | --- | ---: | --- |
| 1 record | Exact-answer and judge pass | 2 / 2 / 0 | Short negative control needed no notes. |
| 9 records | Exact-answer and judge pass | 37 / 24 / 6 | Visited every record three times after omitting needed facts. |
| 25 records | Model-reported no-progress stop | 40 / 27 / 13 | Visited every record but omitted records 19 and 24 from notes, then stopped instead of recovering them. |

Local-check artifacts: `.context/notebook-live-2026-09-15T14-26-13.128Z/`.
Their separate estimated cost was $0.20294; they are not benchmark passes. These
negative results reinforce that note availability does not ensure note quality.

The suite has been inspected repeatedly and is development evidence only. The
consumed holdout was not opened or rerun. One paired run cannot establish causal
or held-out generalization gains, and the launch error adds infrastructure noise.
No runtime change, selective retry, replacement judgment, or next experiment was
made in response to these results.

The next mechanism to investigate is reliable capture of exact facts and completed
checks, using new randomized workflows with independently checked coverage and
correction behavior. Investigate startup failures separately. Neither issue calls
for task-answer hints, bigger action limits, or tuning against the consumed holdout.
