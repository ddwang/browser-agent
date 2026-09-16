# Luna rerun after planner diagnostics

## Result

Luna/Sonnet passed **11/12 (91.7%)**, compared with **10/12** in the previous Luna
run and **8/12** in the latest Haiku run. Luna completed all 12 actor attempts
without a runtime failure. Sonnet passed 11 and returned an output-token-limit
error for the milestone inventory. That error remains in the denominator.

Four invalid plans recovered on their existing single format retry. The two tasks
that changed from non-pass to pass used no format retry, so the score improvement
does not establish a causal benefit from the new diagnostic feedback. This remains
a repeated development-suite result, not held-out evidence.

| Metric | Previous Luna | This Luna rerun | Latest Haiku |
| --- | ---: | ---: | ---: |
| Passes | 10/12 | 11/12 | 8/12 |
| Content failures | 1 | 0 | 2 |
| Terminal planner errors | 1 | 0 | 0 |
| Action-budget failures | 0 | 0 | 1 |
| Judge errors | 0 | 1 | 1 |
| Actions | 336 | 288 | 544 |
| Actor calls / accepted plans | 207 / 205 | 160 / 156 | 260 / 258 |
| Judge calls | 11 | 12 | 12 |
| Estimated actor cost | $0.33944 | $0.24049 | $1.99522 |
| Estimated judge cost | $0.86653 | $0.80856 | $1.22243 |
| Estimated total cost | $1.20597 | $1.04905 | $3.21765 |
| Approximate wall time | 28.2 min | 21.0 min | 43.3 min |
| Median actor-task time | 64.2 s | 75.0 s | 167.4 s |
| p95 actor-task time | 448.0 s | 195.1 s | 379.1 s |
| Note attempts / retained keys | 127 / 122 | 123 / 118 | 241 / 103 |
| Rejected note writes | 3 | 1 | 26 |

Costs use reported usage and configured rates, not billing reconciliation. Wall
time includes judging; task latency does not. Every attempt, including failures
and judge errors, is included. Different completion paths affect these totals;
the table does not isolate model capability or the diagnostic change's effect.

## Frozen protocol

- Revision: `8237245b1ff02e7c14eb7282c5b031ed7cc4ba70`.
- Source hash: `8c0d43960c11542c4b4bd4162d426d3dfd55bc786084862a9f669208f530a92f`.
- Actor: OpenAI `gpt-5.6-luna`, medium reasoning, no explicit temperature.
- Judge: Anthropic `claude-sonnet-5`, temperature 1, judge version 2.
- Complete `baseline.json`: 12 development tasks, one worker.
- Limits: 100 actions, 24 MiB judge preflight, 1,200-second task deadline,
  300-second judge deadline; notebook and context-retention limits unchanged.

The protocol was committed before calls. All task definitions and non-revision/
hash/time manifest settings match the previous Luna run. Runtime code, tasks,
judge, and budgets are unchanged from the latest Haiku rerun; only documentation
and reports changed between those candidates. Source hash and clean worktree were
verified after completion, before this report was added. No selective task retries,
replacement judgments, or holdout exposure occurred.

Raw run: `evals/webvoyager/results/2026-09-15T22-19-59.338Z-luna` (gitignored).
The command exited 1 because of the judge error; all 12 outcomes are terminal.
The [machine-readable report](2026-09-15-luna-planner-diagnostics.json) preserves
the measurements, original judge reasoning, notebook audits, and review notes.
Earlier artifacts remain unchanged:
[original comparison](2026-09-15-luna-haiku-comparison.md) and
[latest Haiku rerun](2026-09-15-haiku-planner-diagnostics.md).

## Every outcome

Actions include notebook operations; calls include format retries.

