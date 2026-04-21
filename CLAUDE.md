# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Plans 1–5 landed. The 3-service compose stack boots (`web`, `worker`, `db`), Prisma schema is migrated, session-based auth + full jobs CRUD ship against a per-user ownership model, and the worker embeds node-cron scheduling + a 5s queued-run poll with heartbeat + stale-run recovery. Stage 1 (research) runs through the Claude Agent SDK with tools enabled: `runResearch` streams SDK messages into `run_logs`, reads `research.json`, applies defense-in-depth truncation (≤25 items, ≤800 chars each), and persists the parsed payload to `runs.researchRaw`. **Stage 2 chains after Stage 1**: a cheap tool-less SDK call emits strict JSON validated by zod + `validateLengths` with one retry; the parsed object persists to `runs.stage2Json`, the job's `outputFormat` is rendered (markdown / `marked+juice` HTML / pretty JSON) into `runs.renderedOutput`, Gmail SMTP (Nodemailer, admin-configured) sends the newsletter, then status flips `running → success` with `finishedAt` + `job.lastRunAt` bumped. Admin-only `/settings` manages shared sender creds + default models; `GET /api/settings` masks the app password as `"***"`, `PUT` treats empty / `"***"` as "no change". Next: plan 6 (run detail UI).

**The implementation plans in `plans/` are the authoritative source of truth** — start with `plans/README.md` (index + Decisions Log), then read the relevant plan file. `plans/spec.md` is the original product spec; it has been kept in sync with locked decisions but the 8 plan files are where actionable implementation detail lives.

**Build order**: 8 sequenced plans in `plans/` (01-skeleton → 08-deploy-polish). Each plan has Goal, Dependencies, Scope, Tasks, Acceptance Criteria, and a Verification block with shell commands. Work them in order. Completed: 1, 2, 3, 4, 5. Next: 6 (run detail UI).

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
- Stage 2 (summarize): `allowedTools: []`, `maxTurns: 1`, cheap model (default `claude-haiku-4-5`). Emits strict JSON matching the schema in `plans/spec.md` §6.
- Always validate Stage 2 output server-side (zod schema + item count + body word count + JSON parse). One retry with a terse "violated a length rule, re-emit strictly tighter" prompt, then fail.
- Persist Stage 1's raw research JSON to `runs.research_raw` so Stage 2 can be re-run cheaply from the UI (plan 6) without re-scraping.

**Run status is a flat enum, not a staged pipeline.**
- `queued | running | success | failed | deferred`. No intermediate `research_done` / `summary_done` — Stage 2 reads `research_raw` from DB if it needs to resume, and crash recovery keys on heartbeat age rather than status.
- `runs` has **separate** columns for stage-2 JSON (`stage2_json jsonb`) and rendered output (`rendered_output text`). One column per lifecycle meaning; don't overload.

**Scheduling & time.**
- Do **not** set `TZ` in Compose — use server local time. Display the resolved timezone on the Settings page.
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

Full column list in `plans/spec.md` §5 and reflected in `prisma/schema.prisma` (once plan 1 lands).

## Commands

- `make up` / `make down` — bring the 3-service stack up/down
- `make migrate` — run `prisma migrate deploy` via the one-shot `migrate` service (never from `web`/`worker` startup — parallel boots race)
- `make logs` / `make psql` / `make shell-web` / `make shell-worker` — the usual
- `pnpm lint` / `pnpm typecheck` / `pnpm test` — root-level quality gates (all three must pass)
- `pnpm lint:fix` — Biome autofixes
- `pnpm --filter @renews/<pkg> <script>` — per-package work (shared, web, worker)
- After changes to `@renews/shared`: `pnpm --filter @renews/shared build` before `pnpm --filter @renews/web build/typecheck` — web consumes the emitted `dist/`
- `make backup` — stub until plan 8

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
