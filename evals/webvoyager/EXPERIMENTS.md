# Evaluation and anti-overfitting protocol

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
