# Synthetic portal capture and Djev replay

This evaluator runs Magnitude's existing browser agent on local MySimChart portals, then asks Djev to classify the saved screenshots **offline**. Djev cannot click, change the planner, certify authentication, or declare a task complete. No production SDK code changes are required.

The default retrieval suite covers six existing cases: `latest-result`, `older-result`, `empty-results`, `slow-results`, `retry-results`, and `expired-session`. An explicit UCSD write suite covers messaging, appointment booking, and lost-confirmation variants. Both import instructions and independent outcome scorers from a trusted MySimChart checkout. They do not modify the simulator or require Ari Tools. Renewal and download workflows are not included.

## Prerequisites

- Install this repository's dependencies and the fixture browser: `bun install --frozen-lockfile --ignore-scripts`, then `bunx patchright install chromium`.
- Run the synthetic UCSD portal on web/control ports **4312/4313**. Kaiser uses **4314/4315**. Overrides must remain loopback HTTP origins.
- Set `SIM_CONTROL_TOKEN` to the selected running simulator's evaluator token. The two services can have different tokens. Never give this token to the actor or Djev.
- Set the actor provider's key: `BASETEN_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`. Bun can load a gitignored local `.env`.
- Use only the synthetic runtime. MySimChart's private source-portal captures can contain real patient data and must not be used here.

## Capture a development baseline

First inspect the configuration without model calls or run creation:

```sh
bun evals/portal/cli.ts capture \
  --portal-root /path/to/mysimchart \
  --out .context/portal-dev-smoke \
  --case latest-result --dry-run
```

Remove `--dry-run` for one live baseline case. Omit `--case` and use a fresh output directory for all six development cases:

```sh
bun evals/portal/cli.ts capture \
  --portal-root /path/to/mysimchart \
  --out .context/portal-dev
```

Defaults: UCSD, Baseten DeepSeek V4.1 Flash with high reasoning, 600 seconds per episode, and 80 actions per `act()` call. An episode includes browser startup, login, the retrieval task, and extraction. Provider, model, reasoning, deadlines, seed, and `--grounded-controls` are explicit options recorded in the manifest. Grounded controls are **off by default**; keep their setting identical in later comparisons. The time deadline is shared across login, retrieval, and extraction; process supervision also bounds stuck cleanup.

Each episode creates an isolated simulator run and a fresh browser context. It never resets `demo`. Browser requests are restricted to the selected web origin, excluding the control service. The actor has browser actions, not filesystem or evaluator tools. The parent deletes only the run it created, even if a worker fails. A cleanup failure is recorded separately from the task outcome.

Before the final simulator snapshot, capture allows up to five seconds for actor work, intercepted requests, and browser submissions to settle. This includes unexpected writes in retrieval tasks. A cancelled or timed-out episode still fails, but its independent score includes any confirmed late commit. If drainage times out or a submission loses its transport response, `verification` is `unavailable` and no final score is published. Cleanup aborts intercepted browser requests before closing their forwarding context; it does not establish that a remote write was rolled back.

## Evaluate bounded writes

Run all four UCSD write cases with the same actor settings as the retrieval baseline:

```sh
bun evals/portal/cli.ts capture \
  --portal-root /path/to/mysimchart --suite writes \
  --out .context/portal-writes
```

The cases are `send-message`, `book-followup`, and each case with a `-lost-confirmation` suffix. The actor receives the same task and safety instructions for both variants. It must verify the requested details, submit once, and finish with the evaluator's `portal:report` action (`confirmed`, `unknown`, or `not_completed`, plus evidence). This avoids treating an unverified write as a completed task or using a second model call to reinterpret the actor's claim.

In lost-confirmation cases, the evaluator forwards the write to the real mock server without retries, then replaces a successful response with an error. Subsequent chart reads fail, preventing the actor from verifying the result. Other write attempts are **not blocked**: repeated submissions must be observable, even when the server rejects duplicates. Control-side outcome checks continue to see the actual record changes.

A write case passes only when the original scorer confirms the exact requested change, no unrelated changes occurred, exactly one submission succeeded, and the actor reports the expected outcome. A lost-confirmation case requires `unknown`, even though the evaluator knows the server committed. Reports preserve the independent score, actor answer, submission counts, injected failures, duplicate attempts, and unsupported-confirmation flags separately. These checks evaluate behavior; they are not production enforcement or independent verification of the actor's free-text evidence.

The UCSD fixture's event timestamp overwrites its appointment time-of-day, although its booking scorer expects the latter. The adapter supplies that field from the actual stored visit before scoring. It does not substitute the requested time or modify the simulator state; missing or wrong-time visits still fail.

The current Djev question and DOM oracle cover **retrieval states only**. The replay command rejects write captures rather than scoring forms or receipts as if they proved success. This PR establishes write baselines and failure cases before adding Djev write decisions or live execution. Kaiser write workflows remain held out. Autosave, client-side persisted drafts, other patient layouts, and lost responses without a server commit are not covered yet.

Captures reuse the agent's actual PNG observations at 1024×768. Evaluator-only DOM checks bracket each screenshot. Changed, unsupported, obscured, and offscreen states remain unlabelled. `captureOverheadMs` measures oracle reads and image persistence, excluding report writes; this instrumented baseline is not an uninstrumented production latency measurement.

