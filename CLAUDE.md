# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Plans 1–8 landed — v1 is feature-complete. The 3-service compose stack boots (`web`, `worker`, `db`), Prisma schema is migrated, session-based auth + full jobs CRUD ship against a per-user ownership model, and the worker embeds node-cron scheduling + a 5s queued-run poll with heartbeat + stale-run recovery. Stage 1 (research) runs through the Claude Agent SDK with tools enabled: `runResearch` streams SDK messages into `run_logs`, reads `research.json`, applies defense-in-depth truncation (≤25 items, ≤800 chars each), and persists the parsed payload to `runs.researchRaw`. **Stage 2 chains after Stage 1**: a cheap tool-less SDK call emits strict JSON validated by zod + `validateLengths` with one retry; the parsed object persists to `runs.stage2Json`, the job's `outputFormat` is rendered (markdown / `marked+juice` HTML / pretty JSON) into `runs.renderedOutput`, Gmail SMTP (Nodemailer, admin-configured) sends the newsletter, then status flips `running → success` with `finishedAt` + `job.lastRunAt` bumped. Admin-only `/settings` manages shared sender creds + default models; `GET /api/settings` masks the app password as `"***"`, `PUT` treats empty / `"***"` as "no change". **Run detail UI** (`/runs` list + `/runs/:id`): SSE log tail (1s polling), stage-grouped collapsible logs, sandboxed iframe preview for HTML, and three actions — **Resend** / **Re-run Stage 2** (new row with `skipResearch=true` + copied `researchRaw`) / **Re-run full**. All run endpoints ownership-gated. **Hardening** (plan 7): rate-limit errors → `deferred` with `nextRunAt=resetAt`, no retry consumed. Generic throws retry up to 2 times with `nextRunAt`-gated backoff (1m, 5m); 3rd failure → `failed` + failure-notice email. Pre-insert gates in `@renews/shared/preflight` handle min-interval skip / monthly-budget defer.

**Plan 8 (deploy + polish)**: GH Actions (`.github/workflows/build-and-push.yml`) builds `ghcr.io/squadrone61/re-news-{web,worker}:{latest,main,sha-<sha>}` on every push to `main`; `docker-compose.prod.yml` overrides `build:` with `!reset null` + `pull_policy: always`; the home server's existing Watchtower (label-scoped) rolls the two labeled services and never touches `renews_db`. Separate `docker-compose.backup.yml` ships a `postgres:16-alpine` one-shot via `profiles: [backup]` that `pg_dump`s to `./data/backups/YYYY-MM-DD.sql.gz` and prunes >14d (`make backup`; host crontab drives the schedule). Worker registers a fixed daily cron `0 3 * * *` that removes `/app/data/runs/<id>` for runs with `finishedAt < now - 30d` (DB rows + `renderedOutput` retained). Worker writes `/app/data/account_info.json` on boot + every 5 min; `web` bind-mounts `./data:/app/data:ro` so `/settings` displays plan/tier/refresh time ("auth unknown" if missing, "stale" if >10 min old). Job editor debounces 300 ms on schedule change and calls `GET /api/jobs/cron-preview?schedule=...&excludeId=...` → `{ next5, collisions }`; UI suggests `:03`/`:17`/`:37` offsets when another enabled job's next fire lands on the same UTC minute within 60 min. Run detail shows `tokensIn / tokensOut / costUsd` chips (best-effort SDK usage capture — never throws) and a classified `ErrorDisplay` with icon + hint for `rate_limit:` / `email send:` / `stage2 validation failed` prefixes (raw string under a `<details>` toggle). Settings footer prints the resolved timezone.

**Authoritative docs**: this file for current architecture + non-obvious constraints; [`README.md`](./README.md) for the user-facing "what exists" summary and deploy runbook; [`plans/README.md`](./plans/README.md) for the Decisions Log (non-obvious choices made during build). Individual plan files and the original spec have been removed now that v1 is shipped — the code is the source of truth.

**Build order**: 8 sequenced plans in `plans/` (01-skeleton → 08-deploy-polish). Completed: all 8. v1 is feature-complete; post-v1 work goes in new plans.

## What We're Building

