# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Greenfield. The repo currently contains `CLAUDE.md`, `.gitignore`, and `plans/` (gitignored). No scaffolding, package.json, or services exist yet. **The implementation plans in `plans/` are the authoritative source of truth** — start with `plans/README.md` (index + Decisions Log), then read the relevant plan file. `plans/spec.md` is the original product spec; it has been kept in sync with locked decisions but the 8 plan files are where actionable implementation detail lives.

**Build order**: 8 sequenced plans in `plans/` (01-skeleton → 08-deploy-polish). Each plan has Goal, Dependencies, Scope, Tasks, Acceptance Criteria, and a Verification block with shell commands. Work them in order.

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
- Worker updates `runs.heartbeat_at` every 30s during execution. On worker boot, any `running` run with heartbeat older than 5 min gets reset to `queued`. The pipeline is idempotent: Stage 1 recomputes, Stage 2 is a pure transform over `research_raw`.
- If the worker crashes mid-email, resend on recovery duplicates. Accepted for v1 — better than a dropped send.

**Email delivery uses Gmail SMTP via Nodemailer** (shared admin-owned sender, not Resend).
- Admin configures one Gmail account + app password in `/settings`. All users' newsletters send from that address; each job has its own `recipient_email`.
- Why not Resend: Resend (and every reputable provider) refuses free-email sender domains. We don't own a verified domain. Gmail SMTP caps at ~500/day/account (plenty) and egresses via Google, not the home IP, so deliverability holds.
- Settings GET masks the app password; Settings PUT treats empty `gmail_app_password` as "no change" (never accidentally wipe).

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

None established yet — `package.json`, `docker-compose.yml`, and Prisma schema do not exist. Plan 1 ships them. Expected post-scaffolding flow:

- `make up` — bring stack up
- `make down` — bring it down
- `make migrate` — apply pending Prisma migrations via the one-shot `migrate` service
- `make logs` — tail all services
- `make psql` — open psql against the `db` container
- `make shell-web` / `make shell-worker` — exec into a service
- `pnpm lint && pnpm typecheck && pnpm test` — root-level quality gates
- `pnpm --filter <pkg> <script>` — per-package work

Update this file with concrete commands once plan 1 is complete.

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
