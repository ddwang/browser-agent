# Required memory review

## Result

Three of four predeclared synthetic checks passed both exact-answer validation
and the unchanged Sonnet judge. The long collection failed after Luna overwrote
facts it had already saved. Required review improved capture discipline in these
attempts, but **did not solve note-taking reliability**.

This is a mechanism experiment, not a new website benchmark or a held-out score.
No unsuccessful attempt was replaced, no result was rejudged, and no candidate
change followed the live outcomes.

## Frozen candidate

- Revision: `f65ab2f60bfc2fb10012b3bc0ff159df962f32de`.
- Source hash: `d169fa685dcf78099dd1ca7b751ed9c8927bc2cbc7a66b1229d9258d8433719c`.
- Raw artifacts: `.context/notebook-live-2026-09-15T15-31-02.582Z`.
- Actor: OpenAI `gpt-5.6-luna`, medium reasoning.
- Judge: Anthropic `claude-sonnet-5`, temperature 1, existing rubric/version.
- Limits: 100 actions, 24 MiB judge preflight, 1,200/300-second deadlines, one worker.
- Memory: unchanged three-screenshot/20-thought windows; 32 notes, eight sources
  per note, 2,000 characters per note, 64 KiB total notebook size.

The working tree was clean at launch and completion. Its source hash matched
before the report was added. All task lengths, values, paths, and corrections
were drawn and saved before the first model call. Reproduction generates new data:

```sh
bun evals/webvoyager/fixtures/notebook-live.ts --live
```

The planner now requires `memory_updates`, with an empty array allowed. The host
validates the entire response and saves updates through the existing audited note
action before executing browser actions. Failed writes consume an action and stop
the batch, preserving the current page for repair. Earlier successful writes remain.
There is no new fact schema, completion gate, retrieval tool, or separate model call.
The saved-checkpoint format and note replacement semantics are unchanged.

## Every attempt

| Check | Outcome | Actions / actor calls | Note writes | Exact source-linked capture before first departure | Exact source-linked final-note coverage |
| --- | --- | ---: | ---: | ---: | ---: |
| 1-record control | Pass | 4 / 2 | 2 | 1/1 | 1/1 |
| 8-record collection | Pass | 18 / 9 | 9 | 7/8 | 7/8 |
| 28-record collection | No-progress block; no answer | 62 / 32 | 31 | 27/28 | 15/28 |
| 9-record correction plus irrelevant page | Pass | 25 / 12 | 13 | 9/9, before correction | 9/9, corrected values |

All required pages were visited. Every collection record was loaded once, except
the corrected first record, which was loaded exactly twice as required. The long
task's attempted back-navigation actions did not load another record. All saved
document responses were HTTP 200; these local tasks encountered no site rate limit.

The coverage diagnostics require exact label, units, and code tokens in a successful
note linked to that record's screenshot. They do not establish semantic support
or prove that the actor used the note. Capture before departure is stricter than
eventual correctness, and an immediately finishable task need not write a note.
Final answers are independently compared with the generated values, ordering, and sum.

Across all attempts: 109 actions, 55 actor calls, 55 accepted note writes, 41 retained
keys, zero write errors, zero forget actions, and three judge calls. All 55 actor
calls produced recorded plans. Estimated cost was $0.08286604 for the actor and
$0.10320010 for the judge: **$0.18606614 total**. Approximate wall time was 309.4 seconds.
The runner and wrapper exited 1 because the long task did not pass. The block stayed
in the denominator and did not receive a judge call. Full measurements are in
[the report JSON](2026-09-15-required-memory-review.json).

## Why the long task failed

Luna captured every record into a note, but repeatedly replaced one shared
`collection_entries` key. Observation numbers below refer to its saved memory:

1. Through the note write at observation 45, the key held exact values for entries 1–8.
2. At observation 51, Luna replaced it with “Entries 1–8 recorded” plus entry 9's
   values. This removed the first eight records from the active notebook.
3. Subsequent updates accumulated entries 9–12. At observation 75, Luna replaced
   the same key with entry 13 alone, removing another four records.
4. Starting with entry 14, Luna used separate keys. At thought 80 it recognized
   that entries 1–12 were unavailable, but continued through the collection.
5. At the end, it attempted ineffective back-navigation and reported `no_progress`.
   The old values remain in the saved audit, but there is no actor history-recall tool.

These were valid replacement operations, not host eviction, rejected writes, an
action-budget stop, or a provider failure. The first destructive replacement came
after the note's source list reached its eight-reference limit; this timing does
not establish why Luna chose to discard the earlier values. It could have used
another key without discarding them.

There was also a transcription error. Screenshot 162 displays entry 28's code as
`ebcfc8e6-f4f5`; Luna wrote `ebfcf8e6-f4f5`. Visual inspection confirms the discrepancy.
This explains why exact capture was 27/28, and why final coverage was 15/28 rather
than the 16 records whose values remained in notes. Preserving writes alone would
not fix this error.

## Other findings

The eight-record run wrote correct values for all eight records. Its fifth note
cited observation 25, an open-tabs list, instead of screenshot 24 containing those
values. The host permits visible connector references, so it accepted the write;
the stricter diagnostic correctly counted only seven screenshot-linked records.
The final answer was exact, but valid reference numbers are not necessarily good
support for a claim.

The correction run used a separate key per record. After the end page announced
a correction, Luna revisited the first record, replaced only that record's note,
and returned the correct updated values and total. All nine latest records remained
source-linked. The obsolete confirmation code was absent from the final notebook.
It excluded the irrelevant page from the answer, although it wrote a note about it.

The short control added overhead: four actions and two notes, versus two actions
and no notes in the previous random control. In particular, Luna wrote another
completion note immediately before answering, despite an empty review being valid.

## Comparison limits and next experiment

The earlier optional-note checks used different random values and lengths:
1, 9, and 25 records. They passed 2/3. The nine-record case made three collection
passes; the 25-record case blocked after omitted facts. Applying the new diagnostic
retrospectively gives 5/9 and 13/25 exact source-linked captures before departure.
The current eight-record case needed only one pass, and the 28-record case captured
27/28 correctly before later overwrites. These observations support the capture
hypothesis, not a paired performance claim: lengths and task instructions differ,
the correction case is new, and neither set is a fresh holdout.

The next experiment should test non-destructive fact updates: distinct records
must survive adding another record, while an explicit correction can update the
same record. Prefer a bounded record/update contract over another generic reminder
to preserve facts. Test it on unseen workflow families, alongside correction,
capacity, provenance, and short-task overhead checks. Transcription and weak source
links remain separate problems. No such follow-up mechanism was added here.

The consumed website holdout and the 12-task development benchmark were not rerun.

## Offline verification

311 tests passed with zero failures and 2,007 assertions across 30 files. Core and
evaluation type checks, all five package builds, and `git diff --check` passed.
Coverage includes both real provider adapters with loopback responses, missing or
invalid reviews, bounded format repair, write-before-navigation ordering, rejected
write recovery, action accounting, empty reviews, task isolation, memory eviction,
checkpoint compatibility, and the diagnostic metric's negative cases.
