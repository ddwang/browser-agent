# Native structured-output experiment

## Hypothesis fixed before evaluation

Provider-enforced JSON schemas should remove prose/XML output failures without
adding task-specific reasoning hints. This tests a protocol mechanism, not better
knowledge of the development task answers. The cross-site holdout was frozen in
commit `e81b521` before this implementation, and has not been run.

## Implementation

- Reuse the action definitions for both BAML's prompt and the native JSON schema.
- Use `output_config.format` for known supporting direct Anthropic models, including
  the configured Haiku actor and Sonnet 5 judge. Keep an explicit opt-out and the
  existing path for other providers, older models, and unsupported schema shapes.
- Keep original Zod validation. Schema conversion does not silently close arbitrary
  maps or truncate recursive types. Unsupported value constraints remain described
  to the model and validated locally.
- Keep invocation-local usage, including failures and retries. Per-call client
  registries isolate different concurrent output schemas.
- Fail on provider refusal or output-token exhaustion, even if the parser can
  recover an object. Do not execute a partial batch, retry a refusal, or raise limits.

No browser-task text, acceptance criteria, site-specific instructions, model IDs,
temperatures, action limits, payload limits, or judge rubric changed. The judge's
output format is now provider-enforced; the numeric judge version remains unchanged
as requested. Compare source hashes, not just the numeric version.

References: [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
and [BAML provider option pass-through](https://docs.boundaryml.com/ref/llm-client-providers/anthropic).
The project retains BAML 0.202 and Zod 3; no SDK or dependency upgrade was needed.

## Independent checks

276 offline tests pass, including 64 generated action/schema variants, full browser
action-vocabulary conversion, reused definitions, unsupported shapes, local value
constraints, usage on failed responses, concurrent schema isolation, and terminal
refusal/truncation behavior. Core build and both type checks pass.

Live synthetic API probes, unrelated to browser tasks:

- Random token extraction with Haiku and Sonnet 5: passed.
- Random action name with one-action vocabulary: passed without a format retry.
- Full browser vocabulary plus random record action: valid JSON, but the first
  probe's single-action assertion failed because its wording requested waiting and
  the model added a valid wait action. This was not a format failure or a browser
  benchmark attempt. The diagnostic is preserved in `.context`.
- Clarified synthetic one-action request with full vocabulary: all three checks
  passed. Only probe wording changed; agent prompts and benchmark criteria did not.

Probe artifacts are in `.context/structured-output-*.json`. The initial failed
probe did not persist usage on failure; that diagnostic limitation was fixed, and
its small unrecorded cost must not be represented as zero.

## Browser evaluation

Pending: run the complete development suite once in a new directory. Preserve all
outcomes, and do not modify the candidate mid-run. Only after development and
independent checks finish should the committed candidate see the frozen holdout.
