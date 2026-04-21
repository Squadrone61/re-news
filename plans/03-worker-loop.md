# Plan 3 — Worker Loop

**Goal**: The `worker` service embeds two loops: a cron scheduler (node-cron) that fires jobs on their configured schedules, and a 5s poll that picks up `queued` runs and executes them. No Redis, no BullMQ. A stub pipeline just flips `queued → running → success` so plans 4–5 can drop in the real pipeline later. Heartbeat + stale-run recovery on boot.

**Depends on**: 1, 2

## Scope

**In**
- `packages/worker/src/index.ts`: on boot → stale-run recovery → start cron registry → start poll loop → idle
- Cron registry: in-memory `Map<jobId, ScheduledTask>`; on every tick of an outer 60s interval, reconcile with DB (`jobs where enabled`). Add/remove/replace tasks whose schedule or enabled state changed.
- On a cron fire: insert `runs` row `{jobId, status:'queued', startedAt: null}`; update `jobs.lastRunAt` and `jobs.nextRunAt`
- Poll loop (every 5s): pick one `queued` run ordered by `createdAt ASC`; lock-and-flip to `running` via an atomic `updateMany({where:{id, status:'queued'}, data:{status:'running', startedAt: now}})` (returns count=0 if another process took it — safe but we're single-worker); then execute stub pipeline; then flip to `success` with `finishedAt: now`
- Heartbeat: `setInterval(updateRun(heartbeatAt: now), 30_000)` during execution; cleared on finally
- Stale recovery on boot: `running` runs whose `heartbeatAt < now - 5min` → reset to `queued`, `heartbeatAt: null`
- Stub pipeline: just logs `received run <id>` via `streamLogToDb(runId, 'sys', ...)` and sleeps 1s
- `shared/src/logger.ts`: `streamLogToDb(runId, stage, message, level?)` writes one `run_logs` row
- `shared/src/cron.ts`: helpers `validateCron`, `nextFireAt(cronExpr)` wrapping cron-parser
- `next_run_at` maintained: on job create/update (web-side) AND on every cron fire (worker-side)
- Graceful shutdown (SIGTERM/SIGINT): stop poll loop, stop cron registry, finish heartbeat, exit

**Out**
- Real pipeline (plans 4, 5), rate-limit handling / retries / budget (plan 7), hot-reload pubsub (not needed — 60s reconcile tick is enough)

## Tasks

1. Install `node-cron` and `cron-parser` in worker
2. `web` mutation handlers (plan 2) also compute and persist `nextRunAt` on create/update using `cron-parser`
3. `packages/worker/src/registry.ts`:
   - `register(job)`: `cron.schedule(job.schedule, () => onFire(job.id))`; store task in map
   - `unregister(jobId)`: stop task, delete from map
   - `reconcile()`: `prisma.job.findMany({where:{enabled:true}})`; for each job not in map or with changed schedule → `unregister` then `register`; for each registered id not in list → `unregister`
4. `packages/worker/src/onFire.ts`:
   - Re-read the job from DB (`findUnique`); bail if `!job.enabled` (race window between fire and disable)
   - Insert `runs` row `{jobId, status:'queued'}`; update `jobs.lastRunAt: now` and `jobs.nextRunAt: nextFireAt(job.schedule)`
   - Log to console (structured)
5. `packages/worker/src/poll.ts`:
   - Every 5s: `const run = await prisma.run.findFirst({where:{status:'queued'}, orderBy:{createdAt:'asc'}})`
   - If none → return
   - Atomic claim: `const claimed = await prisma.run.updateMany({where:{id: run.id, status:'queued'}, data:{status:'running', startedAt: new Date()}})`; if `claimed.count === 0` skip (someone else got it)
   - Start heartbeat interval (30s)
   - Try: `await stubPipeline(run.id)`; on resolve → `updateRun(status:'success', finishedAt: now)`; on throw → `updateRun(status:'failed', error: String(err), finishedAt: now)`
   - Finally: clear heartbeat
6. `packages/worker/src/pipeline.ts` (stub; replaced in plan 4):
   - `export async function stubPipeline(runId: string) { await streamLogToDb(runId, 'sys', 'received run ' + runId); await sleep(1000); }`
7. `packages/worker/src/index.ts`:
   - Log "worker booted"; verify `/root/.claude`
   - `await staleRecovery()`
   - `await registry.reconcile()` immediately; then `setInterval(reconcile, 60_000)`
   - Start poll loop (`setInterval(tick, 5_000)`); prevent overlap with an in-flight flag
   - Graceful shutdown handlers
8. Tests (Vitest, Testcontainers-node):
   - Cron `* * * * *` on an enabled job → a `runs` row appears within 70s; stub pipeline flips it to `success`
   - Manual Run Now (from plan 2) → picked up within 6s, terminal state `success`
   - Disable job → no new runs over 3 min
   - Change schedule via PUT → reconcile swaps the task; old minute no longer triggers
   - Simulated stale run (`update runs set status='running', heartbeat_at=now-10min`) → worker boot flips it back to `queued`, then drains to `success`
   - No double-claim: spawn two concurrent `poll.tick()` calls against one queued row → only one wins; `updateMany.count` sum = 1

## Acceptance criteria

- [x] Boot worker with 1 enabled job `cron="* * * * *"`; within 70s a `runs` row exists and reaches `success`
- [x] Toggle job off via API; over next 3 min no new runs
- [x] Change schedule via PUT; old schedule never fires again; new schedule drives subsequent fires
- [x] Delete job; registry unregisters within 60s
- [x] Manual Run Now inserts queued row; worker picks it up within 6s
- [x] Simulated stale `running` row (old heartbeat) is reset to `queued` on next worker boot and drains
- [x] Worker restart does not lose jobs — reconcile re-registers them all
- [x] No double-success: given a queued row, exactly one `run_logs[stage=sys] "received run …"` line is written

## Notes (shipped)

- node-cron v4 used (not v3). API: `cron.schedule(expr, fn)` returns a `ScheduledTask` with async `stop()`/`destroy()`. Registry wraps both on unregister.
- Reconcile compares `schedule` strings and treats any change as unregister-then-register (cheap at this scale).
- Poll uses an in-flight flag so overlapping 5s ticks can't stack while a run is executing. Combined with atomic `updateMany({where:{id, status:'queued'}})` this gives single-worker exactly-once semantics.
- Stale recovery also re-queues rows with `heartbeatAt IS NULL` and `status='running'` (covers crash-before-first-heartbeat). `startedAt` is cleared on re-queue so the eventual success row reflects the successful attempt's timing.

## Verification

```bash
BASE=http://localhost:3100

# Minutely job (login as admin first — reuse cookies from plan 2)
ID=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs -H 'content-type: application/json' -d '{
  "name":"Minutely","enabled":true,"schedule":"* * * * *",
  "sources":[{"url":"https://example.com"}],
  "topic":"t","basePrompt":"t","recipientEmail":"admin@example.com","outputFormat":"markdown","maxItems":1,
  "modelResearch":"claude-sonnet-4-6","modelSummary":"claude-haiku-4-5","monthlyBudget":999
}' | jq -r .id)

sleep 75
docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select count(*) from runs where job_id='$ID' and status='success'"  # >=1

# Disable; verify no new runs
curl -s -b /tmp/cj -X PUT $BASE/api/jobs/$ID -H 'content-type: application/json' -d '{"enabled":false}'
BEFORE=$(docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select count(*) from runs where job_id='$ID'" | tr -d ' ')
sleep 180
AFTER=$(docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select count(*) from runs where job_id='$ID'" | tr -d ' ')
[ "$BEFORE" = "$AFTER" ] && echo "NO LEAK"

# Stale recovery
curl -s -b /tmp/cj -X PUT $BASE/api/jobs/$ID -H 'content-type: application/json' -d '{"enabled":true}'
RUN=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs/$ID/run | jq -r .runId)
docker compose -p re-news exec db psql -U newsletter -d newsletter -c \
  "update runs set status='running', heartbeat_at=now()-interval '10 minutes' where id='$RUN'"
docker restart renews_worker
sleep 30
docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select status from runs where id='$RUN'"  # success (after re-claim)

pnpm test
```

## Notes / gotchas

- **60s reconcile tick** replaces Redis pubsub. A schedule change is picked up within ≤60s; acceptable at this scale.
- **Concurrency is always 1.** Rate limits enforce this more than our code does. The atomic `updateMany` pattern is still correct future-proofing.
- **Reconcile compares schedule strings**, not task identity. If user changes cron expression, we unregister+register. Cheap.
- **`node-cron` uses server local time** — confirm `date` on the host before declaring done.
- **No double-fire**: `node-cron` fires exactly once per minute per task; the fire handler re-reads `enabled` before inserting.
- **Poll loop is a failsafe and a manual-run pickup** — even if cron somehow doesn't enqueue, the poll would spin finding nothing. Cheap.
- **Shared logger** now writes real rows. Plan 4 will stream SDK messages through it.
