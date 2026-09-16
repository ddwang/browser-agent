# Planner recovery development checkpoint

This is a **development-suite result**, not a held-out generalization score.
The tasks and prior failures were inspected before implementation. No site-specific
answers, selectors, URLs, or task-ID branches were added to the agent.

## Changes and configuration

Added a single-plan JSON contract, strict whole-response/action validation, and one
format-only retry before executing any actions. Usage is now collected per model
invocation in `finally`, including rejected responses and provider retries that
report usage. Query/extraction failures also report usage; concurrent calls do not
share cumulative counters.

Run: `results/2026-09-15T08-07-13.801Z`.
Source hash: `b60ff8ada9aa70a8ca5b6122c31ae9ae9b17ec2a6d12b61809df564f22138592`.
Actor: Haiku 4.5 (`claude-haiku-4-5-20251001`), temperature 0.2.
Judge: Sonnet 5 (`claude-sonnet-5`), temperature 1; unchanged judgment instructions.
One worker, 100 actions, 24 MiB judge history, 20-minute task deadline.
All 12 tasks ran once. No code, task criteria, or configuration changed mid-run.

## Results

| Outcome | Original hard run | This checkpoint |
| --- | ---: | ---: |
| Pass | 1 | 5 |
| Judged failure | 0 | 3 |
| Planner error | 11 | 2 |
| No-progress stop | 0 | 1 |
| Judge error | 0 | 1 |
| Rate-limit block / timeout / budget failure | 0 / 0 / 0 | 0 / 0 / 0 |

Original run: `results/2026-09-15T07-45-07.006Z`, preserved without replacement.
Success rate: 5/12 (41.7%). Executed actions: 219. Median/p95 actor duration:
70.5/209.5 seconds. Estimated actor/judge cost: $1.242232/$0.736491, $1.978723 total.
**Old cost totals are not comparable:** failed parser responses were not accounted
for before this change.

| Task | Outcome | Actions |
| --- | --- | ---: |
| ArXiv Hard--0 | Judge error | 17 |
| ArXiv Hard--1 | Planner error | 8 |
| ArXiv Hard--2 | Planner error | 6 |
| ArXiv Hard--3 | Pass | 11 |
| Huggingface Hard--0 | Pass | 37 |
| Huggingface Hard--1 | Wrong configuration files/metric | 37 |
| Huggingface Hard--2 | Rounded count reported as exact | 5 |
| Huggingface Hard--3 | Pass | 9 |
| GitHub Hard--0 | Pass | 14 |
| GitHub Hard--1 | Pass | 27 |
| GitHub Hard--2 | Repeated page states | 34 |
| GitHub Hard--3 | Required file-viewer workflow not followed | 14 |

The judge error returned prose and reached 4,096 output tokens without its required
JSON verdict. Its input history was only 3.8 MB, so this was not the oversized-payload
case. The paid failure's usage was correctly recorded. Planner errors exhausted
the two-attempt limit; they are not hidden browser-task retries.

The no-progress task repeatedly reopened the same small subset of milestone items.
It was not rate-limited. No recorded HTTP 429 occurred anywhere in this run.
The final file-comparison failure reflects a procedural constraint: the dependency
content appeared correct, but the actor used raw file pages instead of the required
GitHub file viewer. That criterion was unchanged, not added after seeing the answer.

## Interpretation

The output boundary is more reliable but not solved. Some rejected responses were
otherwise valid single plans with surrounding prose; the strict boundary deliberately
does not execute text recovered from narrative output. A general next experiment is
provider-enforced JSON schemas, tested independently of these browser tasks.

Do not add prompts about particular filenames, exact row counts, or known milestone
items based on these failures. Freeze a disjoint holdout before further changes,
use only the development suite for iteration, and report the holdout once after
freezing the candidate. Keep failed/blocked tasks in every reported denominator.