| Task | Previous Luna | This Luna rerun | Actions / calls |
| --- | --- | --- | ---: |
| ArXiv Hard--0: author audit | Planner error | Pass | 31 / 14 |
| ArXiv Hard--1: Title/Abstract sets | Pass | Pass | 33 / 14 |
| ArXiv Hard--2: three-paper metadata | Pass | Pass | 19 / 11 |
| ArXiv Hard--3: revision histories | Pass | Pass | 9 / 5 |
| Huggingface Hard--0: model selection | Pass | Pass | 21 / 14 |
| Huggingface Hard--1: card/config audit | Pass | Pass | 35 / 26 |
| Huggingface Hard--2: exact split counts | Fail | Pass | 16 / 9 |
| Huggingface Hard--3: cross-page rows | Pass | Pass | 19 / 10 |
| GitHub Hard--0: feature/issue/PR links | Pass | Pass | 19 / 12 |
| GitHub Hard--1: release/PR comparison | Pass | Pass | 12 / 9 |
| GitHub Hard--2: milestone inventory | Pass | Judge error | 54 / 27 |
| GitHub Hard--3: tagged dependencies | Pass | Pass | 20 / 9 |

Site scores were 4/4 arXiv, 4/4 Hugging Face, and 3/4 GitHub. Nine prior passes
remained passes, two prior non-passes became passes, and one prior pass became a
judge error. Relative to the latest Haiku run, all eight Haiku passes also passed
for Luna; Luna additionally passed model selection, exact split counts, and tagged
dependencies. Neither run earned a milestone pass.

The changed successful outcomes have observable support:

- **Author audit:** screenshots 62 and 70 show all five search results and author
  counts 2/7/3/5/9. Luna opened both qualifying abstract pages, returned an answer,
  and needed no format retry. The old rejected response was not retained, so this
  does not reconstruct or prove a fix for the earlier planner defect.
- **Exact split counts:** screenshot 38 visibly shows the dataset card's Data
  Splits table: train 67,349, validation 872, test 1,821. Luna explicitly used this
  source instead of rounded viewer labels or an unverified table endpoint, while
  completing train → validation → train. This task also needed no format retry.

## Planner repairs and judge limitation

Four repair logs reported invalid note-update field types:
`memory_updates[0].operation` and `memory_updates[0].expected_text` (the first
also included another update's operation). They occurred twice in each of GitHub
Hard--0 and GitHub Hard--1, at separate planning steps. Each next attempt returned
a valid whole plan, with usage counted and no partial invalid plan executed.
Both tasks passed, as they did previously. The safe diagnostics do not disclose
whether a field was absent or held a wrong value; rejected payloads were not saved.
These results confirm live repair compatibility, not superiority to generic feedback.

For the milestone inventory, Luna returned a 23-item answer after 54 actions,
27 valid plans, and 27 retained notes. Sonnet's single evaluation call ended with
`Model response exceeded its output-token limit`, reporting 4,096 output tokens
and about $0.14560 in cost. The saved trace was 6.8 MiB, below the 24 MiB cap.
This was an output-token failure, not a payload-budget rejection or actor crash.
There is no verdict; actor completion and a detailed answer are not counted as a
pass. No manual rescue or replacement judgment was added.

The model-selection task's saved SUCCESS rationale ends mid-quotation. Without
the raw judge response, its cause is unknown. The original verdict is preserved;
the audit confirmed E5's 512 input limit in screenshot 54 and its query/passage
prefixes in screenshot 70. The tagged-dependency rationale also loosely describes
an importlib-metadata version spelling change as a bump; the agent's answer
explicitly distinguishes the spelling change. These are recorded judging caveats,
not reasons to replace or silently alter judgments.

## Notebook and evidence audit

All 12 final notebooks exactly match replayed accepted writes: 118 adds, four
corrections, and one rejected mismatched correction. No correction rewrote identical
text, and no note was forgotten. The largest notebook retained 27 keys, below 32.
This verifies storage semantics, not the truth of every note.

One recovery warning occurred in the configuration audit (observation 90), with no
stop. There were no actor errors, timeouts, access stops, action-budget failures,
or recorded HTTP 429s. GitHub's recorded 401s were background banner requests;
recorded 404s do not establish rate limiting. The largest saved trace was 8.3 MiB;
no judge-payload cap was exceeded. Logs cannot rule out every unsurfaced issue.

Review covered all outcomes and original judge rationales, changed-outcome answers
and notes, repair logs, network sidecars, and notebook replay. Selected screenshots
were inspected for author counts, exact split counts, E5 configuration/prefixes,
and tagged dependencies. No runtime changes, additional live tests, selective retries,
or replacement judgments followed.