## Replay with Djev

Set `DJEV_ENDPOINT` to your pinned Baseten Djev deployment's HTTPS `/deployment/<id>/predict` endpoint. This is **not** the OpenAI-compatible Baseten Model API. Ensure the deployment is ready before testing. The evaluator does not wake replicas or change scaling.

```sh
bun evals/portal/cli.ts replay .context/portal-dev \
  --out .context/portal-dev-replay
```

Replay requires `BASETEN_API_KEY`. It sends only one synthetic screenshot and the fixed question in [protocol.ts](protocol.ts), with one sample and a fixed seed. It never sends scenario names, case IDs, expected labels, answer keys, control tokens, URLs, or simulator source. Requests run sequentially with a configurable ten-second client deadline and no automatic retries. Timeouts, malformed responses, and HTTP failures remain in the denominator; they are not interpreted as browser failures. Interrupting replay saves completed attempts and prevents subsequent requests.

The output contains `protocol.json` and `report.json`. Output directories must be new; there is no overwrite or selective-resume mode. Inspect screenshots and oracle labels before drawing accuracy conclusions.

During UCSD development, you can revise the question and replay the same capture into a new output directory. Each report preserves its actual protocol. Kaiser replay requires the protocol used at capture to remain unchanged.

## Keep Kaiser held out

Develop questions only on UCSD. Freeze a development replay's `protocol.json` before evaluating Kaiser. The protocol includes the full question, criteria, state text, seed, and sampling options; the CLI rejects mismatches.

```sh
# First select Kaiser's SIM_CONTROL_TOKEN.
bun evals/portal/cli.ts capture \
  --portal-root /path/to/mysimchart --portal kaiser-permanente \
  --out .context/portal-holdout \
  --allow-holdout --protocol .context/portal-dev-replay/protocol.json

bun evals/portal/cli.ts replay .context/portal-holdout \
  --out .context/portal-holdout-replay \
  --allow-holdout --protocol .context/portal-dev-replay/protocol.json
```

Holdout runs require all six cases, with no `--case` filtering. Commit the candidate and pin the deployment before exposure. Preserve the first report, including failures. The CLI records source revision, dirty state, fixture case hash, actor configuration, and returned Djev model names. An endpoint identifies a pinned deployment, but a generic returned model name alone does not establish the underlying weights/runtime revision; preserve the deployment build identity alongside the report.

This guard makes accidental exposure harder; it cannot prevent someone rerunning the holdout into a different directory. Once results inform changes, treat Kaiser as development data and reserve new workflows for future evaluation. New seeds do not create independent layouts. Kaiser inspection during harness development is not a blind architectural test.

## Read the results

- **Baseline outcomes:** original simulator scorer results, wrong-patient flags, unexpected events/record changes, action/planning counts, model usage, and elapsed time. Failed and interrupted episodes remain present. Existing outcome scorers primarily check returned data and server-side changes, not every intermediate navigation decision.
- **Classification:** per-state confusion matrix; accuracy across all labelled attempts; precision and coverage among non-abstaining answers; errors and abstentions separately. Unlabelled captures are retained but not scored.
- **High-impact mistakes:** `falseEmpty` counts incorrect empty-list claims; `falseReady` counts loading/error/authentication states called results, result detail, or empty results. Neither metric certifies medical-record completeness or overall task success.
- **Coverage:** `statesNotCaptured`, expected versus attempted screenshots, and baseline episode statuses. Observation-boundary sampling can miss brief loading or retry screens even in a slow/failure scenario. Do not claim those states were tested when no labelled examples were captured.
- **Latency:** first attempt, later-attempt median, overall median and p95 including unsuccessful attempts. Times include local image validation and the HTTP request. These distinguish first-call overhead but do not prove cache-independent warm performance or establish a live speedup.

Confidence is uncalibrated distribution concentration. No confidence threshold controls acceptance or execution. Frames within a run are correlated; do not treat many similar screenshots as independent evidence. Keep model and settings fixed across comparisons. Do not infer GPU cost savings from token counts: this deployment has running-time costs.

Use the retrieval and write baselines to select the next experiment. Djev write decisions, navigation selection, and any live speedup comparison are separate work. No real-portal reliability claim follows from these synthetic fixtures.

## Offline verification

```sh
bun test evals/portal
bunx tsc -p evals/portal/tsconfig.json
```

The normal offline suite includes protocol, reporting, CLI, and real-Chromium oracle tests. To check integration against your actual local simulator source without making model calls:

```sh
BAML_LOG=off bun evals/portal/fixtures/local-smoke.ts \
  /path/to/mysimchart .context
```

This optional test starts a separate UCSD instance on ephemeral ports with a **scripted actor**, and saves screenshots. It covers retrieval/extraction, interrupted-model handling, both write workflows, lost confirmations, and negative attempts (wrong recipient, required-field validation, and duplicate submission). The actual simulator's scorer must reject the negative attempts. The test never uses the running demo services, consumes Kaiser holdout data, or measures model accuracy.
