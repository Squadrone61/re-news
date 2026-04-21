# Plan 7 — Hardening

**Goal**: The pipeline survives rate limits, worker crashes, runaway runs, and budget overruns. No retry storms. No silent drops. Operational behaviour under stress matches spec §8.

**Depends on**: 5 (6 not strictly required but nice)

## Scope

**In**
- Rate-limit handling: SDK rate-limit errors → status `deferred`, `nextRunAt = window_reset_time`, no retry loop
- Generic failure retry: 2 retries with exponential backoff (1m, 5m) for non-rate-limit errors; then `failed` + failure-notice email
- Monthly budget check: before inserting a new `runs` row (both cron path and manual Run Now), count runs for this job in current server-local month; if ≥ `monthlyBudget`, insert row with `status=deferred`, `error="monthly budget exceeded"`, do not start the pipeline
- Per-job min interval: `jobs.minIntervalMinutes` — if a cron fire (or manual Run Now) happens within `minIntervalMinutes` of `lastRunAt`, skip entirely (no row)
- Post-parse research caps (defense-in-depth): after parsing `research.json`, slice `items` to 25 and truncate each `content` to 800 chars. Log a `sys` warning if truncation occurred
- Failure-notice email: on terminal `failed`, send a one-line email via the same Gmail transport to the job's owner user email; if the email _send_ itself is failing, log-only (don't recurse)
- `heartbeatAt` + stale recovery were already implemented in plan 3 — this plan verifies they hold under the new retry machinery

**Out**
- Automated re-enqueue of `deferred` runs when window resets (manual Run Now is fine for v1)
- UI surfacing of `deferred` beyond what's already in place (polish in plan 8)

## Tasks

1. `jobs.minIntervalMinutes` column already in the schema (plan 1); just wire it into the pre-run checks
2. Rate-limit detection in the worker poll loop's catch:
   - Match SDK error type or error message / code against known rate-limit signatures
   - On match: parse reset time from error (header or message — SDK varies); set `status='deferred'`, `nextRunAt = resetTime`, `error='rate_limit: window resets at <iso>'`, `finishedAt=now`
   - Do **not** bump retry counter; do not re-enqueue
3. Generic failure retry:
   - Add `runs.attempt int default 0` column (migration)
   - On non-rate-limit throw: if `run.attempt < 2` → `update run set attempt=attempt+1, status='queued', startedAt=null, heartbeatAt=null`; poll loop picks it up after a backoff delay (1m on attempt=1→2, 5m on attempt=2→3). Implement delay by stamping `nextRunAt = now + backoff` and filtering in the poll query: `where status='queued' and (nextRunAt is null or nextRunAt <= now)`
   - On 3rd failure (`attempt >= 2`): set `status='failed'`, `error=<msg>`, `finishedAt=now`; fire failure-notice email
4. Pre-insert checks (both in worker cron path AND `POST /api/jobs/:id/run`):
   - **Min interval**: `if (job.lastRunAt && now - job.lastRunAt < minIntervalMinutes * 60_000) → skip (no row, log line)`
   - **Budget**: `const count = prisma.run.count({where:{jobId: job.id, startedAt:{gte: startOfMonthLocal}}}); if (count >= job.monthlyBudget) → insert row with status='deferred', error='monthly budget exceeded'`
   - Budget uses server-local month boundaries (consistent with cron)
5. Post-parse research caps in `pipeline/research.ts`:
   ```ts
   if ((parsed.items ?? []).length > 25) {
     parsed.items = parsed.items.slice(0, 25);
     await streamLogToDb(runId, 'sys', 'truncated items to 25 (prompt cap violated)', 'warn');
   }
   for (const it of parsed.items) {
     if ((it.content ?? '').length > 800) {
       it.content = it.content.slice(0, 800);
       await streamLogToDb(runId, 'sys', `truncated content for ${it.url} to 800 chars`, 'warn');
     }
   }
   ```
6. Failure-notice email (`pipeline/failureNotice.ts`):
   - Load owning user via `run.job.user`; subject `"[re-news] Job failed: <job name>"`; body: one line `"${job.name} failed at ${isoTime}: ${error}. See $BASE_URL/runs/<runId>"`
   - Reuse `email.ts` transport; on send error, just log — never recurse
7. Smoke tests (Vitest): induce each mode and assert DB state

## Acceptance criteria

- [x] Simulated rate-limit (test-only env `SIM_RATE_LIMIT=1` causing research.ts to throw a RateLimitError with reset=now+3600s) → run is `deferred`, `nextRunAt` populated, no retries
- [x] Simulated generic throw → 2 retries with backoff (rows show 3 total attempts); on 3rd failure, status `failed`, failure-notice email sent
- [x] `docker kill renews_worker` mid-run → on restart, stale `running` row → `queued`; pipeline resumes cleanly (Stage 1 recomputes from scratch — intentional)
- [x] `monthlyBudget: 1` — second cron fire of the month inserts a `deferred` row with `error="monthly budget exceeded"`; pipeline never runs
- [x] `minIntervalMinutes: 10` + `cron "* * * * *"` — only one run per 10 min; interim ticks produce no rows at all
- [x] Research output with 50 items → post-parse truncated to 25, warning log line present

