# Plan 6 — Run Detail UI

**Goal**: `/runs/:id` page with header (job name, status, timing), live-tailing log panel grouped by stage, collapsible raw research JSON, rendered newsletter preview (sandboxed iframe for HTML), and three actions: **Resend email**, **Re-run Stage 2 only**, **Re-run full**. Runs list page `/runs` paginated, user-scoped. All endpoints ownership-gated.

**Depends on**: 5

## Scope

**In**
- `GET /api/runs` — paginated latest N, user-scoped via `run.job.userId = currentUser.id` (admin sees all)
- `GET /api/runs/:id` — ownership-gated 404 if caller doesn't own the parent job
- `GET /api/runs/:id/logs/stream` — SSE endpoint that tails `run_logs` by polling the DB every 1s for rows > last_seen_id; emits `event: log` per row and `event: status` on status transitions
- `POST /api/runs/:id/resend` — ownership-gated; re-sends the existing `renderedOutput` via Nodemailer; logs a `sys` line `"resent by user"` under the same run (no new run row)
- `POST /api/runs/:id/rerun-stage2` — ownership-gated; requires `researchRaw IS NOT NULL`; creates a **new** `runs` row linked to the same job; copies `researchRaw`; enqueues with a skip-research flag
- `POST /api/runs/:id/rerun-full` — ownership-gated; inserts a fresh queued run (same path as Run Now)
- `/runs/[id]` page: server-render header from current state; client opens `EventSource(...)` and appends lines; stages collapsible (`research`/`summary`/`email`/`sys`); preview panel; raw-research `<details>`; three buttons
- `/runs` list page (paginated): recent runs scoped to current user (admin sees all); each row links to `/runs/:id`
- Jobs list (from plan 2) row adds "latest run" link → `/runs/<latestRunId>`

**Out**
- Live cost/token display (plan 8), error formatting (plan 8), diff-against-previous-run (not v1)

## Tasks

1. SSE endpoint at `packages/web/app/api/runs/[id]/logs/stream/route.ts`:
   - Verify ownership; return 404 if mismatch
   - Use Next.js route handler with `ReadableStream` + `Response(stream, { headers: { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'X-Accel-Buffering':'no' } })`
   - On connect: emit all existing `run_logs` for this run, ordered by `ts ASC`; track `lastSeenId`
   - Every 1000ms: poll `prisma.runLog.findMany({where:{runId, id:{gt: lastSeenId}}, orderBy:{id:'asc'}})`; emit each; update `lastSeenId`
   - Every 1000ms: poll `runs.status`; emit `event: status` on transitions
   - Close on `req.signal.aborted`
2. Worker: `pipeline.ts` sends a status transition each time the run flips between stages — but since we no longer have intermediate statuses, just rely on the one transition `queued → running → success|failed|deferred`. The SSE status poll catches them.
3. `/runs/[id]/page.tsx`:
   - Server component: fetch run + job; check ownership; render header
   - Client subcomponent: `EventSource('/api/runs/:id/logs/stream')`; group incoming lines by `stage`; collapsible sections via `<details>`; auto-scroll to latest unless user scrolled up
   - Preview panel:
     - `output_format === 'html'` → `<iframe srcdoc={renderedOutput} sandbox="" style="width:100%; height:60vh; border:1px solid #ddd">` — no `allow-same-origin`, no `allow-scripts`. Zero JS execution, styles work via inlined CSS
     - `markdown` → render client-side via `marked` into a `<div>`
     - `json` → `<pre>{renderedOutput}</pre>`
   - Raw research: `<details><summary>Raw research JSON</summary><pre>{JSON.stringify(run.researchRaw, null, 2)}</pre></details>` — collapsed by default
   - Action buttons: Resend / Re-run Stage 2 / Re-run Full. Disabled during in-flight fetch
4. `rerun-stage2` handler:
   - Load old run; 409 if `researchRaw` is null
   - Create a new runs row: `{jobId: old.jobId, status: 'queued', researchRaw: old.researchRaw, skipResearch: true}` — add a boolean column `skipResearch` in the Run model (migration in this plan; or hide it as a run-level flag via a jsonb `meta` column if schema churn is unwelcome — go with a dedicated bool)
   - Returns `{runId}`
