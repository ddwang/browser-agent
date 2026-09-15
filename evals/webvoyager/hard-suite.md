# Hard browser suite

`baseline.json` contains 12 custom tasks, with four tasks each on arXiv, Hugging
Face, and GitHub. These replace the old main suite, not the checked-in WebVoyager
catalog. The old 20 tasks remain in `smoke.json` with their original IDs.

The aim is deeper browser work within the existing 100-action and 24-MiB budgets,
not longer runs for their own sake. Every task has explicit acceptance criteria
shared by the actor and judge. Criteria that require a UI transition must be
supported by the action/screenshot history, not merely asserted in the answer.

## Coverage

| Task ID | What it tests | Important failure to catch |
| --- | --- | --- |
| `ArXiv Hard--0` | Abstract/date search plus author threshold | Using the wrong search field or date mode; missing excluded results |
| `ArXiv Hard--1` | Change one filter and compare complete sets | Equal counts incorrectly treated as identical results |
| `ArXiv Hard--2` | Three-paper metadata comparison | Mixing original and revised dates or author roles |
| `ArXiv Hard--3` | Complete version-history extraction | Missing intermediate versions; counting v1 as a revision |
| `Huggingface Hard--0` | Three-model constraint comparison | Confusing embedding size with input length; selecting a partial match |
| `Huggingface Hard--1` | Model-card and configuration-file audit | Copying one model's settings to another; missing pooling flags |
| `Huggingface Hard--2` | Train → validation → train | Reusing rows from the wrong split; reporting rounded counts |
| `Huggingface Hard--3` | Ten-row extraction across pagination | Missing or duplicating boundary rows |
| `GitHub Hard--0` | Release → issue → implementation PR | Calling the issue referenced in a release a merged PR |
| `GitHub Hard--1` | Two releases and three linked PRs | Combining distinct bugs or confusing renamed/deprecated methods |
| `GitHub Hard--2` | Complete milestone inventory | Treating every closed PR as merged; totals that do not reconcile |
| `GitHub Hard--3` | Switch tags while retaining the file path | Reading main; confusing runtime dependencies with optional/build dependencies |

`summary.json` and `stats` report results by site and capability. Capability tags
overlap; they are diagnostic breakdowns, not independent samples or additive scores.

## Reference checks

The following maintainer checks were made on **2026-09-15** using public source
pages and selected real-Chromium interactions. They establish concrete targets
and reference answers, not an actor completion rate. This document is not loaded
into either model's prompt. Judge the evidence from the actual run if live data
changes; do not silently force an old reference count.

### arXiv