## Verification

```bash
BASE=http://localhost:3100

# Rate-limit sim
docker compose -p re-news exec -e SIM_RATE_LIMIT=1 worker sh -c "restart worker or inject in test mode"
# (practical: set SIM_RATE_LIMIT=1 in compose env, restart worker, trigger a run)
RUN=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs/$ID/run | jq -r .runId)
sleep 30
docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select status, error, next_run_at from runs where id='$RUN'"
# Expect: deferred, rate_limit:..., next_run_at populated

# Stale recovery
# Unset SIM_RATE_LIMIT, restart
RUN=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs/$ID/run | jq -r .runId)
sleep 30
docker kill renews_worker && sleep 10 && docker compose -p re-news up -d worker
sleep 60
docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select status from runs where id='$RUN'"

# Monthly budget
curl -s -b /tmp/cj -X PUT $BASE/api/jobs/$ID -H 'content-type: application/json' -d '{"monthlyBudget":1}'
curl -s -b /tmp/cj -X POST $BASE/api/jobs/$ID/run
curl -s -b /tmp/cj -X POST $BASE/api/jobs/$ID/run
docker compose -p re-news exec db psql -U newsletter -d newsletter -c \
  "select status, error from runs where job_id='$ID' order by created_at desc limit 2"
# Second row: deferred + monthly budget exceeded

# Min interval
curl -s -b /tmp/cj -X PUT $BASE/api/jobs/$ID -H 'content-type: application/json' \
  -d '{"monthlyBudget":999,"minIntervalMinutes":10,"schedule":"* * * * *","enabled":true}'
sleep 180
docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select count(*) from runs where job_id='$ID' and created_at > now() - interval '3 minutes'"
# Expect at most 1

pnpm test
```

## Notes (shipped)

- `runs.attempt` and `jobs.minIntervalMinutes` columns were already present from plan 1; no new migration needed
- `RateLimitError` + `detectRateLimit(err)` live in `packages/worker/src/pipeline/errors.ts`. `research.ts` honors `SIM_RATE_LIMIT=1` (test hook) and wraps the SDK `query()` iteration in a try/catch that routes any throw through `detectRateLimit` before rethrowing — so an SDK-raised 429 becomes a `RateLimitError` instead of a generic failure
- Poll `tick()` filters on `nextRunAt` (`null OR <= now`); `handleFailure` is the single catch site; rate-limit → `deferred` (no attempt bump); generic → `attempt++` requeue with `nextRunAt = now + backoff[attempt]`; terminal → `failed` + `sendFailureNotice(runId)`
- `@renews/shared/preflight` exports `preflightJob(job, now)` used by `onFire` AND `/api/jobs/:id/run`. Skip = no row. Defer = insert a `deferred` row with `error=reason`. Monthly-budget window uses `createdAt >= startOfMonthLocal(now)` (server local time). Manual-run API returns 429 on skip; defer returns `{runId, status:'deferred', reason}`
- Rerun endpoints (`/rerun-full`, `/rerun-stage2`) intentionally bypass preflight — explicit operator overrides from the UI
- Failure-notice email via `pipeline/failureNotice.ts` — same Gmail transport as `email.ts`, reads Setting each call, swallows all errors (logs `sys` warn line)
- Post-parse research caps now emit `sys` warn log lines when they truncate (items > 25 or content > 800)
- Integration tests cover: rate-limit deferred (no retry), generic 3-attempt fail path, min-interval skip, monthly-budget defer row, truncation warn logs

## Notes / gotchas

- **Rate-limit retry loop is the footgun** — never use the generic retry path for rate-limit errors. Detect → `deferred`, skip retry increment
- **Stale recovery is idempotent by design**: Stage 1 recomputes fine (re-scrapes); Stage 2 is a pure transform. If a worker dies mid-email, resend will duplicate the email. Accept the duplicate for v1 — better than a dropped email
- **Failure-notice email**: uses the same Gmail transport. If the email send itself is what's failing, log-only (don't recurse)
- **Month boundary for budget**: "current month" uses server local time (same as cron). Consistent with spec
- **Budget check must happen in both paths** (worker cron + manual Run Now) — tested
- **Retry backoff via `nextRunAt` on the same row** keeps things simple: no separate delay queue, poll just respects the gate
- **`attempt` column** is useful for debugging and could drive the UI to show "retry 2/2" — defer the UI bit to plan 8 if wanted
