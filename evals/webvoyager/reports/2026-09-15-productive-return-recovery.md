# Productive-return recovery

## Result

The recovery fix passed offline regression checks. The frozen local Luna/Sonnet
run passed **3/4** attempts, with one runner-finalization error and no recovery
warnings or stops. All four tasks visited every required page. The changed-source
case completed its correction correctly. The long task reached the end and emitted
an answer, but its saved answer also contains four transcription errors.

All attempts remain in the denominator. No failed attempt was replaced, judged
afterward, or reclassified. No runtime changes followed the results.

## Candidate and mechanism

Revision: `14b82efd737a0889bf33724b44b2b5bc300f07b0`.
Source hash: `39a598822d1de15a5f9da83f66be25875d6988286b31cec2cbdd4567d4560464`.
Raw artifacts: `.context/notebook-live-2026-09-15T18-11-26.108Z`.
The worktree was clean at launch and completion; the hash matched before this
report was added. The candidate was committed and fast-forwarded to local `main`
before model calls.

Recovery now counts source-page/action-kind/destination-page transitions instead
of destination/action occurrences. New states outside a bounded 30-state LRU cache
clear repetition history. Distinct record visits can therefore reuse both a
directory and a shared return corridor without accumulating false failures.
Coordinates remain excluded, so click jitter does not disguise unchanged actions.

The warning threshold remains three, the stop threshold six, and transition
history stays bounded at 30. Waits, hovers, and passive observations do not add
failures; new content observed during them still clears history. Rate-limit and
access-barrier handling, fingerprint inputs, action budgets, and task resets remain
in place. No catalog-specific path, count, selector, or prompt hint was added.

The heuristic is intentionally limited: new states need not be useful progress,
long cycles can evade the bounded history, and unrepresented visual changes can
look unchanged. The hard action budget remains the backstop.

## Verification and frozen evaluation

321 tests passed, with zero failures and 4,403 assertions across 31 files. Core and
evaluation type checks, all five package builds, and whitespace checks passed.
Three new unit checks reproduced false positives on the old implementation.
Regression coverage includes varied graph depths and fan-outs, shared return
paths, distinct transitions to known hubs, unchanged clicks, two/three/five-state
cycles, passive observations, and task resets. The 16-case browser fixture suite
also exercises productive navigation, genuine cycles, cooldowns, access barriers,
scroll endpoints, input changes, notebook actions during a stop, and action caps.

During fixture development, click coordinates needed integer rounding. The expanded
suite also exceeded its old 90-second process deadline. Only the offline wrapper
timeout changed to 180 seconds; the passing browser suite took 96.7 seconds.
These offline iterations preceded the frozen candidate and all live calls.

The complete unchanged `notebook-live.ts --live --catalog` workflow ran once.
Models remained OpenAI `gpt-5.6-luna` with medium reasoning and Anthropic
`claude-sonnet-5` judging at temperature 1. One worker, 100 actions, 24 MiB judge
preflight, 1,200/300-second deadlines, three screenshots, 20 thoughts, and notebook
bounds were unchanged. All random inputs were drawn and saved before model calls.

```sh
bun evals/webvoyager/fixtures/notebook-live.ts --live --catalog
```

This command generates new data; it does not reproduce the identical saved attempt.

## All four attempts

| Case | Recorded outcome | Actions / actor calls | Note attempts / retained keys | Exact source-linked capture / latest final coverage |
| --- | --- | ---: | ---: | --- |
| One-record control | Pass | 4 / 2 | 2 / 2 | 1/1; 1/1 |
| Nine-record catalog, groups 4/4/1 | Pass | 37 / 24 | 14 / 14 | 9/9; 9/9 |
| 22-record catalog, groups 4/4/4/4/4/2 | Runner error; exact answer check fails | 84 / 55 | 32 / 30 | 18/22; 18/22 |
| Ten-record correction catalog, groups 6/4 | Pass | 41 / 26 | 16 / 14 | 10/10; 10/10 |

