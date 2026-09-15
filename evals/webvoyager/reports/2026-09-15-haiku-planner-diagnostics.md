# Haiku rerun after planner diagnostics

## Result

Haiku/Sonnet passed **8/12 (66.7%)**, compared with **6/12 (50.0%)** in the
previous full development run. The rerun had two content failures, one action-
budget failure, and one judge error. Every task remains in the denominator.

The new diagnostics identified two oversized note-source arrays. Both recovered
on the existing single format retry. Neither of the two newly passing tasks used
that retry, so the score increase is not evidence that repair feedback caused it.
This is one repeated development run, not held-out or causal evidence.

| Metric | Previous Haiku | This Haiku rerun |
| --- | ---: | ---: |
| Passes | 6/12 | 8/12 |
| Content failures | 4 | 2 |
| Terminal planner errors | 1 | 0 |
| Browser errors | 1 | 0 |
| Action-budget failures | 0 | 1 |
| Judge errors | 0 | 1 |
| Actions | 414 | 544 |
| Actor calls / accepted plans | 217 / 213 | 260 / 258 |
| Judge calls | 10 | 12 |
| Estimated actor cost | $1.64930 | $1.99522 |
| Estimated judge cost | $1.01397 | $1.22243 |
| Estimated total cost | $2.66327 | $3.21765 |
| Approximate run wall time | 44.1 min | 43.3 min |
| Median actor-task time | 167.6 s | 167.4 s |
| p95 actor-task time | 490.7 s | 379.1 s |
| Note attempts / retained keys | 195 / 80 | 241 / 103 |
| Rejected note writes | 18 | 26 |

Costs use recorded usage and configured rates, not billing reconciliation.
Latency includes failures and early stops; wall time includes judging. More
completed actor tasks and a longer milestone attempt also affect cost/action
comparisons. Do not interpret these aggregate differences as per-task efficiency.

## Frozen protocol

- Revision: `e3df27bf9e4366b5eb8e006aae46c41a824887f1`.
- Source hash: `d9b3e8d69ce74b9c2a78f8561f8fe8f114898b64184110317b711e866d2c0fa4`.
- Actor: Anthropic `claude-haiku-4-5-20251001`, temperature 0.2.
- Judge: Anthropic `claude-sonnet-5`, temperature 1, judge version 2.
- Complete `baseline.json`: 12 tasks, development partition, one worker.
- Limits: 100 actions, 24 MiB judge preflight, 1,200-second task deadline,
  300-second judge deadline; notebook and context-retention limits unchanged.

The protocol was committed before calls. Task definitions, order, actor, judge,
workers, and limits match the prior Haiku manifest exactly. Source hash and clean
worktree were verified after completion, before adding this report. Runtime changes
since the prior candidate are limited to planner diagnostics and repair feedback.
No task edits, selective retries, replacement judgments, or holdout exposure occurred.

Raw run: `evals/webvoyager/results/2026-09-15T21-27-28.226Z-haiku` (gitignored).
The command exited 1 because not all tasks passed; all 12 reached a terminal outcome.
The [machine-readable report](2026-09-15-haiku-planner-diagnostics.json) preserves
measurements, original judge reasoning, notebook audits, and review notes. The
[previous comparison](2026-09-15-luna-haiku-comparison.md) remains unchanged.

## Every outcome

Actions include notebook operations; calls include format retries.

| Task | Previous outcome | Rerun outcome | Rerun actions / calls |
| --- | --- | --- | ---: |
| ArXiv Hard--0: author audit | Pass | Pass | 46 / 17 |
| ArXiv Hard--1: Title/Abstract sets | Pass | Pass | 46 / 19 |
| ArXiv Hard--2: three-paper metadata | Fail | Pass | 54 / 30 |
| ArXiv Hard--3: revision histories | Pass | Pass | 30 / 15 |
| Huggingface Hard--0: model selection | Fail | Fail | 40 / 21 |
| Huggingface Hard--1: card/config audit | Fail | Pass | 72 / 40 |
| Huggingface Hard--2: exact split counts | Fail | Fail | 23 / 13 |
| Huggingface Hard--3: cross-page rows | Pass | Pass | 28 / 14 |
| GitHub Hard--0: feature/issue/PR links | Pass | Pass | 34 / 20 |
| GitHub Hard--1: release/PR comparison | Pass | Pass | 40 / 22 |
| GitHub Hard--2: milestone inventory | Planner error | Action limit | 100 / 33 |
| GitHub Hard--3: tagged dependencies | Browser error | Judge error | 31 / 16 |

