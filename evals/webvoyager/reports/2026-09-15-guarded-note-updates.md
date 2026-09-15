# Guarded note updates

## Result

The guarded write contract is implemented and passes its offline checks. The
predeclared local run passed **2/4** cases; two cases stopped because the existing
recovery guard mistook productive directory returns for a loop. All 31 note writes
succeeded, and no saved record was lost through an overwrite. This does not yet
demonstrate reliable long-task retention or changed-source correction.

No attempt was replaced or rejudged. The runtime remained frozen throughout the
run. The website development benchmark and consumed holdout were not rerun.

## Contract and frozen candidate

Revision: `5ed958b4118ffe5c27efd2b8e33e5f44b54ede96`.
Source hash: `03269b98b996bd6beb5c6c8ab00fa06ffe083966f91d41a058f578ad91c3ba88`.
Raw artifacts: `.context/notebook-live-2026-09-15T17-33-37.923Z`.
The working tree was clean at launch and completion; the source hash matched
before adding this report.

Each planner update now includes `operation` and `expected_text`:

- `add` requires a new key and `expected_text: null`. Existing keys are rejected,
  never implicitly replaced.
- `correct` requires an existing key and its exact current text. Only that key
  changes; omitted keys remain unchanged. A stale or missing match is rejected.

The actor is instructed to use separate keys for independently correctable
records, rather than rewrite a growing collection summary. Rejected writes retain
existing data, cost one action, and stop the batch before navigation. Explicit
forget remains available. Matching a note's current text does not prove the
replacement is correct or preserve omitted details within that corrected record.

Stored notes remain `{key, text, sources}`. Checkpoints with unique keys remain
compatible; duplicate keys are rejected without replacing current memory. Direct
`memory.remember(note)` calls now add only; an explicit current-text argument is
required to correct a record. `memory:note` callers use the new guarded schema.
No separate model call, fact judge, history retrieval, or new version field was added.

Models and limits stayed unchanged: OpenAI `gpt-5.6-luna` with medium reasoning;
Anthropic `claude-sonnet-5` judge with temperature 1; one worker; 100 actions;
24 MiB judge preflight; 1,200/300-second deadlines; three retained screenshots and
20 thoughts. Notebook limits remain 32 keys, 2,000 characters and eight sources
per note, and 64 KiB total.

Reproduction generates fresh random data, not the same saved attempt:

```sh
bun evals/webvoyager/fixtures/notebook-live.ts --live --catalog
```

## All four attempts

The new catalog workflow requires carrying a qualification rule from an overview
through group directories and individual record pages. The answer must include
every record, its qualification boolean, and both overall and qualifying totals.
All lengths, groups, rules, values, paths, and correction targets were generated
and saved before model calls.

| Case | Outcome | Records visited | Actions / actor calls | Note writes | Exact screenshot-linked capture / final coverage |
| --- | --- | ---: | ---: | ---: | --- |
| One-record serial control | Pass | 1/1 | 4 / 2 | 2 | 1/1; 1/1 |
| Ten-record catalog, groups 4/4/2 | Pass | 10/10 | 40 / 25 | 15 | 8/10; 8/10 |
| 27-record catalog, groups 5/5/5/5/5/2 | Recovery false stop | 5/27 | 18 / 12 | 7 | 4/27; 4/27 |
| Ten-record correction catalog, groups 6/4 | Recovery false stop | 5/10 | 18 / 12 | 7 | 3/10; 3/10, original values |

Both passes were confirmed by exact answer checks and Sonnet. Both blocked cases
remain in the denominator, returned no answer, and received no judge call. Every
visited record was loaded once; returns to directories were required navigation,
not repeated record inspections. All 51 saved document responses were HTTP 200.

There were 80 actions, 51 actor calls, two judge calls, 30 successful adds, one
successful correction, zero rejected writes, zero forget actions, and 30 retained
keys. All actor calls produced recorded plans. Replaying the accepted writes
reproduces each final notebook, with no invalid add or mismatched correction accepted.
The sole correction clarified an obscured directory label at observation 21 of
the passing catalog; it preserved that directory's other content and all other keys.
Live rejection handling was not exercised; offline checks cover it.