The three passes satisfy both exact checks and Sonnet. The long task received no
judge call because its saved status was `error`. Every record was visited once,
except the correction target, which was revisited once as required. All 102 saved
document responses were HTTP 200. There were no recovery observations, rate-limit
stops, timeouts, or action-budget failures.

The correction case's six-entry group exercised the productive-return pattern
that previously stopped after five entries. The other catalogs drew groups of
four, so they do not independently demonstrate crossing that old threshold.
The broader shared-path and cycle checks are covered offline.

There were 166 actions, 107 actor calls, 104 recorded plans, and three judge calls.
Each catalog used one existing planner-format retry; all three extra calls are
included. These are built-in retries within an attempt, not selective task reruns.

Estimated actor cost was $0.19575744; judge cost was $0.21376050; total cost was
**$0.40951794**. Approximate wall time was 564.4 seconds, or 9.4 minutes. Actor-task
times were 14.1, 123.7, 272.8, and 117.8 seconds. Full measurements and write audits
are in [the report JSON](2026-09-15-productive-return-recovery.json).

## Note audit and remaining errors

The 64 note attempts comprise 60 accepted adds, two accepted corrections, and two
rejected duplicate adds. There were no forget actions. Replaying accepted writes
exactly reproduces all four final notebooks; no invalid add or mismatched
correction was accepted.

In the long task, duplicate adds at observations 225 and 242 were rejected without
changing the existing notes. The actor replanned and continued. All 22 records
remained represented, along with eight task/directory notes. Four incorrect facts
were captured in notes and copied into the final answer:

| Record / screenshot observation | Field | Displayed value | Note and answer |
| --- | --- | --- | --- |
| 1 / 12 | Label | `Lot-5fff76cf` | `Lot-5ff76cf` |
| 2 / 22 | Label | `Lot-6b446c87` | `Lot-6b44c87` |
| 13 / 150 | Code | `89de6cdc-d967` | `89de6ccd-d967` |
| 18 / 206 | Label | `Lot-3169c5b9` | `Lot-316f9c5b9` |

Visual inspection confirmed all four discrepancies in the saved screenshots.
Each affected note cited the appropriate record screenshot. This is transcription
failure, not missing citations, overwritten records, or forgotten facts. All units,
the overall total, qualification booleans, and qualifying total were correct.

The correction case first clarified obscured directory labels at observation 31.
After the end page announced a change to record 3, the actor revisited it and
corrected that record at observation 129 using the exact current-text guard.
It changed units 706 to 977 and code `89cc5eea-1f2d` to `ddff848f-d43a`.
All other keys remained unchanged. The old code is absent from final notes; latest
source-linked coverage is 10/10. The audit's original-token-loss flag and 9/10
original final coverage reflect this intended replacement, not accidental data loss.

## Runner-finalization error

The long task saved its end-page observation at 268 and answer action at 273.
Its sidecar reached phase `finished`. The parent recorded worker exit code 0,
signal `null`, and saved status `running`, then marked the attempt as `error` with
`Worker exited without a final result`. It did not reach a deadline or the action cap.

Code inspection confirms that the runner awaits queued checkpoints, sets the
finished phase, and attempts a final memory save before cleanup. The saved evidence
does not establish why a final completed result was missing despite exit code 0.
Do not call this fixed, attribute it to rate limiting, or turn the saved answer
into a scored success. Its separate four-field exact mismatch would still need
to be addressed even if finalization succeeded.

## Interpretation and next step

This known developer-authored workflow uses fresh random values, not a blinded
holdout. The previous 2/4 and current 3/4 use different lengths and values; they
are not a paired estimate of a general performance gain. Evidence supports the
recovery mechanism and one successful changed-source correction. It does not
establish reliable transcription or end-to-end long-task success.

Next, investigate runner-finalization reliability with an independent offline
reproduction before another benchmark. Treat transcription verification as a
separate experiment. No additional live attempt, rejudgment, runtime tuning,
website benchmark, or consumed-holdout run followed these results.