Self-hosted, **family-scale** newsletter agent (3–4 users, ~10 runs/day max). Each user defines "jobs" (sources + topic + prompt + cron schedule + recipient email). On each cron fire, a two-agent pipeline runs: a **research agent** (tools allowed, writes `research.json`) and a **summarizer agent** (no tools, cheap model, strict JSON output). The rendered newsletter is emailed via Gmail SMTP. A web UI manages jobs, runs, and live logs.

**Multi-user app, single shared Claude subscription.** Each user logs into the app and sees only their own jobs/runs. Under the hood, the worker uses a single Claude Pro/Max subscription (admin's) mounted from the host's `~/.claude`. Users never touch Claude credentials — Anthropic's policy against re-offering Claude login is satisfied.

## Architecture (three-service Docker Compose stack)

- `web` — Next.js 14 App Router: UI + API routes + session auth (iron-session)
- `worker` — Long-running node process; embeds `node-cron` for scheduling AND polls the DB every 5s for queued runs. Runs the two-agent pipeline in-process, persists artifacts, sends email. **The only service that loads the Claude Agent SDK.**
- `db` — Postgres 16 (Prisma ORM)

**No Redis. No BullMQ. No separate scheduler service.** At family scale, a DB-backed queue (polling) and in-process cron (node-cron) is simpler than a queue + pubsub stack, and the Postgres is the single source of truth. Manual "Run Now" inserts a `queued` row; the worker picks it up within 5s.

Monorepo layout under `packages/{web,worker,shared}` with Prisma schema at the root. Per-run working dirs live in `data/runs/<runId>/` (bind-mounted into the worker).

## Non-Obvious Constraints (these bite if ignored)

**Authentication uses the Claude Pro/Max subscription, not an API key.**
- The SDK reads credentials from `~/.claude/` on the host. That directory is mounted **read-write** into the worker at `/root/.claude` — the SDK rotates refresh tokens back into it. Mounting `:ro` causes silent token-refresh failures.
- Never set `ANTHROPIC_API_KEY` in `.env`, Compose, or Dockerfiles. Set `CLAUDE_CODE_USE_SUBSCRIPTION=1` on the worker.
- If the worker runs non-root, the mount target must match the container user's home dir, or token refresh fails silently. v1 runs worker as root for this reason.
- Anthropic policy forbids re-offering claude.ai login to other users through the product. We don't — users log into **our** app, not into Claude. The single shared `/root/.claude` is used for all users' runs.

**Node base image must be glibc, not musl.** The Claude Agent SDK ships a native Claude Code binary. `node:20-bookworm-slim` (glibc) is the committed base. `node:20-alpine` has caused silent exec failures in similar setups — don't retry it.

**Rate limits are 5-hour rolling windows, not per-request.**
- Worker concurrency is 1 (enforced by the single-poll-at-a-time design, not a config flag). A rate-limit error from the SDK marks the run `deferred` with `next_run_at = window_reset_time`. Never retry-loop on rate-limit errors — they're distinguished from generic failures in the catch.
- Enforce a per-job `min_interval_minutes` in the worker's pre-run check: if a cron tick fires closer than that to `last_run_at`, skip it (no row, no enqueue).
- Count `runs this month` before inserting a new runs row; if ≥ `monthly_budget`, insert with status `deferred` + error "monthly budget exceeded" and don't start the pipeline.

**The two-agent split is load-bearing.**
- Stage 1 (research): `allowedTools: ["WebFetch", "WebSearch", "Bash", "Read", "Write"]`, `permissionMode: "acceptEdits"`, larger model (default `claude-sonnet-4-6`), `maxTurns: 40`. Must cap output at 25 items × 800 chars each — enforced in the prompt so Stage 2 never OOMs context. A post-parse defense-in-depth truncation applies the same caps in code.
- Stage 2 (summarize): `allowedTools: []`, `maxTurns: 1`, cheap model (default `claude-haiku-4-5`). Emits strict JSON matching `StageTwoSchema` in `packages/shared/src/schemas.ts`.
- Always validate Stage 2 output server-side (zod schema + item count + body word count + JSON parse). One retry with a terse "violated a length rule, re-emit strictly tighter" prompt, then fail.
- Persist Stage 1's raw research JSON to `runs.research_raw` so Stage 2 can be re-run cheaply from the UI (plan 6) without re-scraping.

**Run status is a flat enum, not a staged pipeline.**
- `queued | running | success | failed | deferred`. No intermediate `research_done` / `summary_done` — Stage 2 reads `research_raw` from DB if it needs to resume, and crash recovery keys on heartbeat age rather than status.
- `runs` has **separate** columns for stage-2 JSON (`stage2_json jsonb`) and rendered output (`rendered_output text`). One column per lifecycle meaning; don't overload.

**Scheduling & time.**
- Do **not** set `TZ` env in Compose — mount `/etc/localtime:/etc/localtime:ro` + `/etc/timezone:/etc/timezone:ro` into `web` and `worker` so they inherit the host's zone. Node base images default to UTC; without this mount `0 8 * * *` fires at 08:00 UTC, not 08:00 wall-clock, and the cron-preview UI shows times that look off by the host's UTC offset. `db` does **not** need the mount (Postgres stores timestamps with explicit offset). Settings page prints the resolved zone.
- Job editor warns when a new schedule collides at the same minute as an existing enabled job; suggests `:03`/`:17`/`:37` staggering (plan 8).

**Stale-run recovery.**
- Worker updates `runs.heartbeat_at` every 30s during execution. On worker boot, any `running` run with heartbeat older than 5 min (or NULL — covers crash-before-first-heartbeat) gets reset to `queued` with `started_at` cleared. The pipeline is idempotent: Stage 1 recomputes, Stage 2 is a pure transform over `research_raw`.
- If the worker crashes mid-email, resend on recovery duplicates. Accepted for v1 — better than a dropped send.

**Worker scheduling + poll internals (plan 3).**
- `node-cron` v4: `ScheduledTask.stop()` and `.destroy()` are both async. Registry awaits both on unregister and on shutdown; skipping the awaits leaks open handles on reconcile churn.
- Reconcile runs every 60s (and on boot). A schedule-string change = unregister + register; no hot-swap needed.
- Poll loop uses an in-flight flag so overlapping 5s ticks can't stack while a run is executing. Combined with an atomic `updateMany({where:{id, status:'queued'}, data:{status:'running', ...}})` this gives exactly-once semantics with a single worker; the atomic claim is still correct if we ever run concurrent workers.
- `onFire` re-reads the job from DB before inserting a run — handles the race where user disables between cron firing and the insert.

**Research stage internals (plan 4).**
- `@anthropic-ai/claude-agent-sdk` is imported **only** from `packages/worker` — never from `web` or `shared`. The SDK bundles a native Claude Code binary; wiring it into the edge-bundled web build is pointless and risks a bundler trying to statically resolve it.
- Per-run cwd is `${RUNS_DIR}/<runId>` — defaults to `/app/data/runs` in the container, overrideable via `RUNS_DIR` for tests (Testcontainers suite uses a tmpdir). The SDK writes `research.json` there; `runResearch` reads it back.
- Worker Dockerfile installs `git` and `curl` alongside `openssl`/`ca-certificates` — the SDK's Bash tool uses curl for RSS fetching and git for its own housekeeping.
- `streamLogToDb` accepts either a raw string or an SDK message object. For SDK messages it emits one row per content block: `assistant` text → `info`, `tool_use` → `"tool: name(args)"` (args truncated to 200 chars), `tool_result` in a `user` message → `"result: ..."` (truncated to 200 chars), `is_error` flips level to `error`, `result` messages with `is_error: true` log the subtype + errors. `system`/partial-assistant/status messages are intentionally skipped — too noisy. Full research JSON is **never** logged (already in `runs.researchRaw`); only the `sys` summary `research_done: N items, M fetch_errors` goes through.
- Lookback window for the research prompt is derived from the job's cron cadence via `lookbackFromSchedule` in `@renews/shared`: ≥7d → "last 7 days", ≥24h → "last 24 hours", ≥1h → "last 6 hours", else "recent".
- `poll.execute` loads the run with `include: { job: true }` before calling `runResearch`. Don't refactor this to pass the job around earlier — the single DB read after claim is fine, and it guarantees the latest job state (e.g. if user edited `modelResearch` between enqueue and pickup).

**Summary / render / email internals (plan 5).**
- `summarize.ts` calls the SDK with `allowedTools: []`, `permissionMode: 'default'`, `maxTurns: 1`, `model: job.modelSummary`. It concatenates assistant text, runs `extractJson` (strips optional ```` ``` ```` / ```` ```json ```` fences, falls back to the outermost `{…}` substring), then `JSON.parse` → `StageTwoSchema.parse` → `validateLengths`. Any throw triggers a single retry with `buildRetryPrompt()`; second throw → `stage2 validation failed after retry: <reason>`.
- `validateLengths` enforces `items.length ≤ job.maxItems`, `subject ≤ 70 chars`, and `body ≤ 50 words` per item. Tighter than the prompt's 45-word cap — gives the model headroom while still catching rogue output.
- Persistence order in `poll.execute`: research → stage2Json → renderedOutput → email → status=success + finishedAt + job.lastRunAt. Rendered output is written **before** email, so a later email failure still leaves the artifact for plan 6's resend.
- Email format dispatch: `outputFormat === 'html'` → `sendMail({ html: rendered, text: stripHtml(rendered) })`. `markdown` / `json` → `text` only. `juice(marked(md))` inlines the base CSS (Gmail strips `<style>` blocks).
- Email failures (SMTP-level) rethrow as `"email send: <reason>"`; the outer `poll.execute` catch turns that into `status='failed'` with the error string.
- `pipeline/email.ts` reads the singleton `Setting` row and throws `"email settings incomplete"` if any of `gmailUser`, `gmailAppPassword`, `senderName` are missing — prevents a silent "ok, message id=undefined" with unconfigured creds.

**Settings API semantics (plan 5).**
- `GET /api/settings` upserts the singleton row (so first GET creates it) and returns `gmailAppPassword: "***"` when set, `""` when unset. Admin-only (403 otherwise).
- `PUT /api/settings` accepts partial input via `SettingsInput` (strict zod object). Empty strings for `gmailUser` / `senderName` write `null` (clearing is allowed); empty string, literal `"***"`, or `undefined` for `gmailAppPassword` means **no change** — only a new non-empty non-mask string writes it. This prevents accidental wipe on a GET → form-submit round-trip.
- `@renews/shared/auth` is *not* needed here; the route uses `requireAdmin` from `packages/web/src/lib/session.ts` which only pulls argon2 transitively through the CRUD path, not this handler.

**Job form defaults come from Settings.**
- `/jobs/new` is a server component that reads the `Setting` row and passes `{ modelResearch, modelSummary }` defaults into `JobForm`. If Settings is absent, hardcoded fallbacks (`claude-sonnet-4-6` / `claude-haiku-4-5`) apply. Edit page passes `initial` so existing values win — only new-job defaults are driven by Settings.

**Run detail UI internals (plan 6).**
- `/api/runs/:id/logs/stream` uses `runtime = 'nodejs'` (not edge) — iron-session + Prisma + long-lived streams aren't edge-safe. It verifies ownership, opens a `ReadableStream`, flushes all existing `run_logs` by `id ASC`, then polls every 1000ms with `where: { runId, id: { gt: lastSeenId } }` and a separate `runs.status` read to emit `event: status` on transitions. Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. Closes on `req.signal` abort.
- `RunLog.id` is a `BigInt`; the SSE handler tracks `lastSeenId` as a `bigint` and serializes via `.toString()` on the wire. Don't compare to `Number` — on a long-running run the id will eventually cross 2^53.
- `skipResearch` branch in `poll.execute`: if `run.skipResearch && run.researchRaw`, it skips `runResearch()` entirely, casts `researchRaw` to `ResearchJson`, and logs a `sys` line `skipping research (rerun-stage2): reusing researchRaw`. Stage 2 then runs normally against the reused payload. No `research`-stage logs appear on a rerun-stage2 run — the test asserts this.
- **Resend sends from web, not worker.** `POST /api/runs/:id/resend` invokes `packages/web/src/lib/mailer.ts` (a small Nodemailer wrapper that reads the `Setting` singleton) directly. It does *not* enqueue a run, does not create a new row — logs a single `sys` line under the original run. Nodemailer is therefore a `web` dependency now. If an admin rotates Gmail creds, resend picks them up on the next call (no transport caching).
- **Re-run Stage 2** creates a *new* `runs` row with `skipResearch=true` and `researchRaw` copied from the old row. Plan 6 doesn't mutate the old run — history preserved. The new row goes through the normal poll path; the skip happens in `poll.execute`.
- HTML preview iframe uses `sandbox=""` (empty — no `allow-same-origin`, no `allow-scripts`) and `srcDoc={renderedOutput}`. Inlined CSS (juice) still renders; no JS executes. Never add `allow-same-origin` — it would let newsletter HTML read the parent's cookies.
- Markdown preview uses `marked.parse(md, { async: false })` client-side into a `dangerouslySetInnerHTML` div. Acceptable because (a) the markdown is produced by our own Stage 2 pipeline against validated JSON, (b) the same `marked` produces the HTML already emailed in HTML mode. If Stage 2 output ever becomes untrusted, swap for a sanitizer.
- Client `EventSource` auto-reconnects on network drops. We don't dedupe by id on reconnect — on the reconnect the server's initial-flush rebuilds the full log list, and React re-renders from scratch because the effect closure re-captures `logs=[]`. If a future refactor reconnects *without* tearing down the component, add a `Set<string>` of seen ids to avoid duplicates.
- On terminal-status transition (`success|failed|deferred`), the client calls `router.refresh()` to re-hydrate server-rendered fields (`researchRaw`, `stage2Json`, `renderedOutput`) that were null at first paint. The SSE stream keeps running; the server component re-runs.

**Hardening internals (plan 7).**
- `pipeline/errors.ts` owns `RateLimitError { resetAt: Date }` and `detectRateLimit(err)`. `runResearch` raises `RateLimitError` synchronously when `SIM_RATE_LIMIT=1` (test hook; 3600s reset), and wraps the SDK `query()` iteration in a try/catch that runs every thrown error through `detectRateLimit` before rethrowing — so an SDK-surfaced 429 becomes a `RateLimitError` instead of a generic failure. Detection patterns: `/rate[_\s-]?limit/i`, `/\b429\b/`, `/too many requests/i`, `/quota exceeded/i`. Reset-time parsing tries (in order) `err.resetAt`, `err.headers['retry-after']`, an ISO timestamp in the message, and finally a 5-hour fallback (matches Anthropic's window).
- `poll.handleFailure` is the single catch site. Rate-limit → `status='deferred'`, `nextRunAt=resetAt`, `error=<msg>`, **no attempt bump**. Generic throw + `attempt < 2` → `status='queued'`, `startedAt=null`, `heartbeatAt=null`, `nextRunAt=now+backoff`, `attempt++`. Generic throw + `attempt >= 2` → `status='failed'` then `sendFailureNotice(runId)`. Don't add a retry branch to `RateLimitError` — by design the poll loop won't re-pick the row until `nextRunAt` passes, which is what "window resets" means.
- **`tick()` filters on `nextRunAt`**: `where: { status: 'queued', OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] }`. This is how backoff delays work — a requeued run with `nextRunAt=now+60s` is invisible to `findFirst` until the minute elapses. Don't bypass this filter in a future "eager retry" feature; it's the only gate.
- `@renews/shared/preflight` exposes `preflightJob(job, now)` → `{ kind: 'ok' | 'skip' | 'defer', reason? }`. Used from `onFire` AND `POST /api/jobs/:id/run` — keep the check identical across both paths. Skip = no row. Defer = insert a row with `status='deferred'`, `error=reason`, `finishedAt=now` (no pipeline runs). Monthly-budget count uses `createdAt >= startOfMonthLocal(now)` — server local time (cron and budget share the same month boundary). On preflight skip, `onFire` still advances `nextRunAt` via `nextFireAt(schedule)` so the job doesn't get stuck on a stale projection; `lastRunAt` is *not* touched (prevents the skip from resetting the interval clock).
- **Rerun endpoints (plan 6) intentionally bypass preflight.** Operator-initiated reruns shouldn't be blocked by min interval or budget — they're explicit overrides via the UI. Don't add preflight to `/api/runs/:id/rerun-full` or `/rerun-stage2`.
- `sendFailureNotice` re-reads the `Setting` singleton on every send (no transport cache) so rotated Gmail creds take effect immediately. It never throws — any error is logged and swallowed (a `sys` warn line if the DB is still reachable). Plan-7 requirement: the failure path must never recurse.
- **Why `attempt` is stored (not just a per-process counter):** the worker might crash between failures. On restart, `staleRecovery` resets a stale `running` row to `queued` — but the poll then sees the existing `attempt` value and resumes the retry budget where it left off. A process-local counter would silently rewind.
- The retry path bumps `attempt` **on requeue**, not on claim, so `attempt` is always the 0-indexed count of *completed* attempts so far. `attempt=2` on the row means two prior failures; the next failure terminates.

**Deploy + polish internals (plan 8).**
- **Prod compose overlay**: `docker-compose.prod.yml` sets `build: !reset null` + `image: ghcr.io/squadrone61/re-news-<svc>:latest` + `pull_policy: always`. Use `docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml pull && up -d`. Rollback = temporarily pin to `:sha-<oldsha>` in that overlay. Don't add `:latest` to `db` — that image lives at `postgres:16-alpine`, pinned.
- **Watchtower is shared with the host's other stacks.** Label-scoped mode (`WATCHTOWER_LABEL_ENABLE=true`) is the requirement; only `renews_web` + `renews_worker` carry the `com.centurylinklabs.watchtower.enable=true` label. `renews_db` is intentionally unlabeled — never auto-update a data service. Before first deploy, verify `WATCHTOWER_LABEL_ENABLE` on the running Watchtower container; if unset, Watchtower is watching **everything** and flipping the env var requires re-labeling whatever else was being watched. README covers both paths.
- **Backup is a profile, not a permanent service.** `docker-compose.backup.yml` declares `profiles: [backup]`, so `make up` never starts it. `make backup` (or host crontab) calls `docker compose … run --rm backup`. The entrypoint uses `$$(date +%F)` + `find -mtime +14 -delete` inline — keep the script in the compose file, not a separate shell file. Restore is manual (`gunzip -c … | psql …`).
- **`./data` is mounted RO into `web`, RW into `worker`.** The worker writes `account_info.json` + `runs/<id>/`; the web only reads. Never change web's mount to RW — the web container is the one that ships behind the HTTP surface, and a path-traversal bug in a future handler should not be able to touch per-run artifacts. If a web feature genuinely needs to write to `./data`, add a narrow API the worker owns instead.
- **`account_info.json` capture is best-effort + probes export names.** `accountInfo.ts` walks a short allowlist (`getAccountInfo` / `accountInfo` / `AccountInfo`) against `@anthropic-ai/claude-agent-sdk` and writes whatever fields it finds — plus `refreshedAt` always. Empty capture is still a valid file; only a missing file or `mtime > 10 min` becomes a UI warning. Don't harden this probe into a hard dependency on one export name; the SDK's shape has changed.
- **Token/cost capture never throws.** `pipeline/usage.ts` scans each SDK message for `usage` / `model_usage` / `message.usage` + cost fields (`total_cost_usd` / `cost_usd` / `total_cost`); unknown shapes contribute 0. Cache-creation and cache-read input tokens fold into `tokensIn`. Accumulator is passed by reference into `runResearch(runId, job, usage)` and `runSummary(runId, job, research, usage)`; `persistUsage` runs **before** the final status flip to `success`. Don't persist on failure paths — incomplete totals are misleading.
- **Cleanup cron retention is fixed.** `0 3 * * *` server local time, 30 days against `runs.finished_at`. Deletes `/app/data/runs/<runId>` only — DB rows + `renderedOutput` stay. Runs without `finishedAt` are ineligible (still-queued or crashed-before-first-heartbeat rows are not touched). If a user ever needs a different retention, expose it as a Settings field, not a per-job toggle.
- **Cron preview self-exclusion is mandatory when editing.** Passing `excludeId=<jobId>` on the edit page prevents a job from colliding with itself (its own `nextFireAt` would otherwise always match). New-job page omits the param. The 60-min window on collision detection keeps the warning relevant — stale "collision 3 weeks out" hints would train users to ignore the warning.
- **`/api/jobs/cron-preview` is `runtime: 'nodejs'`.** Uses `@renews/shared` (Prisma) + `cron-parser` under the shared package. Keep it out of edge to match the rest of the API surface.
- **`ErrorDisplay` classifies on message prefix.** `rate_limit:` (or any of the detection patterns) → reset-time hint sourced from `run.nextRunAt`; `email send:` → Settings pointer; `stage2 validation failed` → tightening advice. Unknown prefix → raw message under a generic "Run failed" header. The raw string is always available via a `<details>` toggle — never hide it entirely, since future errors won't match a prefix.
- **GHCR packages must be public** (set once per package in GitHub → Packages → Visibility) so Watchtower pulls anonymously. If set to private, Watchtower needs a PAT on the server — avoid that.
- **Always run `make migrate` before a release with a new migration.** Watchtower rolling `web` and `worker` before the schema is in place will crash-loop. Migrations are deliberately **not** in the worker/web CMD to avoid races.

**Email delivery uses Gmail SMTP via Nodemailer** (shared admin-owned sender, not Resend).
- Admin configures one Gmail account + app password in `/settings`. All users' newsletters send from that address; each job has its own `recipient_email`.
- Why not Resend: Resend (and every reputable provider) refuses free-email sender domains. We don't own a verified domain. Gmail SMTP caps at ~500/day/account (plenty) and egresses via Google, not the home IP, so deliverability holds.
- Settings GET masks the app password; Settings PUT treats empty `gmail_app_password` as "no change" (never accidentally wipe).

**Password hashing uses `@node-rs/argon2`, a native module — do NOT import it from the edge middleware.**
- `packages/shared`'s root entry (`@renews/shared`) is edge-safe: Prisma client + zod schemas + cron helpers. argon2 is exposed via the `@renews/shared/auth` subpath only. API route handlers import `hashPassword`/`verifyPassword` from the subpath; the middleware and edge-bundled code never do.
- `packages/web/next.config.mjs` also declares `@node-rs/argon2` as a webpack `externals` (server build) so Next doesn't try to statically resolve the platform-specific `.node` binary through pnpm's symlinked layout. It's also listed in `experimental.serverComponentsExternalPackages` alongside `@prisma/client`.
- iron-session cookie options live in `packages/web/src/lib/session-config.ts` (edge-safe, no Prisma); `getCurrentUser`/`requireAdmin` and the Node session helpers live in `packages/web/src/lib/session.ts`. Middleware imports only the config file.
- The edge middleware can't hit the DB, so it can't answer "are there any users?" for the `/setup` gate. `/login` and `/setup` are public; the `/login` page does a client-side fetch to `/api/setup-status` and redirects to `/setup` if the DB is empty.
- Middleware returns 401 JSON for unauthenticated `/api/*` requests and 307 → `/login?redirect=<path>` for pages. Preserve this split — a 307 on an API call confuses fetch consumers.

**Playwright MCP is deferred to v1.1.**
- `sources[].needs_browser` is persisted but the v1 worker instructs the research agent to skip such sources with a `fetch_errors` entry; does not fail the run.

**Deploy uses the home server's existing Watchtower — do not install a second one.**
- GH Actions on push to `main` builds **2 images** and pushes to GHCR (`ghcr.io/squadrone61/re-news-{web,worker}:latest` + `:main` + `:sha-<shortsha>`).
- Only our app services (`web`, `worker`) carry the label `com.centurylinklabs.watchtower.enable=true`. **`db` gets no label** — never auto-update data services.
- Existing Watchtower must run in label-scoped mode (`WATCHTOWER_LABEL_ENABLE=true` or `--label-enable`). Verify before flipping; if not set, use plan 8's Option A (re-label currently-watched containers explicitly, then enable label-scoped mode).
- Migrations don't run automatically on container start (would race on parallel boots). Always run `make migrate` explicitly before a release carrying a new migration.
- Isolation from the host's other containers: compose project name `re-news`, container names `renews_*`, dedicated bridge network `renews_net`, no `network_mode: host`, no bind mounts outside the project dir, per-service `mem_limit`/`cpus` set, web on port 3100 (not 3000, which is commonly taken).
- Backups: nightly `pg_dump` via host crontab → `./data/backups/` (plan 8). Postgres volume is on host; disk death loses everything without this.

## Data Model Cheat Sheet

Five tables:
- `users` — multi-user app auth. Columns: `id`, `email` (unique), `password_hash` (argon2id via `@node-rs/argon2`), `is_admin`, `created_at`, `updated_at`.
- `jobs` — config. Per spec §5, plus `user_id` FK (`onDelete: Cascade`) and `min_interval_minutes` (nullable).
- `runs` — one per pipeline execution. Statuses: `queued | running | success | failed | deferred`. Artifacts split into `research_raw jsonb`, `stage2_json jsonb`, `rendered_output text`. Plus `heartbeat_at`, `next_run_at`, `attempt` (retry counter), `skip_research` (plan 6's rerun-stage2 flag).
- `run_logs` — streamed from SDK messages, keyed by `run_id` + `stage` where stage is `research | summary | email | sys`.
- `settings` — singleton row for admin-configured shared state: `gmail_user`, `gmail_app_password`, `sender_name`, `default_model_research`, `default_model_summary`, `worker_concurrency` (informational in v1).

Full column list in `prisma/schema.prisma`.

## Commands

- `make up` / `make down` — bring the 3-service stack up/down
- `make migrate` — run `prisma migrate deploy` via the one-shot `migrate` service (never from `web`/`worker` startup — parallel boots race)
- `make logs` / `make psql` / `make shell-web` / `make shell-worker` — the usual
- `make backup` — one-shot `pg_dump` to `./data/backups/YYYY-MM-DD.sql.gz`; prunes files >14 days in the same run. Wrap with a host crontab entry for nightly execution.
- `pnpm lint` / `pnpm typecheck` / `pnpm test` — root-level quality gates (all three must pass)
- `pnpm lint:fix` — Biome autofixes
- `pnpm --filter @renews/<pkg> <script>` — per-package work (shared, web, worker)
- After changes to `@renews/shared`: `pnpm --filter @renews/shared build` before `pnpm --filter @renews/web build/typecheck` — web consumes the emitted `dist/`
- Prod deploy: `docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml pull && up -d` (Watchtower automates this on `:latest` changes after first deploy)

## When Implementing

- TypeScript across all packages. Strict mode, `NodeNext`, `ES2022`.
- Dev/test happens on the Linux home server (user preference — no local Docker Desktop). The other Claude Code instance running there can help iterate.
- Plan 1 includes `docker-compose.migrate.yml` as a one-shot migration service (invoked via `make migrate`). Don't bake migrations into the worker/web CMD — parallel boots race.
- The `shared` package owns the Prisma client (singleton), `getCurrentUser` + session helpers, `streamLogToDb(runId, stage, msg, level?)`, zod schemas, cron helpers, and cross-service types. Don't duplicate types in `web`/`worker`.
- SDK streaming: iterate `for await (const msg of query({...}))` and pipe messages into `run_logs` as you go so the UI's live tail works.
- Web UI live log tail uses SSE (route handler + `ReadableStream`) backed by 1s polling on `run_logs` — LISTEN/NOTIFY is not worth the complexity at this scale.
- Auth ships in **plan 2**, not later — session cookies (iron-session) + `/setup` first-run flow + `/admin/users`. Don't write handlers against a stub.
- Sandboxed iframe for HTML newsletter preview: `sandbox=""` (empty, no flags). Srcdoc content renders with opaque origin; no JS, no parent access. Don't add `allow-same-origin`.
- `.env` must define `SESSION_PASSWORD` (≥32 chars for iron-session), `DB_PASSWORD`, and — once plan 5 lands — Gmail creds via the Settings UI, not env.

## After every plan (RULE)

When a plan is complete — acceptance criteria verified, code committed — immediately update the docs in a follow-up commit before starting the next plan. Don't batch this across multiple plans.

- `CLAUDE.md` (this file):
  - "Project Status" paragraph: bump which plans have landed and what the next one is
  - Add any new non-obvious constraints the plan exposed (mount quirks, bundling workarounds, packaging splits, unexpected runtime behaviors) — the kind of gotcha a future session would waste an hour rediscovering
  - Update "Commands" if the plan added or changed any
- `plans/README.md` Decisions Log: record any choice made during execution that deviated from or filled a gap in the plan, so later plans don't relitigate it
- `plans/NN-<plan>.md`: tick the acceptance-criteria checkboxes; add a short "Notes" line if the shipped behavior differs from what the plan originally described

Keep these updates surgical — not a changelog, not a retrospective. The point is that the next Claude session (or the next plan) can read these files and make correct decisions without re-deriving them.
