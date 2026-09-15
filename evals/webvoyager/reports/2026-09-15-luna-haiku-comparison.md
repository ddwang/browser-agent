# Full Luna and Haiku comparison

## Result

On the complete 12-task hard development suite, **Luna/Sonnet passed 10/12** and
**Haiku/Sonnet passed 6/12**. Luna used fewer actions, finished sooner, and had lower
estimated cost. This compares the configured agents on one repeated development
run each, not isolated model capability or held-out generalization.

All 24 attempts remain in the denominator. There were no selective task reruns,
replacement judgments, runtime changes, or test changes between runs.

| Metric | Luna / Sonnet | Haiku / Sonnet |
| --- | ---: | ---: |
| Successes | 10/12 (83.3%) | 6/12 (50.0%) |
| Content failures | 1 | 4 |
| Planner errors | 1 | 1 |
| Browser errors | 0 | 1 |
| Actions | 336 | 414 |
| Actor calls / accepted plans | 207 / 205 | 217 / 213 |
| Judge calls | 11 | 10 |
| Estimated actor cost | $0.33944 | $1.64930 |
| Estimated judge cost | $0.86653 | $1.01397 |
| Estimated total cost | $1.20597 | $2.66327 |
| Approximate run wall time | 28.2 min | 44.1 min |
| Median actor-task time | 64.2 s | 167.6 s |
| p95 actor-task time | 448.0 s | 490.7 s |
| Note attempts / retained keys | 127 / 122 | 195 / 80 |
| Rejected note attempts | 3 | 18 |

Combined estimated cost: **$3.86924**. Costs use the harness's configured rates and
recorded usage, not billing reconciliation. Wall time is measured from manifest
creation to the final summary file; task latency includes browser and agent work
but excludes the separate judge. Errors and early exits are included in latency
statistics. Raw token fields have provider-specific accounting and should not be
treated as directly comparable context volumes.

## Frozen protocol and artifacts

Revision: `5987bb17ccdd0e3fd3a85b0428b26fe38f2e5dc4`.
Source hash: `0069f0faa416f5f1bb32c9173b925a30aeb4f4ac766358c2cebe56521b8b8ba8`.
Suite: `evals/webvoyager/baseline.json`, partition `development`.

- Luna: OpenAI `gpt-5.6-luna`, medium reasoning, no explicit temperature.
- Haiku: Anthropic `claude-haiku-4-5-20251001`, temperature 0.2.
- Both judges: Anthropic `claude-sonnet-5`, temperature 1, judge version 2.
- One worker, 100 actions, 24 MiB judge preflight, 1,200-second task deadline,
  300-second judge deadline, three screenshots, and 20 retained thoughts.
- The guarded notebook remains limited to 32 keys, 2,000 characters per note,
  eight sources per note, and 64 KiB total.

The protocol was committed before model calls. Luna ran first, and all 12 Luna
outcomes were reviewed before starting Haiku without changing the candidate.
Both manifests match in every field except actor configuration and creation time.
Both source hashes matched the unchanged clean worktree after completion, before
this report was added. Provider transports differ: Luna uses the BAML OpenAI
chat-completions path with local validation; Haiku uses native Anthropic structured
outputs. Both retain the existing within-attempt format retry.

Raw runs are preserved locally in the gitignored results directory:

- `evals/webvoyager/results/2026-09-15T19-33-25.619Z-luna`
- `evals/webvoyager/results/2026-09-15T20-06-01.373Z-haiku`

The [report JSON](2026-09-15-luna-haiku-comparison.json) contains all per-task
measurements, original judge reasoning, notebook replay audits, and review notes.
Raw artifacts contain the full observations, screenshots, status sidecars, usage,
and redacted process logs. Both run commands exited 1 because not every task passed;
all 24 attempts reached a terminal result with none pending or unscored.

## Every paired outcome

Actions include notebook operations. Calls include built-in format retries.

| Task | Luna outcome | Actions / calls | Haiku outcome | Actions / calls |
| --- | --- | ---: | --- | ---: |
| ArXiv Hard--0: constrained author audit | Planner error | 27 / 15 | Pass | 24 / 7 |
| ArXiv Hard--1: Title versus Abstract sets | Pass | 35 / 18 | Pass | 37 / 15 |
| ArXiv Hard--2: three-paper metadata | Pass | 9 / 5 | Fail | 39 / 21 |
| ArXiv Hard--3: full revision histories | Pass | 7 / 4 | Pass | 28 / 15 |
| Huggingface Hard--0: model selection | Pass | 47 / 33 | Fail | 29 / 17 |
| Huggingface Hard--1: card/config audit | Pass | 66 / 52 | Fail | 58 / 35 |
| Huggingface Hard--2: split comparison | Fail | 22 / 13 | Fail | 13 / 7 |
| Huggingface Hard--3: cross-page rows | Pass | 16 / 9 | Pass | 30 / 17 |
| GitHub Hard--0: feature-to-issue-to-PR | Pass | 14 / 7 | Pass | 29 / 15 |
| GitHub Hard--1: release/PR comparison | Pass | 12 / 7 | Pass | 84 / 46 |
| GitHub Hard--2: milestone inventory | Pass | 70 / 38 | Planner error | 40 / 19 |
| GitHub Hard--3: tagged dependencies | Pass | 11 / 6 | Browser error | 3 / 3 |

Five tasks passed for both, five passed only for Luna, one passed only for Haiku,
and one passed for neither. By site, Luna scored 3/4 arXiv, 3/4 Hugging Face,
and 4/4 GitHub; Haiku scored 3/4, 1/4, and 2/4 respectively.

## Failure review

