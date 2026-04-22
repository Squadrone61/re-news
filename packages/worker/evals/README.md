# Summary-stage evals

Lightweight harness for iterating on `packages/worker/src/prompts/summary.ts` without waiting for a prod run.

## What it does

For each fixture in `fixtures/*.json`:

1. Loads the `(job, research)` pair.
2. Calls `attemptSummary` (exported from `pipeline/summarize.ts`) — the real SDK call, real prompt, real model, no DB.
3. On first-attempt failure, re-runs with `buildRetryPrompt(reason)` — mirroring prod.
4. Checks the parsed `StageTwo` against the fixture's `assertions`.

Only the summary stage is evaluated. Research is skipped — it would require mocking `WebFetch`/`Bash`, which isn't worth the setup for family-scale.

## Running

```
pnpm --filter @renews/worker eval:summary
```

Requires the admin's `~/.claude` to be present (same subscription auth as the worker). Each fixture makes one SDK call, so a full run hits the shared rate-limit window — keep the fixture count small.

## Assertion options

| Key | Meaning |
|---|---|
| `subjectMaxLen` | override default 70 |
| `itemsMax` | upper bound on `items.length` (usually `job.maxItems` or tighter for merge tests) |
| `language` | one of `tr`/`en`/`de`/`fr`/`es` — stopword heuristic, not a full classifier |
| `allowedCategories` | `item.category` must be in this set |
| `requireCategoryOnEveryItem` | every item must have a `category` field |
| `allowEmpty` | `items: []` is acceptable if `empty_reason` is present |
| `minBodyWords` / `maxBodyWords` | per-item body length bounds |

## Adding a fixture

1. Copy an existing file in `fixtures/`.
2. Edit `job.basePrompt`, `job.maxItems`, `research.items`, and `assertions`.
3. Keep fixtures focused on one behavior (language, categories, merge, empty, overflow). Mixing too many concerns in one fixture makes failures hard to attribute.

## Interpreting results

- `PASS` — shape + lengths + fixture assertions all good.
- `FAIL` — SDK returned valid JSON but assertions didn't hold. Usually a prompt tuning issue.
- `ERROR` — threw before we could assert (invalid JSON, schema mismatch, SDK failure, retry exhausted).
