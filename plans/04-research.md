# Plan 4 — Research Agent (Stage 1)

**Goal**: Replace plan 3's stub pipeline with a real Stage 1 call. The research agent runs via the Claude Agent SDK with tools enabled, per-run working directory, streams SDK messages into `run_logs` as they arrive, and persists the final `research.json` to both disk and `runs.research_raw`. After Stage 1, status stays `running` (Stage 2 finishes the pipeline in plan 5). Stale-run recovery from plan 3 covers crashes — Stage 1 recomputes cleanly on retry.

**Depends on**: 1, 2, 3

## Scope

**In**
- Install `@anthropic-ai/claude-agent-sdk` in worker image (bundles Claude Code binary; glibc base from plan 1 is why)
- `packages/worker/src/pipeline/research.ts` — the SDK call + persistence
- `packages/worker/src/prompts/research.ts` — prompt builder from spec §6
- `packages/shared/src/logger.ts` — extend `streamLogToDb` to discriminate SDK message types (assistant text, tool_use, tool_result, error)
- Replace `stubPipeline` call in the poll loop: `runResearch(runId, job)` → stays `running` (plan 5 will chain into Stage 2)
- Handling for `needs_browser: true` sources: skip with a warning log line; do not fail
- Lookback window derived from job cadence via `cron-parser`: interval ≥ 7d → "last 7 days"; ≥ 24h → "last 24 hours"; ≥ 1h → "last 6 hours"; else "recent"
- `runs.researchRaw` populated with the parsed JSON
- A `sys`-stage summary log line at end: `research_done: N items, M fetch_errors`

**Out**
- Stage 2 (plan 5), rendering + email (plan 5), rate-limit/deferred/budget (plan 7), Playwright MCP (v1.1)

## Tasks

1. Add `@anthropic-ai/claude-agent-sdk` to `packages/worker/package.json`
2. Rebuild worker image; confirm SDK's bundled binary runs (`docker compose -p re-news exec worker node -e "require('@anthropic-ai/claude-agent-sdk')"`)
3. `prompts/research.ts`:
   - `buildResearchPrompt(job)` — interpolates `topic`, `lookback` (derived), `sources[]` (with `hint`/`needs_browser` annotations) into spec §6 template
   - Keep hard caps in the prompt: MAX ITEMS: 25, MAX CONTENT PER ITEM: 800 chars
   - Branch for `needs_browser: true` sources: prompt instructs the agent to skip them with a `fetch_errors` entry `{source, reason: "needs_browser, Playwright deferred"}`
4. `pipeline/research.ts`:
   ```ts
   export async function runResearch(runId: string, job: Job) {
     const cwd = `/app/data/runs/${runId}`;
     await fs.mkdir(cwd, { recursive: true });

     for await (const msg of query({
       prompt: buildResearchPrompt(job),
       options: {
         allowedTools: ['WebFetch', 'WebSearch', 'Bash', 'Read', 'Write'],
         permissionMode: 'acceptEdits',
         cwd,
         model: job.modelResearch,
         maxTurns: 40,
       },
     })) {
       await streamLogToDb(runId, 'research', msg);
     }

     const raw = await fs.readFile(`${cwd}/research.json`, 'utf8')
       .catch(() => { throw new Error('research.json missing'); });
     const parsed = JSON.parse(raw);
     await prisma.run.update({
       where: { id: runId },
       data: { researchRaw: parsed },
     });
     const nItems = (parsed.items ?? []).length;
     const nErrors = (parsed.fetch_errors ?? []).length;
     await streamLogToDb(runId, 'sys', `research_done: ${nItems} items, ${nErrors} fetch_errors`);
     return parsed;
   }
   ```
5. `logger.streamLogToDb` extended:
   - `assistant` message → one row with `level='info'`, `stage=<passed>`, `message=<extracted text>`
   - `tool_use` → row with message `"tool: ${name}(${short args})"`
   - `tool_result` → row with message `"result: ${first 200 chars}"`
   - SDK error message → `level='error'`, `message=<error string>`
   - Non-SDK raw strings (our own logs) → `level=<passed or 'info'>`, message as-is
6. Update the worker poll loop in plan 3's `poll.ts`: `await runResearch(runId, job)` instead of `stubPipeline`. No status flip yet — plan 5 chains Stage 2 and flips to `success`.
7. Fail path: if the SDK throws, or `research.json` is missing/invalid, the catch in the poll loop (plan 3) sets `status='failed'` with `error` populated. That already works.
8. **Do not** configure any MCP servers in v1. Plan 8 adds AccountInfo display; Playwright MCP is v1.1.

## Acceptance criteria