- **Hard--0:** The configured [Abstract search](https://arxiv.org/search/advanced?advanced=&terms-0-operator=AND&terms-0-term=graph+neural+networks&terms-0-field=abstract&classification-include_cross_list=include&date-filter_by=date_range&date-from_date=2024-01-01&date-to_date=2024-01-03&date-date_type=submitted_date&abstracts=show&size=50&order=-announced_date_first)
  returned five IDs, with author counts: `2401.01384` (2), `2401.00755` (7),
  `2312.09086` (3), `2310.19274` (5), and `2304.14274` (9). The two qualifying
  records are `2401.00755` and `2304.14274`.
- **Hard--1:** The corresponding [Title search](https://arxiv.org/search/advanced?advanced=&terms-0-operator=AND&terms-0-term=graph+neural+networks&terms-0-field=title&classification-include_cross_list=include&date-filter_by=date_range&date-from_date=2024-01-01&date-to_date=2024-01-03&date-date_type=submitted_date&abstracts=show&size=50&order=-announced_date_first)
  also returned five results. `2401.01232` was Title-only; `2312.09086` was
  Abstract-only. The other four IDs were shared. Both result sets were checked
  in Chromium. This date mode intentionally includes revisions of older papers.
- **Hard--2:** [Attention](https://arxiv.org/abs/1706.03762) has eight authors,
  from Ashish Vaswani to Illia Polosukhin, v1 `2017-06-12`, and pre-2024 latest
  v7 `2023-08-02`. [BERT](https://arxiv.org/abs/1810.04805) has four authors,
  from Jacob Devlin to Kristina Toutanova, v1 `2018-10-11`, and v2 `2019-05-24`.
  [RAG](https://arxiv.org/abs/2005.11401) has twelve authors, from Patrick Lewis
  to Douwe Kiela, v1 `2020-05-22`, and v4 `2021-04-12`. Their primary category is
  `cs.CL`. RAG has the most authors.
- **Hard--3:** Attention's v1–v7 dates are `2017-06-12`, `2017-06-19`,
  `2017-06-20`, `2017-06-30`, `2017-12-06`, `2023-07-24`, `2023-08-02`:
  seven versions, six revisions, revision years 2017 and 2023. RAG's v1–v4 dates
  are `2020-05-22`, `2020-12-07`, `2021-03-29`, `2021-04-12`: four versions,
  three revisions, revision years 2020 and 2021. Sources are the same two
  abstract pages' submission histories.

### Hugging Face

- **Hard--0:** [MiniLM](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
  declares Apache-2.0, 384 dimensions, and a 256-word-piece default limit.
  [MPNet](https://huggingface.co/sentence-transformers/all-mpnet-base-v2) declares
  Apache-2.0, 768 dimensions, and 384 word pieces.
  [E5-small-v2](https://huggingface.co/intfloat/e5-small-v2) declares MIT,
  384 dimensions, and 512 tokens; it is the sole qualifying candidate. Its
  retrieval instructions distinguish `query: ` and `passage: ` prefixes.
- **Hard--1:** Chromium showed `max_seq_length` 256 in
  [MiniLM's sentence config](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/main/sentence_bert_config.json)
  and 384 in [MPNet's](https://huggingface.co/sentence-transformers/all-mpnet-base-v2/blob/main/sentence_bert_config.json).
  Their [MiniLM pooling](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/main/1_Pooling/config.json)
  and [MPNet pooling](https://huggingface.co/sentence-transformers/all-mpnet-base-v2/blob/main/1_Pooling/config.json)
  files declare dimensions 384 and 768 respectively. Both enable mean-token
  pooling and disable CLS, max-token, and mean-square-root-length pooling.
- **Hard--2:** The [dataset card](https://huggingface.co/datasets/stanfordnlp/sst2)
  gives train 67,349 and validation 872 rows. Columns are `idx`, `sentence`,
  and `label`; labels map 0 to negative and 1 to positive. In Chromium,
  [train](https://huggingface.co/datasets/stanfordnlp/sst2/viewer/default/train)
  rows 0/1 were 0/0, and [validation](https://huggingface.co/datasets/stanfordnlp/sst2/viewer/default/validation)
  rows 0/1 were 1/0. The split selector supports the requested round trip.
- **Hard--3:** Train indices 95–104 had numeric labels
  `1, 0, 1, 1, 1, 1, 1, 0, 1, 0`: seven positive and three negative.
  The first preview ends at 99; its Next link opens
  [the page starting at 100](https://huggingface.co/datasets/stanfordnlp/sst2/viewer/default/train?p=1).
  These rows were read in Chromium. The actor must use the viewer, not its SQL console.

### GitHub

- **Hard--0:** The [Flask 3.1.0 release](https://github.com/pallets/flask/releases/tag/3.1.0)
  maps `SESSION_COOKIE_PARTITIONED` to [issue 5472](https://github.com/pallets/flask/issues/5472),
  implemented by [merged PR 5499](https://github.com/pallets/flask/pull/5499).
  `SECRET_KEY_FALLBACKS` maps to [issue 5621](https://github.com/pallets/flask/issues/5621),
  implemented by [merged PR 5632](https://github.com/pallets/flask/pull/5632).
- **Hard--1:** [Requests v2.32.2](https://github.com/psf/requests/releases/tag/v2.32.2)
  is dated `2024-05-21`: `_get_connection` was renamed to
  `get_connection_with_tls_context`; the separate `get_connection` method was
  deprecated. The linked migration is [PR 6710](https://github.com/psf/requests/pull/6710).
  [v2.32.3](https://github.com/psf/requests/releases/tag/v2.32.3), `2024-05-29`,
  links the custom SSLContext fix to [PR 6716](https://github.com/psf/requests/pull/6716)
  and the missing ssl-module fix to [PR 6724](https://github.com/psf/requests/pull/6724).
- **Hard--2:** The [Flask 3.1.0 milestone](https://github.com/pallets/flask/milestone/33?closed=1)
  closed `2024-11-13`, with zero open and 23 closed items. Merged PRs:
  5496, 5499, 5526, 5620, 5623, 5624, 5626, 5630, 5632, 5633, 5634, 5637,
  5638, 5640. Unmerged closed PR: 5550. Closed issues: 5472, 5504, 5549,
  5553, 5621, 5625, 5628, 5636. Group totals: 14 + 1 + 8 = 23.
- **Hard--3:** The [2.3.3 file](https://github.com/pallets/flask/blob/2.3.3/pyproject.toml)
  requires Python >=3.8, versus >=3.9 in the
  [3.1.0 file](https://github.com/pallets/flask/blob/3.1.0/pyproject.toml).
  Changed minimums: Werkzeug 2.3.7→3.1, itsdangerous 2.1.2→2.2,
  blinker 1.6.2→1.9. Jinja2>=3.1.2 and click>=8.1.3 remain unchanged.
  importlib-metadata is spelled >=3.6.0 then >=3.6, with the same
  `python_version < '3.10'` marker: an equivalent constraint, not a raised floor.
  No direct dependency was added or removed.

## Scope and remaining validation

This is a research-workflow suite, with deliberate near-miss and completeness
checks. It does not cover purchases, authenticated business apps, booking forms,
or every website layout. Several tasks share source material to isolate different
failure modes; the twelve outcomes are not twelve independent domain samples.

Live pages, repository metadata, and search indexing can change. A fixed date
range on the most recent submission date is not an immutable result set. Some
GitHub requests may still be rate-limited. Review recorded HTTP diagnostics and
blocked outcomes separately, while retaining them in the completion denominator.
There are no intentional paywall or rate-limit tasks in this main suite.

Controlled Escape, cooldown, subscription, and repeated-action fixtures remain
in `browser-recovery.test.ts`. Those are scripted implementation tests and do not
measure model recovery decisions. Do not merge their passes into this score.

No full actor/judge benchmark has been run on these new tasks yet. Their added
requirements make them stronger tests by construction; empirical difficulty,
completion rate, and typical action/payload usage still need a first baseline.