5. Worker poll loop branch: if `run.skipResearch && run.researchRaw`, skip Stage 1 and start from Stage 2 with the copied `researchRaw`
6. `rerun-full` handler: same path as plan 2's `POST /api/jobs/:id/run` — insert queued run, worker picks it up
7. `resend` handler:
   - Load run; require `renderedOutput` present (else 409)
   - Call `email.ts` with `{parsed: JSON.parse(stage2Json), rendered: renderedOutput, format, recipient}` — same transport as plan 5
   - `streamLogToDb(runId, 'sys', 'resent by user')`
8. `/runs` list page — simple paginated table; reuse the same row template as jobs-list "latest run" cell
9. Navigation: job editor (plan 2) gets a "Latest run" link next to Save if runs exist

## Acceptance criteria

- [x] Opening `/runs/<id>` during an in-flight run shows log lines arriving within ~1s of worker emitting them
- [x] Stages visually grouped; collapsing a stage hides its logs
- [x] HTML preview renders in a **fully sandboxed** iframe (no `allow-same-origin`, no `allow-scripts`); inspecting the iframe shows origin `null`
- [x] Raw research JSON panel collapsed by default; expanded shows valid JSON
- [x] **Resend** button re-sends the same email without creating a new run; inbox receives duplicate; `sys` log "resent by user" appears
- [x] **Re-run Stage 2** creates a new run with `researchRaw` copied; its logs have no `research`-stage entries — only `summary`/`email`/`sys`; finishes faster than a full run
- [x] **Re-run full** creates a new run going through all stages
- [x] Non-owner (user A hitting user B's run) → 404 on all run endpoints (list, detail, SSE, resend, rerun-*)
- [x] Failed run → status badge prominent in header; error string displayed below

## Verification

```bash
BASE=http://localhost:3100

# Trigger a run; open the detail page in a browser and watch live
RUN=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs/$ID/run | jq -r .runId)
echo "Open: $BASE/runs/$RUN"

# CLI SSE tail
curl -N -b /tmp/cj $BASE/api/runs/$RUN/logs/stream | head -50

# Re-run Stage 2
RUN2=$(curl -s -b /tmp/cj -X POST $BASE/api/runs/$RUN/rerun-stage2 | jq -r .runId)
# After completion:
docker compose -p re-news exec db psql -U newsletter -d newsletter -c \
  "select stage, count(*) from run_logs where run_id='$RUN2' group by stage"
# Expect: summary N, email N, sys N; research 0

# Resend
curl -s -b /tmp/cj -X POST $BASE/api/runs/$RUN/resend
# Inbox: manual

# Ownership: alice cannot read admin's run
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/cj-alice $BASE/api/runs/$RUN  # 404
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/cj-alice $BASE/api/runs/$RUN/logs/stream  # 404
```

## Notes

- Shipped as specified. `skipResearch` column already existed in the schema (added ahead of time), so no migration was needed in this plan.
- Resend is implemented in the **web** handler via a local `packages/web/src/lib/mailer.ts` (Nodemailer), not by signaling the worker. This added `nodemailer` + `marked` (for markdown preview) + `@types/nodemailer` as `packages/web` deps.
- SSE route uses `runtime='nodejs'`; polling cadence 1s on both `run_logs` (id-gt lastSeenId) and `runs.status`. Terminal-status transitions trigger a client `router.refresh()` so server-rendered artifacts (`researchRaw`, `stage2Json`, `renderedOutput`) re-hydrate without a manual reload.
- A new integration test (`skipResearch reuses researchRaw and emits no research-stage logs`) covers the plan-6 worker branch — 22 tests now pass.

## Original gotchas

- **SSE by polling**: 1s poll on `run_logs` is fine at family scale. At most 1–2 active tabs × <10 lines/s = trivial
- **`sandbox=""` not `allow-same-origin`**: `srcdoc` + empty sandbox puts the iframe in a unique opaque origin. Rendered HTML + inline CSS still work; no JS execution (we don't emit any anyway). Safer default than the earlier draft's allow-same-origin
- **`skipResearch` column**: simpler than a polymorphic BullMQ payload; worker reads the flag off the run row. Migration included in this plan
- **rerun-stage2 preserves the old run untouched** (creates a new row). Better UX than mutating — history is preserved
- **Resend uses the same email transport** as plan 5. If user edits the job's `recipientEmail` after the original send, resend goes to the current value (intentional)
- **Next.js SSE caveats**: set `Cache-Control: no-cache` and `X-Accel-Buffering: no` or the response may be buffered by any proxy in front