Estimated actor cost: $0.07952684. Estimated judge cost: $0.141766.
Total: **$0.22129284**. Approximate wall time: 699.4 seconds, or 11.7 minutes.
Actor-task times were 33.5, 234.3, 266.1, and 106.4 seconds respectively. Some
planning calls were slow, but neither blocked task reached its deadline. The
underlying provider-latency cause was not established. The runner and wrapper
exited 1. Full measurements are in [the report JSON](2026-09-15-guarded-note-updates.json).

## Why two tasks stopped

`BrowserRecovery.observe()` counts occurrences of `fingerprint:action.variant`
within its last 30 action outcomes. A directory reached through a click therefore
shares a counter across returns from different records. Intermediate new pages
reset the current repetition value, but not the retained occurrence history.

After the initial directory visit and five productive record-return pairs, the
directory has six matching outcomes. `BrowserRecovery.check()` then rejects the
next nonterminal action regardless of its target. The actor cannot follow its
planned different link because the browser connector checks this state before
executing the next action.

In the 27-record run, observation 61 shows a directory with all five entries visited
and an available **Next group** link. Thought 64 explicitly plans to use it. The
host stops the task before that click. In the correction case, the final thought
plans to open the sixth entry, but the same guard stops execution after the fifth
return. This is a host false positive, not a model-declared inability to proceed,
site rate limit, rejected note, lost notebook record, or action-budget failure.

A read-only reproduction using the existing recovery class confirmed the mechanism:
observe a directory, then five distinct record fingerprints with directory returns,
then check a different click. The unchanged guard throws `no_progress`.

The passing catalog's groups had at most four records, so each directory stayed
below this threshold. Do not encode that fact into task generation or increase
the threshold to fit these cases. The general follow-up is to distinguish repeated
non-progress transitions from productive returns, while retaining genuine-loop,
rate-limit, and hard-action-budget protections. No recovery fix was added to this
frozen experiment.

## Remaining note-quality issues

The passing ten-record catalog retained correct values for all ten records, but
two notes cited open-tabs observations 25 and 85 instead of the screenshots
containing the facts. This explains its 8/10 strict screenshot-linked coverage.

The blocked cases also contain transcription errors:

- The 27-record case's fourth record displays `Lot-24f44fe5` in screenshot 44;
  its note says `Lot-2f744fe5` and cites the adjacent tab-list observation 45.
- The correction case's second record displays `Lot-628bc3f4` in screenshot 22;
  its note drops the `c`, writing `Lot-628b3f4`. Its fourth record's values are
  correct, but the note cites tab-list observation 45.

Visual inspection confirmed both label discrepancies. These are inaccurate
capture or weak evidence links, not overwrites, and the new write guard cannot
correct them automatically.

The correction workflow never reached the end page that publishes the change.
Its original fifth-record value therefore remained valid when the host stopped.
The raw diagnostic reports the old code present and only 2/10 coverage against
the planned corrected values; that is not evidence of ignoring an observed
correction. Changed-source correction remains unvalidated in this live batch.

The short control still uses two notes and four actions, unchanged from the
previous required-review control. This change does not remove short-task overhead.

## Verification and interpretation

315 tests passed with zero failures and 2,774 assertions across 31 files. Core and
evaluation type checks, all five package builds, and whitespace checks passed.
Offline tests cover duplicate adds, exact and stale corrections, omitted-record
invariants over varied update sequences, source/capacity failures, task isolation,
checkpoint restoration, both provider adapters, action accounting, navigation
gating, and catalog generation and exact rule validation.

The catalog is a new developer-authored workflow, not a blinded holdout. It differs
from earlier serial collections, so 2/4 versus the earlier 3/4 is not a paired
performance comparison. Early recovery stops prevented the intended long-retention
and changed-source checks from completing. The evidence supports the guarded
write semantics, not a claim that note-taking reliability is solved.

The next bounded change should address the general recovery false positive,
then evaluate a new frozen candidate with all outcomes preserved. Transcription,
evidence-link quality, and detail loss inside explicit corrections remain separate
limitations. No selective retries, rejudgments, runtime tuning, website benchmark,
or consumed-holdout runs followed these results.