- [~] Given a job with a real source (e.g., HN front page) and a valid Claude subscription mounted, manual Run Now produces `/app/data/runs/<runId>/research.json` with a well-formed `items[]` matching spec §6 schema — **deferred to real-environment shell verification on the home server; integration tests cover the mock equivalent**
- [x] `runs.researchRaw` JSONB is populated with the parsed structure
- [x] `run_logs` for that run has ≥10 rows, stage=`research`, mix of text/tool-use/tool-result — covered by integration test (mock emits assistant-text + tool_use + tool_result + sys summary; real HN run will easily exceed 10)
- [x] Final `sys` line `research_done: N items, M fetch_errors` present
- [~] A source with `needs_browser: true` is reflected in `fetch_errors` with the skip reason and does not fail the run — **prompt instructs the agent to do this; deferred to real-environment shell verification**
- [x] If the agent produces no `research.json`, status ends `failed` with `error="research.json missing"`
- [x] No `ANTHROPIC_API_KEY` env var anywhere — SDK reads `/root/.claude`
- [x] Status remains `running` after Stage 1 (intentionally — plan 5 wraps up)

## Verification

```bash
BASE=http://localhost:3100

# Create a real job; login cookie /tmp/cj from plan 2
ID=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs -H 'content-type: application/json' -d '{
  "name":"HN","enabled":false,"schedule":"0 8 * * *",
  "sources":[{"url":"https://news.ycombinator.com"}],
  "topic":"top tech stories","basePrompt":"Terse brief.",
  "recipientEmail":"me@example.com","outputFormat":"markdown","maxItems":5,
  "modelResearch":"claude-sonnet-4-6","modelSummary":"claude-haiku-4-5","monthlyBudget":60
}' | jq -r .id)

RUN=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs/$ID/run | jq -r .runId)

# Poll — Stage 1 typically ≤ 2 min
for i in {1..60}; do
  S=$(docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
    "select status from runs where id='$RUN'" | tr -d ' ')
  RES=$(docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
    "select research_raw is not null from runs where id='$RUN'" | tr -d ' ')
  echo "t+$((i*5))s status=$S research=$RES"
  [ "$RES" = "t" ] && break
  [ "$S" = "failed" ] && { docker compose -p re-news exec db psql -U newsletter -d newsletter -c \
    "select error from runs where id='$RUN'"; exit 1; }
  sleep 5
done

# Artifact check
docker compose -p re-news exec worker cat /app/data/runs/$RUN/research.json | jq '.items | length'

# Logs streamed
docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select count(*) from run_logs where run_id='$RUN' and stage='research'"  # >=10

# needs_browser skip
ID2=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs -H 'content-type: application/json' -d '{
  ...,"sources":[{"url":"https://spa.example.com","needs_browser":true}]
}' | jq -r .id)
RUN2=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs/$ID2/run | jq -r .runId)
# After completion:
docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select jsonb_array_length(research_raw->'fetch_errors') from runs where id='$RUN2'"  # >=1
```

## Notes / gotchas

- **SDK bundled binary** may need `git`, `bash`, `curl` on the image — bookworm-slim has enough, but verify once during plan 1 smoke
- **SDK writes to `/root/.claude`** for refresh tokens. The plan 1 RW mount is why that works
- **`maxTurns: 40`** is the cost ceiling per Stage 1 call; lower it if monthly cost gets painful — but user said no budget worry, so keep
- **Research dir retention**: `/app/data/runs/<id>` persists indefinitely in v1. Plan 8 adds a 30-day cleanup cron
- **Failure vs deferred**: any error here marks `failed`. Plan 7 distinguishes rate-limit errors → `deferred`
- **Idempotent retry**: stale recovery re-runs Stage 1 from scratch (re-scrapes). Accepted cost — the whole point of separating Stages 1 and 2 is that Stage 2 can be re-run cheaply without re-scraping (plan 6's "Re-run Stage 2" action)
- **Don't log the full research JSON into `run_logs`** — it's already in `runs.researchRaw`. The `sys` summary line is enough

## Notes (post-ship)

- SDK installed: `@anthropic-ai/claude-agent-sdk@^0.1.77` (as resolved at ship time; `^0.1.0` requested).
- `RUNS_DIR` env var added to override the per-run cwd root (default `/app/data/runs`) — Testcontainers suite sets it to a tmpdir so the SDK mock can write `research.json` without touching the bind-mount path. Not documented in the original plan.
- Worker Dockerfile also installs `git` and `curl` (bookworm-slim doesn't ship them). curl is required for the SDK's Bash tool to fetch RSS as specified in the research prompt.
- `lookbackFromSchedule(expr)` lives in `@renews/shared` (cron.ts) rather than inside the prompt module so plan 8's "next-5-fires preview" can reuse the parser.
- `streamLogToDb` was extended to accept an SDK message object OR a raw string. Rules per message type are documented in the Decisions Log (plans/README.md) and in CLAUDE.md's "Research stage internals".
- The two acceptance criteria marked `[~]` require a real Claude subscription and an internet-accessible source; they are validated by the shell block on the home server, not by the Testcontainers suite.