All six previous passes remained passes. The two new passes correctly resolved
the prior content errors: Attention's v7 is visible in arXiv observation 73, and
the requested `sentence_bert_config.json` files are visible in Hugging Face
observations 142 and 203. Neither task needed planner-format repair. Site scores
were 4/4 arXiv, 2/4 Hugging Face, and 2/4 GitHub.

## Repairs and remaining failures

Both repair logs reported the same constraint:
`$.memory_updates[0].sources: too_big (maximum 8, inclusive)`.
They occurred in Huggingface Hard--0 and GitHub Hard--1. Each next attempt produced
a valid whole plan, with both calls counted. The former still failed its content
criteria; the latter passed, as it did previously. This confirms that field-level
feedback reached live Haiku repairs, not that it outperforms the old generic retry.
No rejected raw payload was retained or used to tune this run.

The four non-passes were:

1. **Model selection:** the final answer explicitly used
   `tokenizer_config.json`'s `model_max_length` as the sentence-encoder default
   limit, despite the task requiring that distinction. It incorrectly included
   MiniLM in the qualifying set. The repair fixed plan structure, not source choice.
2. **Exact split counts:** screenshot 10 shows rounded `67.3k`; the final answer
   labels its expansion to 67,300 as exact. The navigation sequence succeeded, but
   exact-count verification did not. The judge cited an external exact figure;
   this review does not independently establish that figure or need it to explain
   the unsupported exactness claim.
3. **Milestone inventory:** the agent exhausted 100 actions without an answer.
   All 33 plans were valid. Final notes still listed 17 unchecked items after six
   verified PRs. Late batches repeatedly scrolled, clicked, waited, and returned
   to the same milestone page while rewriting unchanged progress notes. A recovery
   warning appears at observation 302; the action budget stopped the attempt.
   The previous planner error did not recur, but the task still did not succeed.
4. **Tagged dependencies:** Haiku returned an answer after 31 actions without a
   browser crash. Sonnet ended with `Model response exceeded its output-token limit`.
   Its two counted calls used 7,573 output tokens in total and cost about $0.14445.
   The saved memory was about 2.9 MiB, below the 24 MiB preflight cap; this was not
   a payload-budget rejection. No judge verdict exists. The earlier call's raw
   response/stop reason was not retained, so the record does not establish why
   that internal call was retried. No manual pass or replacement judgment was added.

## Notebook and evidence audit

Every final notebook exactly matches replayed accepted writes. There were 103 adds,
112 corrections, and 26 rejected writes: 22 duplicate adds, three mismatched
corrections, and one unavailable source reference. Fourteen corrections changed
neither text nor sources. No note was forgotten. Storage safeguards held, but
repeated writes and incomplete evidence remain behavior problems.

There were two recovery warnings (cross-page rows and milestone inventory), no
recovery/access stops, no timeouts, and no recorded HTTP 429s. GitHub's recorded
401s were background banner requests; other recorded 404s do not establish rate
limiting. Browser diagnostics do not rule out every unsurfaced provider/site issue.
The largest saved memory was 17.4 MiB; no judge-payload cap was exceeded.

Review covered every outcome and judge rationale, failed-task answers/action
histories, repair logs, notebook replay, and selected screenshots for the changed
passes, rounded-count failure, and final milestone state. It was an audit, not a
new judging pass. No behavior changes or additional live tests followed.