### Planner and browser errors

Luna's first arXiv task and Haiku's milestone task both ended with
`Planner returned an invalid plan on both attempts`. Luna had 13 accepted plans
and 15 calls; Haiku had 17 plans and 19 calls. Neither produced an answer or a
judge call. The logs do not record the specific rejected-schema defect, so its
exact cause remains unresolved. Both notebooks replay correctly.

Haiku also recovered from one format retry in each of ArXiv Hard--2 and Huggingface
Hard--3. Those extra calls are included. No failed task was retried afterward.

Haiku's final task ended with `move: Target page, context or browser has been
closed` after three completed actions and three accepted plans. It had searched
for `pyproject.toml` but had not inspected either requested tag. The initial GitHub
document returned HTTP 200; a background banner request returned 401. The saved
evidence does not establish why the page/context/browser closed. This is a browser
error, not a scored content failure, a rate-limit finding, or the earlier
`Worker exited without a final result` bug. That earlier finalization error did
not recur in either full run.

### Unsupported exact counts: both agents

On Huggingface Hard--2, Luna reported 67,309 train rows by treating the last visible
row on the final pagination page as the final dataset row. Screenshot observation
64 still shows the top of a scrollable table, so the endpoint was not verified.

Haiku converted the displayed rounded `67.3k` into 67,300 and labeled it exact.
Its screenshots 0 and 39 show only the rounded train count. Both agents completed
the required train → validation → train navigation but failed the explicit
exact-count requirement. These are evidence-completeness failures, not lost notes.

### Haiku's other content failures

- **ArXiv Hard--2:** selected Attention's v6 from July 24, 2023 instead of v7 from
  August 2, 2023. Screenshot 62 shows v7, and the retained note contains both that
  correct history entry and the contradictory v6 conclusion. The answer copied
  the wrong conclusion without reconciling the contradiction.
- **Huggingface Hard--0:** selected E5 correctly but reported MPNet's default input
  limit as 512. Its retained note explicitly said that value was unresolved.
  The final answer introduced an unsupported value.
- **Huggingface Hard--1:** substituted `config_sentence_transformers.json` for the
  requested `sentence_bert_config.json` in both repositories. It then concluded
  `max_seq_length` was absent and could not compare agreement. The visited URLs,
  notes, and answer confirm the filename substitution; no access barrier prevented
  inspection of the required file.

## Notebook reliability and wasted work

| Accepted-write audit | Luna | Haiku |
| --- | ---: | ---: |
| Adds | 122 | 80 |
| Corrections | 2 | 97 |
| Corrections retaining identical text | 0 | 33 |
| Corrections retaining identical text and sources | 0 | 21 |
| Rejected writes | 3 | 18 |
| Forget actions | 0 | 0 |

Replaying accepted writes exactly reproduces every final notebook. No duplicate
add or mismatched correction was accepted. This verifies storage semantics, not
the truth, completeness, or usefulness of the saved facts.

Luna's three rejections were a mismatched correction, a duplicate add, and a 33rd
note at capacity. The affected tasks still passed. Its milestone task retained
32 keys and completed after the capacity rejection without forgetting a note.
Haiku's 18 rejections comprised 15 duplicate adds, one mismatched correction, and
two unavailable source references. It frequently rewrote growing summary notes
instead of adding separate records; 21 corrections changed nothing at all.
Notebook attempts consumed 37.8% of Luna's actions and 47.1% of Haiku's.

Haiku's Requests task illustrates avoidable navigation and note overhead: it
assumed the migration PR had to differ from the CVE-related #6710, repeatedly
revisited the release text, and rewrote notes. A browser-recovery warning at
observation 246 preceded direct navigation to #6710, where it resolved the
assumption and finished correctly. The task used 84 actions, including 40 note
attempts, versus Luna's 12 actions. The warning did not stop the task.

Neither run hit an action budget, judge-payload budget, task timeout, judge error,
or access/recovery stop. Luna had no recovery warnings; Haiku had the one warning
described above. Largest serialized memories were about 15.1 MiB and 10.4 MiB,
respectively, below the 24 MiB judge preflight cap.

## Evidence and limitations

Every outcome and judge rationale was reviewed. Saved screenshots were inspected
for the count/version failures and representative successes, including arXiv
author counts and histories, model configuration/prefixes, GitHub feature-to-PR
links, and Luna's milestone closure date. This was an audit, not a replacement
judging pass.

No task recorded HTTP 429. Some runs recorded missing-resource 404s and background
GitHub 401s; those do not establish rate limiting. The available logs do not rule
out every unsurfaced provider or site issue, and the browser-closure cause remains
unknown. No error was removed from the headline score as an infrastructure excuse.

Sonnet's exact-count judgments invoked the externally familiar count 67,349.
This review does not independently validate that external figure: the incomplete
pagination evidence and rounded-derived answer already establish failure of the
required exact verification. In Haiku's config audit, the judge also overstates
that the remaining six-source criterion was satisfied; two supplied URLs were for
the wrong files. The recorded failure is still supported. No judgment was changed.

The development suite is small, previously inspected, and contains related tasks.
Luna-first sequential execution also allows time-dependent site or shared-IP
effects. The consumed holdout was not reused, and local fixture scores are not
mixed into these 24 attempts. The results support preferring this Luna configuration
for this workload, not a general performance claim.

No implementation change followed these results. General follow-up candidates are
better planner-validation diagnostics, independent browser-lifecycle diagnosis,
less redundant note rewriting, and stronger reconciliation of incomplete or
contradictory evidence. Any change should be tested on independent workflows before
another frozen evaluation, without adding site-specific answers or task hints.
